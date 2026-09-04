/* Runtime configuration. Deliberately not bundled, so endpoints and
   maintenance state can be changed without rebuilding the game. */

window.LUKELESS_CONFIG = {
  // Updated by restart.sh. app.js fetches this file without cache and moves
  // stale pages onto a release-specific URL before allowing a 1v1 handshake.
  release: '8f7b752',

  /* Limited mode. The site is up and solo play is untouched; 1v1 is narrowed
     to invite links carrying a key, so a match code on its own cannot get
     anyone in. Flip this off here when the restriction is lifted. */
  limited: false,
  limitedNotice: "Limited mode — 1v1 is invite-link only. Sending someone the code on its own will not let them in.",

  // ── maintenance ──
  // The page itself is static GitHub Pages. This flag stands in for restarting
  // that client: flip it here and push (or run ./restart.sh), and every open
  // tab notices within about ten seconds and reloads onto the notice below.
  maintenance: false,
  maintenanceNotice: "Locked down for security fixes. Back shortly.",

  // Durable Object WebSocket relay. Keeping this outside the bundle makes it
  // possible to move the relay without changing game code.
  relayServer: 'wss://lukeless-relay.dropline.workers.dev',
};
