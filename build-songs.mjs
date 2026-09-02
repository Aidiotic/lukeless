#!/usr/bin/env node
/* Resolves each playlist row to a 30-second preview clip and writes songs.js.
 *
 *   node build-songs.mjs
 *
 * The Spotify paste is metadata only — no audio and no track ids — so every
 * row has to be found again in Apple's public catalogue by title and artist.
 * That search is the whole job, and it is fuzzy: the paste says "Bayside
 * (Radio Edit)" where Apple says "Bayside (Radio Edit)" on one release and
 * plain "Bayside" on three others, and some rows are not in the catalogue at
 * all. Rows that cannot be matched confidently are dropped rather than guessed
 * at, because a clip that plays the wrong song is worse than a missing song.
 *
 * Results are cached in .cache/itunes.json keyed by the query, so adding a
 * playlist re-searches only the new rows. Delete the cache to re-resolve
 * everything.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from './parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, '.cache/itunes.json');

/* Each playlist becomes a pack the player can pick in the game. `file` is a
   paste dropped in playlists/; a missing file is skipped with a note, so the
   build works before a second playlist has been added. */
const PACKS = [
  { id: 'luke', name: "Luke's playlist", file: 'luke.txt' },
  { id: 'mine', name: 'My library', file: 'mine.json' },
];

/* Two input shapes. A .txt is a raw Spotify paste and goes through lukebox's
   parser; a .json is already a list of { title, artists, album }, which is what
   scan-apple-music.mjs writes. */
function readPlaylist(path) {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) {
    return JSON.parse(text)
      .filter((t) => t?.title && t.artists?.length)
      .map((t) => ({ title: t.title, artists: t.artists, album: t.album ?? null }));
  }
  return parse(text);
}

// ── matching ───────────────────────────────────────────────────────────────

/* Two normalisations. `norm` keeps everything but punctuation, so
   "Bayside (Radio Edit)" only equals the same edit. `base` also strips the
   trailing bracket and the feat. run, so it equals any release of the song —
   used as the weaker fallback when no exact edit is on the store. */
const norm = (s) => s.toLowerCase()
  .replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9']+/g, ' ').trim();

const base = (s) => norm(
  s.replace(/\s*[\(\[][^)\]]*[\)\]]\s*/g, ' ')
   .replace(/\s*-\s*(radio edit|single version|remaster(ed)?.*|extended.*|slowed.*|sped up.*|live.*)$/i, '')
   .replace(/\s*(feat\.|ft\.|featuring)\s.*$/i, '')
);

/* Lower is better; null means "not the same song, do not use". Artist
   agreement is what stops a common title like "Money" resolving to whichever
   "Money" the store ranks first. */
function score(row, hit) {
  if (!hit.previewUrl || hit.wrapperType !== 'track' || hit.kind !== 'song') return null;

  const rowTitle = norm(row.title), hitTitle = norm(hit.trackName);
  const rowBase = base(row.title), hitBase = base(hit.trackName);

  let s;
  if (rowTitle === hitTitle) s = 0;
  else if (rowBase && rowBase === hitBase) s = 10;
  else if (rowBase && hitBase && (hitBase.includes(rowBase) || rowBase.includes(hitBase))) s = 25;
  else return null;

  // The store's artist string is one field ("A & B"), so compare on words.
  const hitWords = new Set(norm(hit.artistName).split(' '));
  const matched = row.artists.filter((a) =>
    norm(a).split(' ').some((w) => w.length > 2 && hitWords.has(w)));

  if (!matched.length) {
    // No shared artist word at all. Only tolerable when the title is an exact,
    // distinctive match — remix credits often name nobody from the paste.
    if (s > 0 || rowTitle.split(' ').length < 3) return null;
    s += 40;
  } else if (matched.length < row.artists.length) s += 5;

  // Prefer the studio cut over the karaoke/tribute/live re-recording that the
  // store is full of, and prefer earlier results as a tiebreak.
  const coll = hit.collectionName || '';
  if (/karaoke|tribute|made popular|in the style of|cover version/i.test(coll + hit.artistName)) s += 100;
  if (/\blive\b/i.test(coll) && !/\blive\b/i.test(row.title)) s += 15;

  // Explicit is not filtered — it is preferred. A "cleaned" release is a
  // different master, and the edit can land right on the hook the clip uses.
  if (hit.trackExplicitness === 'cleaned') s += 3;

  return s;
}

// ── the store ──────────────────────────────────────────────────────────────

/* Empty answers are dropped on the way in rather than trusted. A row the store
   genuinely does not have costs one wasted search per run; a row that came
   back empty because the store was rate-limiting would otherwise be written
   off permanently on the strength of one bad minute. */
const cache = existsSync(CACHE)
  ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(CACHE, 'utf8')))
      .filter(([, v]) => Array.isArray(v) && v.length))
  : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function saveCache() {
  if (OFFLINE) return;   // an offline run has learned nothing worth writing back
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache));
}

