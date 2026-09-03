/* Runtime configuration. Deliberately not bundled, so endpoints and
   maintenance state can be changed without rebuilding the game. */

window.LUKELESS_CONFIG = {
  // Updated by restart.sh. app.js fetches this file without cache and moves
  // stale pages onto a release-specific URL before allowing a 1v1 handshake.
  release: '49dce0b',

  // ── maintenance ──
  // The page itself is static GitHub Pages. This flag stands in for restarting
  // that client: flip it here and push (or run ./restart.sh), and every open
  // tab notices within about ten seconds and reloads onto the notice below.
  maintenance: true,
  maintenanceNotice: "lukeless is locked down while we fix a security issue in 1v1. Solo play is affected too until this is done. Back shortly.",

  // Durable Object WebSocket relay. Keeping this outside the bundle makes it
  // possible to move the relay without changing game code.
  relayServer: 'wss://lukeless-relay.dropline.workers.dev',
};
