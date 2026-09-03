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
    if (role !== 'host' && role !== 'guest') return new Response('Invalid role', { status: 400 });

    const sockets = this.ctx.getWebSockets();
    const roles = sockets.map((socket) => socket.deserializeAttachment()?.role);
    if (role === 'host' && sockets.length) return this.#rejectedSocket('code-used');
    if (role === 'guest' && !roles.includes('host')) return this.#rejectedSocket('no-match');
    if (role === 'guest' && roles.includes('guest')) return this.#rejectedSocket('match-full');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ role });
    this.ctx.acceptWebSocket(server, [role]);

    if (role === 'guest') {
      for (const socket of this.ctx.getWebSockets()) {
        socket.send(JSON.stringify({ __relay: 'paired' }));
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

  webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 64_000) return;
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== socket) peer.send(message);
    }
  }

  webSocketClose(socket, code, reason, wasClean) {
    const rejected = socket.deserializeAttachment()?.rejected;
    socket.close(code, reason);
    if (rejected) return;
    for (const peer of this.ctx.getWebSockets()) {
      peer.send(JSON.stringify({ __relay: 'peer-left', clean: wasClean }));
    }
  }

  webSocketError(socket) {
    const rejected = socket.deserializeAttachment()?.rejected;
    try { socket.close(1011, 'Relay error'); } catch {}
    if (rejected) return;
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== socket) peer.send(JSON.stringify({ __relay: 'peer-left' }));
    }
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
