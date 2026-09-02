# lukeless

Name the song from a one-second clip. A guessing game over [lukebox][]'s playlist,
in the shape of Heardle: you get a second of a song, and every wrong guess or skip
buys you a little more of it. Solo against a daily song, endlessly against random
ones, or 1v1 against a friend over six rounds.

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

Playlists live in `playlists/` as raw pastes out of Spotify's desktop app —
select the tracks, copy, save as a `.txt`. The parser is lukebox's, unchanged, so
the same pastes work in both projects.

1. Drop the paste in `playlists/`, e.g. `playlists/mine.txt`.
2. Make sure it has an entry in the `PACKS` list at the top of `build-songs.mjs`.
   `luke.txt` and `mine.txt` are already listed; a missing file is skipped with a
   note, so the build works with either or both.
3. Run the build.

```bash
node build-songs.mjs
```

That rewrites `songs.js` with one entry per resolved song and one pack per
playlist, plus an "Everything" pack when there is more than one. Results are
cached in `.cache/`, so a second playlist only costs searches for its own rows.
Delete the cache to re-resolve from scratch.

The build paces itself at about eighteen searches a minute because the store
starts refusing at twenty. A cold 239-row playlist takes roughly a quarter of an
hour. Leave it running.

## 1v1

Both browsers talk directly over WebRTC, with [PeerJS][]'s public broker for the
handshake — the same arrangement [clearline][] uses for calls. One player opens a
match and gets a five-character code; the other types it in, or follows the invite
link. From there:

- Six rounds, the same six songs on both screens, drawn by whoever opened the match.
- You both race the same clip. Fewer seconds scores more (100/80/60/45/30/20), and
  the round goes to the higher score.
- A round has a 90-second clock. Running it out forfeits that round, not the match.
- While a round is live, each side sees the other's *shape* — how many tries spent,
  whether they have finished — and never the song or the guesses.

There is no server keeping score, which means both browsers hold the whole song
list. It is a game between people who are not trying to cheat; making it
cheat-proof needs a referee, and a referee needs a backend.

If a pair of networks cannot connect at all, that is usually symmetric NAT on both
ends and it needs a TURN relay. `config.js` has a commented-out slot for one.

[PeerJS]: https://peerjs.com/
[clearline]: https://aidiotic.github.io/clearline/

## Layout

```
index.html        markup
style.css         lukebox's palette, carried over
config.js         ICE servers and signalling, editable on a deployed site
songs.js          generated — do not edit by hand
build-songs.mjs   playlists/ + Apple's catalogue -> songs.js
parse.mjs         the Spotify-paste parser, lifted from lukebox
src/app.js        the game
src/versus.js     the 1v1 link
playlists/        raw Spotify pastes
```

## Local

```bash
npx serve .
```

Any static server works; there is no build step for the page itself.

---

Unofficial fan project. All music belongs to its artists — this repo contains no
audio, only links to Apple's public previews.
