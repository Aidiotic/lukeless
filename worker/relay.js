import { DurableObject } from 'cloudflare:workers';

const SITE_ORIGIN = 'https://aidiotic.github.io';

function allowedOrigin(request) {
  const origin = request.headers.get('Origin') ?? '';
  return origin === SITE_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export class MatchRoom extends DurableObject {
  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const role = new URL(request.url).searchParams.get('role');
    const token = new URL(request.url).searchParams.get('token');
    if (role !== 'host' && role !== 'guest') return new Response('Invalid role', { status: 400 });
    if (!/^[0-9a-f-]{36}$/i.test(token ?? '')) return new Response('Invalid token', { status: 400 });

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

    return new Response(null, { status: 101, webSocket: client });
  }

  #rejectedSocket(reason) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ rejected: true });
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ __relay: reason }));
    server.close(1008, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 64_000) return;
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

  webSocketClose(socket, code, reason, wasClean) {
    const rejected = socket.deserializeAttachment()?.rejected;
    socket.close(code === 1005 ? 1000 : code, reason);
    if (rejected) return;
  }

  webSocketError(socket) {
    const rejected = socket.deserializeAttachment()?.rejected;
    try { socket.close(1011, 'Relay error'); } catch {}
    if (rejected) return;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (!allowedOrigin(request)) return new Response('Forbidden', { status: 403 });

    const match = url.pathname.match(/^\/room\/([A-HJ-NP-Z2-9]{5})$/);
    if (!match) return new Response('Not found', { status: 404 });
    return env.MATCH_ROOMS.getByName(match[1]).fetch(request);
  },
};
