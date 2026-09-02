/* Runtime configuration. Deliberately not bundled, so it can be edited on a
   deployed site without touching anything else.
 *
 * With this file untouched, 1v1 runs on public STUN and PeerJS's free public
 * broker. That is enough for most pairs of networks.
 */

window.LUKELESS_CONFIG = {
  // Extra ICE servers. Roughly 10-20% of network pairs — symmetric NAT on both
  // ends, mostly — cannot reach each other without a TURN relay.
  //
  // iceServers: [
  //   { urls: 'stun:stun.example.net:3478' },
  //   { urls: 'turn:turn.example.net:3478', username: '…', credential: '…' },
  // ],

  // Point at your own signalling server instead of the public PeerJS broker.
  // The broker only ever sees the handshake — never a guess, never a score —
  // but it is a shared free service with no uptime guarantee.
  //
  // peerServer: { host: 'signal.example.com', port: 443, path: '/', secure: true },
};
