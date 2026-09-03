/* Runtime configuration. Deliberately not bundled, so it can be edited on a
   deployed site without touching anything else.
 *
 * With this file untouched, 1v1 runs on public STUN and PeerJS's free public
 * broker. That is enough for most pairs of networks.
 */

window.LUKELESS_CONFIG = {
  // ── maintenance ──
  // There is no server behind this site to restart — it's static pages, and a
  // 1v1 match is two browsers talking directly to each other with nothing of
  // ours in between. This flag is what stands in for one: flip it here and
  // push (or run ./restart.sh, which does both halves of that for you), and
  // every open tab notices within about ten seconds and reloads onto the
  // notice below — which is also the only way to actually interrupt a match
  // already in progress, short of running a server that could.
  maintenance: true,
  maintenanceNotice: "Correcting Insane search variants. Back shortly.",

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
