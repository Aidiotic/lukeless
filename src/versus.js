/* The 1v1 link.

   There is no server holding a match open, so a match is really just a peer id
   both players can work out from the code: the person who opened it parks on
   `lkl-<code>` and answers the door, the other one knocks. Same trick clearline
   uses for rooms, minus the mesh — there are only ever two of you here.

   The host is authoritative about *which* songs get played and when a round
   starts, because two clients picking their own randomness would not be
   playing the same game. Everything else is symmetric: each side scores its own
   round and tells the other what it got.

   What travels over the wire is only ever a shape of the opponent's progress —
   how many tries they have spent, whether they have finished, what they scored.
   The song they are on is already known to both sides from the setup message,
   so nothing here can leak an answer that the other client did not already
   have. Which is also the honest caveat: both clients hold the whole song list,
   so this is a game between people who are not trying to cheat. Making it
   cheat-proof needs a referee, and a referee needs a server. */

const PREFIX = 'lkl-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1 — these get read aloud
const CODE_LENGTH = 5;

export function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

export const normaliseCode = (text) =>
  text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);

export class Versus {
  /* `on` takes { open, message, close, error } — all optional. */
  constructor({ on = {} } = {}) {
    this.on = on;
    this.peer = null;
    this.conn = null;
    this.isHost = false;
    this.code = null;
    this.closed = false;
  }

  async host(code) {
    this.isHost = true;
    this.code = code;
    this.peer = await this.#openPeer(PREFIX + code);

    // The door stays open until someone walks through it; a second knock after
    // that is refused rather than silently replacing the player already here.
    this.peer.on('connection', (conn) => {
      if (this.conn) { conn.close(); return; }
      this.#adopt(conn);
    });
  }

  async join(code) {
    this.isHost = false;
    this.code = code;
    // A random suffix, so two people joining at once do not collide and so
    // nobody can be dialled directly from outside the match.
    this.peer = await this.#openPeer(PREFIX + code + '-' + makeCode().toLowerCase());
    this.#adopt(this.peer.connect(PREFIX + code, { reliable: true }));
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }

  close() {
    this.closed = true;
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.conn = this.peer = null;
  }

  /* ── plumbing ── */

  #openPeer(id) {
    const cfg = window.LUKELESS_CONFIG ?? {};
    const peer = new Peer(id, {
      ...(cfg.peerServer ?? {}),
      config: { iceServers: cfg.iceServers ?? [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ] },
    });

    return new Promise((resolve, reject) => {
      let opened = false;
      peer.on('open', () => { opened = true; resolve(peer); });
      peer.on('error', (err) => {
        // `unavailable-id` means somebody already parked on this code. Every
        // other error can arrive later, once we are connected, so it is
        // reported rather than thrown.
        if (!opened && err.type === 'unavailable-id') reject(new Error('That code is already in use.'));
        else if (!opened && err.type === 'peer-unavailable') reject(new Error('No match with that code.'));
        else if (this.closed) return;
        else if (err.type === 'peer-unavailable') this.on.error?.(new Error('No match with that code. Check the code and ask the host to keep this page open.'));
        else this.on.error?.(err);
      });
    });
  }

  #adopt(conn) {
    this.conn = conn;
    conn.on('open', () => this.on.open?.());
    conn.on('data', (msg) => { if (msg && typeof msg === 'object') this.on.message?.(msg); });
    conn.on('close', () => { if (!this.closed) this.on.close?.(); });
    conn.on('error', (err) => { if (!this.closed) this.on.error?.(err); });
  }
}
