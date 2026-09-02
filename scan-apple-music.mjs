#!/usr/bin/env node
/* Reads the track list out of a local Apple Music library.
 *
 *   node scan-apple-music.mjs [> playlists/mine.json]
 *
 * Only the *names* are read. Apple Music's offline files are FairPlay-encrypted
 * .m4p, and the library index is Apple's proprietary hfma binary — neither is
 * opened here and neither could be legally decoded anyway. What is readable
 * without touching any of that is the folder layout Music.app writes:
 *
 *     Media.localized/Apple Music/<artist>/<album>/<NN title>.m4p
 *
 * which carries everything the build needs to find the song again in Apple's
 * public catalogue and pull its preview clip. The encrypted audio is never
 * used; it just tells us what the person owns.
 *
 * Downloads still in flight live somewhere else, as
 *
 *     Media.localized/Downloads-Music/<title> _ <album> _ <artist>.tmp
 *
 * so those are swept up too.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(homedir(), 'Music/Music/Media.localized');
const LIBRARY = join(ROOT, 'Apple Music');
const PENDING = join(ROOT, 'Downloads-Music');

const dirs = (p) => existsSync(p)
  ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

/* Music.app writes one artist string per folder, so a collaboration arrives as
   "A & B" or "A, B" and has to be split back apart for the catalogue search. */
const splitArtists = (name) =>
  name.split(/\s*&\s*|\s*,\s*/).map((s) => s.trim()).filter(Boolean);

const stripDisc = (name) => name.replace(/^\d+[-\s]+/, '').trim();

const tracks = [];
const seen = new Set();

/* Nothing is filtered on content. Instrumentals, remixes, edits and explicit
   cuts all stay: they are songs in the library, and the library is the point.
   The only things dropped are true duplicates — see the numbered-copy pass at
   the bottom. */
function add(title, artists, album) {
  if (!title || !artists.length) return;
  const key = title.toLowerCase() + '|' + artists.join().toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  tracks.push({ title, artists, album: album || null });
}

/* A downloaded track is stored one of two ways depending on when Music.app
   fetched it: a single .m4p file, or a .movpkg *directory* holding fragmented
   HLS. Both sit in the same artist/album folder, and a track can exist as both,
   which `add` dedupes. Missing the directory form loses about a third of a
   library, so match on the name and ignore whether it is a file. */
const TRACK = /\.(m4p|m4a|mp3|movpkg)$/i;

for (const artist of dirs(LIBRARY)) {
  for (const album of dirs(join(LIBRARY, artist))) {
    for (const entry of readdirSync(join(LIBRARY, artist, album))) {
      if (!TRACK.test(entry)) continue;
      add(stripDisc(entry.replace(TRACK, '')), splitArtists(artist), album);
    }
  }
}

for (const entry of dirs(PENDING)) {
  // "<title> _ <album> _ <artist>.tmp" — the separator is a literal underscore
  // because a slash cannot go in a filename.
  const parts = entry.replace(/\.tmp$/, '').split(' _ ');
  if (parts.length < 3) continue;
  add(parts[0].trim(), splitArtists(parts.at(-1)), parts.slice(1, -1).join(' _ ').trim());
}

/* Music.app disambiguates a second copy of a file by hanging a number off the
   end, so "Mood (feat. iann dior) 1" is not a title. Only dropped when the
   un-numbered version is actually present under the same artist — plenty of
   real titles end in a digit, and "Blink 182" should survive this. */
const key = (t) => t.title.toLowerCase() + '|' + t.artists.join().toLowerCase();
const present = new Set(tracks.map(key));

const clean = tracks.filter((t) => {
  const bare = t.title.replace(/\s+\d+$/, '');
  return bare === t.title || !present.has(bare.toLowerCase() + '|' + t.artists.join().toLowerCase());
});

process.stdout.write(JSON.stringify(clean, null, 1) + '\n');
process.stderr.write(`${clean.length} tracks from ${dirs(LIBRARY).length} artists\n`);
