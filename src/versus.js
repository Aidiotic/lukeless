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

/* A guest can genuinely beat the host to the relay: the host's code is on
   screen before its own socket has finished registering, so "no match with
   that code" is often just "not yet". Treating that as fatal is why joining
   could need a second attempt to work — retry across roughly six seconds
   before believing it. */
const JOIN_DELAYS = [400, 900, 1800, 3000];

/* Rejection sampling rather than a plain modulo. 256 is not a multiple of 31,
   so `byte % 31` hands the first eight letters an extra chance each and the
   code space is not quite as large as it looks. 248 is 31 × 8, so bytes above
   it are thrown away and every letter is then equally likely. */
export function makeCode() {
  const out = [];
  while (out.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH))) {
      if (byte < 248 && out.length < CODE_LENGTH) out.push(ALPHABET[byte % ALPHABET.length]);
    }
  }
  return out.join('');
}

/* The code names the room; this is what proves you were invited to it. Five
   readable characters is roughly 28 million rooms, which is small enough to
   walk and easy to overhear, so it cannot be the credential. 26 characters
   out of 32 is about 130 bits — not guessable, and the relay seals a room
   long before anyone could try. It travels in the invite link and never in a
   request URL, so it stays out of logs. */
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const KEY_LENGTH = 26;

export function makeKey() {
  const out = [];
  while (out.length < KEY_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(KEY_LENGTH))) {
      if (byte < 224 && out.length < KEY_LENGTH) out.push(KEY_ALPHABET[byte % KEY_ALPHABET.length]);
    }
  }
  return out.join('');
}

export const normaliseKey = (text) =>
  String(text ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '').slice(0, KEY_LENGTH);

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
    this.joinTries = 0;
    this.rejoin = false;
    this.token = crypto.randomUUID();
  }

  host(code, key) { return this.#connect(code, 'host', key); }
  join(code, key) { return this.#connect(code, 'guest', key); }

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

  #connect(code, role, key) {
    this.code = code;
    this.role = role;
    this.key = key;
    return this.#openSocket(true);
  }

  #openSocket(initial) {
    const configured = window.LUKELESS_CONFIG?.relayServer ?? DEFAULT_RELAY;
    const base = configured.replace(/^http/, 'ws').replace(/\/$/, '');
    const query = new URLSearchParams({ role: this.role, token: this.token });

    /* The key rides in the WebSocket subprotocol rather than the query string.
       Request URLs get written to request logs; a subprotocol does not, and
       this value is the thing that actually gates the room. */
    const socket = new WebSocket(
      `${base}/room/${encodeURIComponent(this.code)}?${query}`,
      ['lukeless-v1', this.key],
    );
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
        if (message?.__relay === 'no-match') return this.#noMatch();
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
        // A rejected join reconnects on its own schedule, not the drop one.
        if (this.rejoin) {
          this.rejoin = false;
          this.retryTimer = setTimeout(() => {
            this.#openSocket(false).catch(() => {});
          }, JOIN_DELAYS[this.joinTries++]);
          return;
        }
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

  /* Mid-match this means the room genuinely went away, so fall through to the
     ordinary drop handling. Before pairing it usually means the host has not
     landed yet, so close and come back rather than giving up on the first
     answer. */
  #noMatch() {
    if (this.everReady) return this.#relayProblem('No match with that code.');
    if (this.joinTries >= JOIN_DELAYS.length) {
      return this.#relayError('No match with that code. Ask the host to keep their page open.');
    }
    this.rejoin = true;
    this.on.status?.('Looking for that match…');
    try { this.socket?.close(1000, 'Retrying'); } catch {}
  }

  #relayProblem(message) {
    if (this.everReady) {
      try { this.socket?.close(1012, 'Retrying'); } catch {}
    } else {
      this.#relayError(message);
    }
  }
}
