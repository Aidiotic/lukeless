# lukeless

Name the song from a one-second clip. A guessing game over [lukebox][]'s playlist,
in the shape of Heardle: you get a second of a song, and every wrong guess or skip
buys you a little more of it. Solo against a daily song, endlessly against random
ones, or 1v1 against a friend over six rounds (fourteen on Insane).

Live at **[aidiotic.github.io/lukeless][live]**.

[lukebox]: https://aidiotic.github.io/lukebox/
[live]: https://aidiotic.github.io/lukeless/

## Where the audio comes from

Apple's public 30-second preview clips, the same source [laufeyless][] uses. The
Spotify paste that lukebox is built from is metadata only — no audio and no track
ids — so `build-songs.mjs` searches Apple's catalogue for each row by title and
artist, and keeps the preview URL of whatever it can match confidently.

That has three consequences worth knowing before they look like bugs:

- **Clips start at the hook, not the first note.** That is how Apple cuts previews.
- **Not every row resolves.** A song the store does not carry, or carries only
  under a name too far from the playlist's, is dropped rather than guessed at — a
  clip that plays the wrong song is worse than a missing song. The build prints
  every row it gave up on.
- **Nothing is hosted here.** No audio file is in this repo and none is served
  from it; the page points a plain `<audio>` at Apple's CDN. That is deliberate,
  the same way lukebox links out instead of playing.

[laufeyless]: https://aidiotic.github.io/laufeyless/

## Adding a playlist

Playlists live in `playlists/`, in either of two shapes.

**A Spotify paste** (`.txt`) — select the tracks in the desktop app, copy, save.
The parser is lukebox's, unchanged, so the same pastes work in both projects.
`playlists/luke.txt` is one of these.

**A track list** (`.json`) — an array of `{ title, artists, album }`. Useful when
the songs are not in Spotify at all.

### From a local Apple Music library

```bash
node scan-apple-music.mjs > playlists/mine.json
```

This reads the *names* out of `~/Music`, and only the names. Apple Music's
offline downloads are FairPlay-encrypted `.m4p`, and the library index is
Apple's proprietary `hfma` binary; neither is opened, and neither could be
legally decoded anyway. What is readable without any of that is the folder
layout Music.app writes —

```
Media.localized/Apple Music/<artist>/<album>/<NN title>.m4p
```

— which is all the build needs to find each song again in Apple's public
catalogue and take its preview clip. The encrypted audio is never touched; the
library is used purely as a list of what you own. Downloads still in flight, in
`Downloads-Music/`, get swept up as well.

Explicit tracks are kept, and preferred over a "cleaned" release of the same
song, since a censored version is a different master and the edit can land right
on the hook the clip uses.

### Then

Make sure the playlist has an entry in the `PACKS` list at the top of
`build-songs.mjs` — `luke.txt` and `mine.json` are already listed, and a missing
file is skipped with a note, so the build works with either or both. Then:

```bash
node build-songs.mjs
```

That rewrites `songs.js` with one entry per resolved song and one pack per
playlist, plus an "Everything" pack when there is more than one. Results are
cached in `.cache/`, so a second playlist only costs searches for its own rows.
Delete the cache to re-resolve from scratch.

The build paces itself against the store rather than at a fixed rate — every
refusal widens the gap between calls, every clean stretch narrows it, so it
settles wherever the store is actually willing to answer instead of guessing at
a number. A cold playlist can take anywhere from a few minutes to a few hours
depending on how hard the address has been leaning on the store lately. Leave it
running; it writes the cache as it goes; and refusals are never cached, so a
second run (or `--offline` to rebuild from what is already cached) only retries
what actually failed.

## 1v1

Both browsers connect to a two-seat WebSocket room in the `lukeless-relay`
Cloudflare Worker. Each five-character match code maps to one Durable Object, so
the same room is reached from different Wi-Fi, mobile, and restrictive NAT
networks without depending on a direct WebRTC path. One player opens a match and
gets the code; the other types it in or follows the invite link. From there:

- Six rounds on Normal or fourteen on Insane, with the same songs on both screens,
  drawn by whoever opened the match.
- You both race the same clip. Fewer seconds scores more (100/80/60/45/30/20), and
  the round goes to the higher score.
- A round has a 90-second clock. Running it out forfeits that round, not the match.
- While a round is live, each side sees the other's *shape* — how many tries spent,
  whether they have finished — and never the song or the guesses.
- Every fifth round is an AsapSCIENCE track. If the selected pack has none, the
  easter egg deliberately reaches into the full catalog so the guarantee holds.

The relay forwards opaque game messages; it does not choose songs or keep score.
Both browsers still hold the whole song list, so this remains a game between
people who are not trying to cheat. The relay endpoint lives in `config.js`.
Brief connection drops are retried automatically, and idle rooms exchange a
small keepalive so a transient network or proxy timeout does not end the match.

Deploy the relay after changing `worker/relay.js` or `wrangler.jsonc`:

```bash
npx wrangler deploy
```

## Taking it down

The game client is static GitHub Pages, so the closest equivalent to restarting
that client is `config.js`'s `maintenance` flag. Flip it on and every open tab
notices within about ten seconds and reloads onto the notice in
`maintenanceNotice`. The WebSocket relay is a separate Worker deployment.

```bash
./restart.sh "optional reason shown on the maintenance page"
```

This flips the flag on, pushes, waits for GitHub Pages to actually publish it
(polled against the Pages build API, not a guessed sleep), then flips it back
off, pushes, and waits again. Know the real timing before leaning on this for
anything time-sensitive: each half waits on an actual Pages build, usually
30-90 seconds but not guaranteed, so a full cycle is a couple of minutes, not
ten seconds — the ten seconds is how fast an *already-open tab* reacts once the
change is live, not how fast publishing itself happens.

To do it by hand instead of running the script: edit `maintenance` and
`maintenanceNotice` in `config.js` (or run
`node scripts/set-maintenance.mjs true "reason"`), commit, and push.

## Layout

```
index.html        markup
style.css         lukebox's palette, carried over
config.js         release, maintenance, and 1v1 relay configuration
songs.js          generated — do not edit by hand
build-songs.mjs   playlists/ + Apple's catalogue -> songs.js
parse.mjs         the Spotify-paste parser, lifted from lukebox
scan-apple-music.mjs
                  a local Apple Music library -> playlists/mine.json
restart.sh        take the site down for maintenance, then back up
scripts/set-maintenance.mjs
                  flips config.js's maintenance flag; restart.sh's building block
src/app.js        the game
src/versus.js     the 1v1 link
worker/relay.js   two-seat 1v1 WebSocket room Durable Object
wrangler.jsonc    Cloudflare Worker deployment configuration
playlists/        Spotify pastes (.txt) and track lists (.json)
```

## Local

```bash
npx serve .
```

Any static server works; there is no build step for the page itself.

---

Unofficial fan project. All music belongs to its artists — this repo contains no
audio, only links to Apple's public previews.
