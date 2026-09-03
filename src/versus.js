/* The 1v1 transport.

   Match messages travel through a tiny Cloudflare Durable Object room instead
   of directly between the browsers. The old WebRTC path worked on friendly
   networks but could not cross symmetric NATs without a TURN relay. A room is
   still named by the same five-character code and holds at most one host and
   one guest; the relay never needs to understand the game payload. */

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1 — easy to read aloud
const CODE_LENGTH = 5;
const DEFAULT_RELAY = 'wss://lukeless-relay.dropline.workers.dev';
const RETRY_DELAYS = [300, 800, 1600, 3000];

export function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export const normaliseCode = (text) =>
  text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);

export class Versus {
  constructor({ on = {} } = {}) {
    this.on = on;
    this.socket = null;
    this.closed = false;
    this.ready = false;
    this.everReady = false;
    this.retry = 0;
    this.retryTimer = null;
    this.heartbeat = null;
    this.queue = [];
    this.token = crypto.randomUUID();
  }

  host(code) { return this.#connect(code, 'host'); }
  join(code) { return this.#connect(code, 'guest'); }

  send(message) {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else if (!this.closed && this.everReady) {
      this.queue.push(message);
      if (this.queue.length > 20) this.queue.shift();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    try { this.socket?.close(1000, 'Match closed'); } catch {}
    this.socket = null;
  }

  #connect(code, role) {
    this.code = code;
    this.role = role;
    return this.#openSocket(true);
  }

  #openSocket(initial) {
    const configured = window.LUKELESS_CONFIG?.relayServer ?? DEFAULT_RELAY;
    const base = configured.replace(/^http/, 'ws').replace(/\/$/, '');
    const query = new URLSearchParams({ role: this.role, token: this.token });
    const socket = new WebSocket(`${base}/room/${encodeURIComponent(this.code)}?${query}`);
    this.socket = socket;

    return new Promise((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => {
        if (opened || this.closed) return;
        if (initial) this.closed = true;
        try { socket.close(); } catch {}
        if (initial) reject(new Error('The match service did not answer. Try again.'));
      }, 12_000);

      socket.addEventListener('open', () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      });

      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }

        if (message?.__relay === 'pong') return;
        if (message?.__relay === 'paired') {
          this.ready = true;
          this.retry = 0;
          clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (this.socket?.readyState === WebSocket.OPEN) {
              this.socket.send(JSON.stringify({ __relay: 'ping' }));
            }
          }, 20_000);
          if (!this.everReady) {
            this.everReady = true;
            this.on.open?.();
          }
          while (this.queue.length && this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(this.queue.shift()));
          }
          return;
        }
        if (message?.__relay === 'no-match') return this.#relayProblem('No match with that code. Ask the host to keep their page open.');
        if (message?.__relay === 'code-used') return this.#relayProblem('That code is already in use. Open a new match.');
        if (message?.__relay === 'match-full') return this.#relayProblem('That match already has two players.');
        if (message?.__relay === 'peer-left') {
          if (!this.closed) this.on.close?.();
          return;
        }
        if (message && typeof message === 'object') this.on.message?.(message);
      });

      socket.addEventListener('error', () => {
        clearTimeout(timer);
        if (!opened && initial) {
          this.closed = true;
          reject(new Error('Could not reach the match service. Try again.'));
        }
      });

      socket.addEventListener('close', () => {
        clearTimeout(timer);
        if (this.closed || socket !== this.socket) return;
        this.ready = false;
        clearInterval(this.heartbeat);
        if (this.retry < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[this.retry++];
          this.retryTimer = setTimeout(() => {
            this.#openSocket(false).catch(() => {});
          }, delay);
        } else if (this.everReady) {
          this.on.close?.();
        } else {
          this.on.error?.(new Error('Could not reach the match service. Try again.'));
        }
      });
    });
  }

  #relayError(message) {
    if (this.closed) return;
    this.closed = true;
    this.on.error?.(new Error(message));
    try { this.socket?.close(1008, message.slice(0, 100)); } catch {}
  }

  #relayProblem(message) {
    if (this.everReady) {
      try { this.socket?.close(1012, 'Retrying'); } catch {}
    } else {
      this.#relayError(message);
    }
  }
}
