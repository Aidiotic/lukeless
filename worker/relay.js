import { DurableObject } from 'cloudflare:workers';

const SITE_ORIGIN = 'https://aidiotic.github.io';

/* How long a seat is held open for a client that dropped. Clients retry for
   roughly six seconds, so this has to outlast that or a brief blip would be
   reported as the opponent leaving. */
const GRACE_MS = 10_000;

function allowedOrigin(request) {
  const origin = request.headers.get('Origin') ?? '';
  return origin === SITE_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/* Wrong keys are not free. Five is far more than a real invite link ever
   needs and far fewer than a guess would take, and a sealed room stays sealed
   so there is no window to grind in. */
const MAX_BAD_KEYS = 5;

const sha256 = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/* Compare every character so the time taken says nothing about how much of
   the key was right. */
const sameSecret = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export class MatchRoom extends DurableObject {
  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const role = new URL(request.url).searchParams.get('role');
    const token = new URL(request.url).searchParams.get('token');
    if (role !== 'host' && role !== 'guest') return new Response('Invalid role', { status: 400 });
    if (!/^[0-9a-f-]{36}$/i.test(token ?? '')) return new Response('Invalid token', { status: 400 });

    /* Invite keys are off by default: joining is back to the room code alone,
       which is the sharing model the game is actually played with — someone
       reads five characters out loud. `wrangler deploy --var REQUIRE_KEY:on`
       turns the check back on, and the client already sends the key either
       way, so nothing else has to change to flip it.
     *
     * With it off, a code is the whole credential: anyone who overhears one
     * can take the free seat. That is a griefing risk, not a foothold — the
     * message validation and role guards in app.js are what stop a peer from
     * doing anything worse than playing badly. */
    if (this.env.REQUIRE_KEY) {
      const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '')
        .split(',').map((s) => s.trim());
      const key = offered[1] ?? '';
      if (!/^[A-Z2-7]{26}$/.test(key)) return this.#rejectedSocket('no-match');

      if (await this.ctx.storage.get('sealed')) return this.#rejectedSocket('no-match');

      const keyHash = await sha256(key);
      const known = await this.ctx.storage.get('keyHash');
      if (known === undefined) {
        // First caller in defines the room. Only a host may do that.
        if (role !== 'host') return this.#rejectedSocket('no-match');
        await this.ctx.storage.put('keyHash', keyHash);
      } else if (!sameSecret(known, keyHash)) {
        /* Deliberately the same answer as a room that does not exist, so this
           cannot be used to discover which codes are live. */
        const bad = ((await this.ctx.storage.get('badKeys')) ?? 0) + 1;
        await this.ctx.storage.put('badKeys', bad);
        if (bad >= MAX_BAD_KEYS) await this.ctx.storage.put('sealed', true);
        return this.#rejectedSocket('no-match');
      }
    }

    const sockets = this.ctx.getWebSockets();
    const roles = sockets.map((socket) => socket.deserializeAttachment()?.role);
    const sameRole = sockets.find((socket) => socket.deserializeAttachment()?.role === role);
    const savedToken = await this.ctx.storage.get(`${role}Token`);
    const reconnecting = savedToken === token;
    if (reconnecting) {
      try { sameRole.close(1012, 'Reconnected'); } catch {}
    }
    if (role === 'host' && sockets.length && !reconnecting) return this.#rejectedSocket('code-used');
    if (role === 'guest' && !roles.includes('host')) return this.#rejectedSocket('no-match');
    if (role === 'guest' && !reconnecting && roles.includes('guest')) {
      return this.#rejectedSocket('match-full');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    await this.ctx.storage.put(`${role}Token`, token);
    server.serializeAttachment({ role, token });
    this.ctx.acceptWebSocket(server, [role]);

    const pairedRoles = this.ctx.getWebSockets().map((socket) => socket.deserializeAttachment()?.role);
    if (pairedRoles.includes('host') && pairedRoles.includes('guest')) {
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(JSON.stringify({ __relay: 'paired' })); } catch {}
      }
    }

    return new Response(null, {
      status: 101, webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'lukeless-v1' },
    });
  }

  #rejectedSocket(reason) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ rejected: true });
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ __relay: reason }));
    server.close(1008, reason);
    return new Response(null, {
      status: 101, webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'lukeless-v1' },
    });
  }

  /* Normal play sends a handful of messages a round. An autoclicker sends as
     many as the browser will emit, and every one of them was forwarded to the
     other player. Held in memory rather than storage: if the object is
     evicted the counter resets, which is fine — this is throttling a stuck
     button, not defending against a determined flood. */
  #rate = new Map();

  #tooChatty(socket) {
    const now = Date.now();
    const seen = this.#rate.get(socket) ?? { since: now, count: 0 };
    if (now - seen.since > 1000) { seen.since = now; seen.count = 0; }
    seen.count++;
    this.#rate.set(socket, seen);
    return seen.count > 25;
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 64_000) return;
    if (this.#tooChatty(socket)) return;
    try {
      const parsed = JSON.parse(message);
      if (parsed?.__relay === 'ping') {
        socket.send(JSON.stringify({ __relay: 'pong' }));
        return;
      }
      if (parsed?.t === 'bye') {
        const role = socket.deserializeAttachment()?.role;
        if (role) await this.ctx.storage.delete(`${role}Token`);
      }
    } catch {}
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== socket) {
        try { peer.send(message); } catch {}
      }
    }
  }

  async webSocketClose(socket, code, reason) {
    const rejected = socket.deserializeAttachment()?.rejected;
    try { socket.close(code === 1005 ? 1000 : code, reason); } catch {}
    if (rejected) return;
    await this.ctx.storage.setAlarm(Date.now() + GRACE_MS);
  }

  async webSocketError(socket) {
    const rejected = socket.deserializeAttachment()?.rejected;
    try { socket.close(1011, 'Relay error'); } catch {}
    if (rejected) return;
    await this.ctx.storage.setAlarm(Date.now() + GRACE_MS);
  }

  /* A socket closing is not the same as a player leaving — that is why raw
     transport loss is not reported as a departure. But something has to
     decide once the reconnect window has passed, and nothing did: a seat that
     was never released kept its token for ever, so an abandoned room left
     storage behind permanently, and the player still sitting there was never
     told the other one was not coming back. Both are the same question asked
     late, so both are answered here. */
  async alarm() {
    const live = this.ctx.getWebSockets().filter((s) => !s.deserializeAttachment()?.rejected);
    const present = new Set(live.map((s) => s.deserializeAttachment()?.role));

    for (const role of ['host', 'guest']) {
      if (present.has(role)) continue;
      if (await this.ctx.storage.get(`${role}Token`) === undefined) continue;
      await this.ctx.storage.delete(`${role}Token`);
      for (const peer of live) {
        try { peer.send(JSON.stringify({ __relay: 'peer-left' })); } catch {}
      }
    }

    if (!live.length) await this.ctx.storage.deleteAll();   // nobody left; keep nothing
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* Security lockdown — the real kill switch for this service.
       config.js's maintenance flag cannot do this job: it is honoured by the
       page, and anyone attacking the relay never loads the page. This is
       deployed state rather than code state, so engaging it is
       `wrangler deploy --var LOCKDOWN:on` and lifting it is a plain deploy;
       neither needs an edit here under pressure. Deploying either way also
       restarts the Durable Objects, which drops every live socket. */
    const locked = !!env.LOCKDOWN;

    if (url.pathname === '/health') return Response.json({ ok: !locked, locked });
    if (locked) return new Response('Locked down for maintenance', { status: 503 });
    if (!allowedOrigin(request)) return new Response('Forbidden', { status: 403 });

    const match = url.pathname.match(/^\/room\/([A-HJ-NP-Z2-9]{5})$/);
    if (!match) return new Response('Not found', { status: 404 });
    return env.MATCH_ROOMS.getByName(match[1]).fetch(request);
  },
};
