# Claude review: Insane search variants and 1v1 emergency patch

## Requested behaviour

Insane mode keeps its search field. A search for a song title expands into six
nearly identical recordings: the one real catalog title and five synthetic,
plausible version names. Nothing is shown before the player searches, so this
tests whether they know the exact recording instead of giving them a blind
one-in-six choice. A wrong version consumes one of five guesses and advances
the audio by two ladder positions. Insane 1v1 remains fourteen rounds and uses
the same rules on both peers.

## Search implementation

`buildChoices` in `src/app.js` derives a base title by removing a trailing
parenthesized or bracketed recording qualifier, then generates contextual
variants such as live, acoustic, orchestral, studio, or lofi versions. The real
catalog row keeps its song index; synthetic rows use `i: -1`, so only the exact
real entry can resolve as correct. Generated titles that collide with any real
catalog title are excluded. The target song is used as the autocomplete anchor
when its searchable title matches the query; otherwise the first real catalog
match is used. Normal-mode autocomplete is unchanged.

## 1v1 incident and root cause

The current production revision was tested with two fresh browser tabs: a host
opened room `MCDTD`, a guest joined that code, and both entered round 1 of 6.
That confirms code normalization, PeerJS discovery, and the hello/setup/start
handshake are working.

The deployment still had a real failure window. GitHub Pages serves `index.html`,
`songs.js`, `src/app.js`, and `src/versus.js` with `Cache-Control: max-age=600`.
The Insane search change also advanced the handshake `BUILD` prefix from 3 to 4.
Two players could therefore load different cached releases and be rejected by
the intentional version check, presenting as a room code that no longer works.
A mixed `app.js` / `versus.js` / `songs.js` load was also possible within one
browser.

## Emergency patch

All local assets now carry the same `?v=<release>` query stamp. `restart.sh`
derives that stamp from the feature commit at the start of a publish and updates
the stylesheet, runtime config, catalog, main module, and the main module's
`versus.js` import before creating the maintenance-down commit. The browser can
still cache a release, but it cannot silently mix that release with the next
one once it receives the updated page.

Follow-up after a real two-device report: stamping child assets was necessary
but insufficient because `index.html` itself can be the stale cached file.
`config.js` now publishes the active release and is already fetched with
`cache: no-store`. On boot and every maintenance poll, `app.js` compares that
release with its own stamped module URL. A mismatch replaces the page URL with
a release-specific query, forcing GitHub Pages and the browser to fetch the
current HTML and its coherently stamped assets. This closes the stale-root-page
case instead of waiting up to ten minutes for it to expire.

`src/versus.js` also now forwards a late `peer-unavailable` error after the
local PeerJS identity has opened. Previously it tried to reject an already
settled promise, so the join screen could remain on “Connecting…” without
explaining that the host code was not reachable.

Both follow-ups were exercised locally. A page running release `422fd0f` was
left open while the served release changed to `selfheal1`; on its next poll it
navigated to `?release=selfheal1` and fetched all five stamped assets from that
release. Joining nonexistent code `ZZZZZ` now surfaces “No match with that
code” instead of silently remaining in the connecting state.

The `BUILD` handshake check remains in place. It is a correctness guard because
song indices and gameplay messages are only meaningful when both peers run the
same protocol and catalog; removing it would turn a clear rejection into
desynchronized gameplay.

## Verification checklist

- Load production in two fresh tabs, host a room, join its five-character code,
  and confirm both peers enter the same round.
- In Insane, confirm no choices appear before typing.
- Search a known title and confirm exactly six near-identical rows appear.
- Pick a synthetic row and confirm one guess is consumed while the clip jumps
  two ladder positions (for example, 0.1 seconds to 0.7 seconds).
- Pick the exact real catalog row and confirm it scores as correct.
- During publish, inspect the deployed HTML and main module and confirm every
  local asset uses the same release query value.

## Definitive cross-network transport fix

The earlier two-tab tests proved the game handshake but did not prove NAT
traversal: both peers were inside one browser on one machine. A real friend on
a different network can be behind a symmetric NAT or restrictive firewall, and
the old PeerJS setup only supplied STUN. Public/demo TURN credentials were
tested with a real `RTCPeerConnection`; neither produced a relay candidate, so
they were not shipped.

`src/versus.js` now uses a WebSocket relay instead of WebRTC. The relay is the
`lukeless-relay` Cloudflare Worker in `worker/relay.js`. Each normalized room
code maps through `MATCH_ROOMS.getByName(code)` to its own Durable Object. The
object accepts one host and one guest, emits `paired` only when both seats are
present, forwards JSON messages without interpreting them, and reports missing,
used, and full rooms explicitly. The existing hello/setup/start/progress game
protocol above the transport remains unchanged; its build prefix is now 5.

The deployed relay health endpoint returned `{ "ok": true }`. Local clients
connected through that live Worker using room `32DWM`; both entered round 1 of
14 on Insane, and a guest skip changed the host's opponent display to “on try
2”, proving application messages crossed the relay. A guest joining `ZZZZZ`
received the intended no-match error. The final Worker deployment version is
`32eff9cf-50ec-4ee9-9466-0a84ac72b126`; its bundle is 3.38 KiB (1.21 KiB gzip)
and the deployment reported a 6 ms startup time.

A final capacity test filled room `RDFB4`, then attempted a third guest. The
third client received “That match already has two players,” while the original
host and guest both remained in `Round 1 of 14 · Insane`; rejected sockets do
not emit a false peer-disconnected event into the valid match.

## AsapSCIENCE round-five guarantee

The earlier implementation incremented `endlessCount` only in solo Endless and
only selected AsapSCIENCE from the active pack. It therefore did nothing in
1v1, and Luke's playlist (which has zero AsapSCIENCE entries) silently skipped
the easter egg. `pickAsapScience` now prefers eligible tracks in the active pack
and falls back to the three AsapSCIENCE entries in the full catalog. Endless
uses it every fifth song. The authoritative host-side `drawSongs` also inserts
it at every fifth 1v1 position before applying Normal weighting or Insane's
lofi bias, so Normal round 5 and Insane rounds 5 and 10 are guaranteed and
remain identical for both players.

Empirical verification used a Normal 1v1 hosted on Luke's playlist—the exact
fallback case, since that pack has no AsapSCIENCE songs. Both peers advanced
through rounds 1–4 in room `7MSHY`. On `Round 5 of 6`, revealing the answer
showed `The Pi Song 3.0 (300 Digits of Π)` by `AsapSCIENCE`.

## Relay resilience follow-up

The initial Worker client treated every WebSocket close as a permanent opponent
departure, so a brief Wi-Fi or mobile-network interruption ended the match.
Clients now reconnect four times over roughly six seconds using a per-tab token;
the Durable Object persists each seat token and replaces the stale socket only
when that token and role match. Explicit `bye` messages release the stored seat.
Queued game messages flush after pairing, and a 20-second ping/pong keeps idle
connections alive. Raw transport loss no longer reports `peer-left`; intentional
Cancel and page-exit paths still send the existing `bye` game message.

The maintenance overlay also has four decorative Israeli-flag corner accents.
They scale responsively, respect mobile safe-area insets, and are hidden from
screen readers so the actual maintenance message stays uncluttered.