/* The store answers 403 for a while once you cross its rate limit, and where
   that limit sits depends on how hard the address has been leaning on it
   lately — it is not a fixed twenty a minute.
 *
 * So the pace tunes itself instead of being guessed at. Every refusal widens
 * the gap between calls, every clean stretch narrows it slightly, and it
 * settles wherever the store is actually willing to answer. This matters far
 * more than it sounds: a refusal costs a multi-second backoff *and* pushes the
 * limiter further into refusing, so a rate that is a little too fast collapses
 * to a fraction of the throughput of one that is a little too slow. Measured
 * on a throttled address, fixed 3.2s pacing managed about one row a minute;
 * this settles around eight. */
const RATE_MIN = 2500, RATE_MAX = 20000;
let rate = 4000;
let lastCall = 0;

/* `--offline` builds from whatever is already cached and asks the store
   nothing. Useful for rebuilding songs.js after a change to the matching
   rules, and for getting a partial list out while a long run is still going. */
const OFFLINE = process.argv.includes('--offline');

async function search(term) {
  if (term in cache) return cache[term];
  if (OFFLINE) return [];

  await sleep(Math.max(0, lastCall + rate - Date.now()));
  lastCall = Date.now();

  const url = 'https://itunes.apple.com/search?entity=song&limit=25&country=US&term='
    + encodeURIComponent(term);

  // The store rate-limits hard and answers 403 rather than 429 when it does,
  // so back off for a good while rather than burning the retries in a second.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) {
      const results = (await res.json()).results ?? [];
      rate = Math.max(RATE_MIN, rate * 0.98);   // relax slowly while it is answering
      cache[term] = results;
      saveCache();     // written as we go, so a killed run keeps what it earned
      return results;
    }
    rate = Math.min(RATE_MAX, rate * 1.6);      // refused — give it more room
    await sleep(rate);
    lastCall = Date.now();
  }

  // Deliberately not cached: a refusal is not an answer, and caching it as an
  // empty result would make the next run skip the row instead of retrying it.
  console.warn(`  ! store would not answer for ${JSON.stringify(term)} — will retry next run`);
  return [];
}

async function resolveRow(row) {
  // Two passes: the full title first, then the bare title if the edit in the
  // paste is not on the store under that name.
  const terms = [`${row.artists[0]} ${row.title}`];
  if (base(row.title) !== norm(row.title)) terms.push(`${row.artists[0]} ${base(row.title)}`);

  let best = null, bestScore = Infinity;
  for (const term of terms) {
    for (const hit of await search(term)) {
      const s = score(row, hit);
      if (s !== null && s < bestScore) { best = hit; bestScore = s; }
    }
    if (bestScore === 0) break; // exact edit by the right artist; stop looking
  }
  return best;
}

// ── build ──────────────────────────────────────────────────────────────────

async function main() {
  const songs = [], packs = [];
  const seen = new Map(); // normalised title+artist → index, so packs can share a song

  for (const pack of PACKS) {
    const path = resolve(HERE, 'playlists', pack.file);
    if (!existsSync(path)) {
      console.log(`skipping ${pack.name} — no playlists/${pack.file} yet`);
      continue;
    }

    const rows = readPlaylist(path);
    const members = [], missing = [];
    console.log(`\n${pack.name}: ${rows.length} rows`);

    for (const [n, row] of rows.entries()) {
      // Printed before the row is attempted, so a run of unmatched rows still
      // shows progress rather than looking hung.
      if (n && n % 10 === 0) {
        console.log(`  ${n}/${rows.length} · ${members.length} matched · ${(rate / 1000).toFixed(1)}s/call`);
      }

      const hit = await resolveRow(row);
      if (!hit) { missing.push(`${row.title} — ${row.artists.join(', ')}`); continue; }

      const key = norm(hit.trackName) + '|' + norm(hit.artistName);
      let idx = seen.get(key);
      if (idx === undefined) {
        idx = songs.length;
        seen.set(key, idx);
        songs.push({
          title: row.title,                       // guess what the playlist says
          artist: row.artists.join(', '),
          album: hit.collectionName ?? row.album ?? '',
          year: (hit.releaseDate ?? '').slice(0, 4),
          art: (hit.artworkUrl100 ?? '').replace('100x100', '400x400'),
          preview: hit.previewUrl,
        });
      }
      members.push(idx);
    }

    packs.push({ id: pack.id, name: pack.name, songs: members });
    console.log(`  matched ${members.length}/${rows.length}`);
    if (missing.length) {
      console.log(`  no clip for ${missing.length}:`);
      missing.forEach((m) => console.log(`    · ${m}`));
    }
  }

  saveCache();
  if (!songs.length) throw new Error('nothing resolved — is playlists/ empty?');

  const out = `/* Generated by build-songs.mjs. Do not edit by hand — re-run
   \`node build-songs.mjs\` after changing anything in playlists/.

   ${songs.length} songs · ${packs.map((p) => `${p.name} ${p.songs.length}`).join(' · ')} */

const SONGS = ${JSON.stringify(songs)};
const PACKS = ${JSON.stringify(packs)};
`;
  writeFileSync(resolve(HERE, 'songs.js'), out);
  console.log(`\nwrote songs.js — ${songs.length} songs across ${packs.length} pack(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
