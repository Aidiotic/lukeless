/* lukeless — the game.
 *
 * Four modes over one engine. A round is always the same thing: a song index,
 * a list of guesses, and a clip that grows by one step every time you get it
 * wrong. Daily and Endless differ only in how the index is chosen. Insane
 * differs in how brutal that growth is, and how you answer. 1v1 differs in
 * that the index arrives from the other browser and the result gets sent back.
 *
 * The clip-length ladder and its scoring belong to the ROUND, not the mode —
 * each round carries its own `cfg` (steps + points), set once in beginRound
 * and read everywhere else as `S.cfg`. A 1v1 round uses the host's locked-in
 * difficulty, sent during setup, so both sides score the same ladder.
 */

import { Versus, makeCode, makeKey, normaliseCode, normaliseKey } from './versus.js?v=4c2d1fa';

// The query is stamped by restart.sh. A fresh, uncached config.js announces
// the live release so even an already-cached page can move itself forward.
const ASSET_RELEASE = new URL(import.meta.url).searchParams.get('v') ?? 'dev';

const NORMAL_CFG = { steps: [1, 2, 4, 7, 11, 16], points: [100, 80, 60, 45, 30, 20] };

/* Insane: 0.1s is not a typo. Five steps instead of six, and every step is
   worth more than the equivalent normal-mode step, because getting anything
   right off a tenth of a second is a different sport. */
const INSANE_CFG = { steps: [0.1, 0.5, 0.7, 1, 1.5], points: [200, 150, 110, 80, 50] };

const HINT_COST = 25;
const EPOCH = Date.UTC(2026, 0, 1);

const NORMAL_VS_ROUNDS = 6;
const INSANE_VS_ROUNDS = 14;
const VS_CLOCK = 90;   // seconds a round is allowed to run before it forfeits

const $ = (id) => document.getElementById(id);
const el = new Proxy({}, { get: (_, id) => $(id) });

// ── packs ──────────────────────────────────────────────────────────────────

/* PACKS comes out of the build with one entry per playlist. An "everything"
   pack is only worth offering when there is more than one to combine. */
const ALL_PACKS = PACKS.length > 1
  ? [...PACKS, { id: 'all', name: 'Everything', songs: [...new Set(PACKS.flatMap((p) => p.songs))] }]
  : PACKS;

/* Both players must be holding the same songs.js for a shared index to mean
   the same song on both screens. Cheap fingerprint, checked at handshake. */
const BUILD = '5.' + SONGS.length + '.' + SONGS.reduce((h, s) => (h * 31 + s.title.length) % 99991, 7);

/* Everything by default when there is more than one playlist to combine —
   opening on one person's list buries the rest of the songs behind a control
   most people never touch. A stored choice still wins over it. */
const DEFAULT_PACK = ALL_PACKS.find((p) => p.id === 'all')?.id ?? ALL_PACKS[0]?.id;

let packId = localStorage.getItem('lukeless.pack') ?? DEFAULT_PACK;
if (!ALL_PACKS.some((p) => p.id === packId)) packId = DEFAULT_PACK;

const pack = () => ALL_PACKS.find((p) => p.id === packId) ?? ALL_PACKS[0];
const pool = () => pack().songs;

// ── text ───────────────────────────────────────────────────────────────────

const norm = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();
const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* First word of the title. A leading article is useless on its own, so
   "The Killing Moon" gives back "The Killing". */
function firstWord(title) {
  const w = title.split(/\s+/);
  return (/^(a|an|the)$/i.test(w[0]) && w[1]) ? w[0] + ' ' + w[1] : w[0];
}

// ── persistence ────────────────────────────────────────────────────────────

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('lukeless.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lukeless.' + k, JSON.stringify(v)); } catch {} },
};

let stats = LS.get('stats', { played: 0, wins: 0, streak: 0, max: 0, dist: [0,0,0,0,0,0], lastDay: null });
let vsStats = LS.get('vsStats', { played: 0, won: 0 });
let board = LS.get('board', []);

// ── state ──────────────────────────────────────────────────────────────────

const audio = new Audio();
audio.preload = 'auto';
audio.crossOrigin = 'anonymous';

let mode = 'daily';
let S = null;                 // the round in progress
let playTimer = null, raf = null, playing = false;
let match = null;             // 1v1 state, null outside 1v1
let clockTimer = null;

// ── scoring ────────────────────────────────────────────────────────────────

const stageOf = (st) => Math.min(st.step ?? st.rows.length, st.cfg.steps.length - 1);
const stage = () => stageOf(S);
const limit = () => S.cfg.steps[stage()];

function scoreOf(st) {
  if (!st?.won) return 0;
  return Math.max(0, (st.cfg.points[stageOf(st)] ?? 0) - (st.hint ? HINT_COST : 0));
}
const secsOf = (st) => (st?.won ? st.cfg.steps[stageOf(st)] : null);

// ── volume ─────────────────────────────────────────────────────────────────

let vol = LS.get('vol', 0.8), muted = LS.get('muted', false);

function applyVolume() {
  const level = muted ? 0 : vol;
  audio.volume = level;
  el.fullAudio.volume = level;
  el.volRange.value = Math.round(vol * 100);
  el.volRange.style.setProperty('--fill', Math.round(level * 100) + '%');
  el.vol.classList.toggle('muted', muted);
  el.volBtn.textContent = level === 0 ? '🔇' : level < 0.5 ? '🔈' : '🔊';
  el.volBtn.title = el.volBtn.ariaLabel = muted ? 'Unmute' : 'Mute';
  LS.set('vol', vol); LS.set('muted', muted);
}

el.volRange.addEventListener('input', () => {
  vol = el.volRange.value / 100;
  muted = vol === 0;                 // dragging to zero is just muting
  applyVolume();
});
el.volBtn.addEventListener('click', () => {
  muted = !muted;
  if (!muted && vol === 0) vol = 0.5; // unmuting from a dead slider needs somewhere to go
  applyVolume();
});

// ── audio ──────────────────────────────────────────────────────────────────

function stopClip() {
  clearTimeout(playTimer); cancelAnimationFrame(raf);
  audio.pause(); playing = false;
  el.playBtn.textContent = '▶';
  el.played.style.width = '0%';
  const max = (s) => s.cfg.steps[s.cfg.steps.length - 1];
  el.time.textContent = '0.0 / ' + (S ? (S.done ? max(S) : limit()) : NORMAL_CFG.steps[0]).toFixed(1) + 's';
}

function playClip() {
  if (!S) return;
  if (playing) { stopClip(); return; }
  const max = S.cfg.steps[S.cfg.steps.length - 1];
  const lim = S.done ? max : limit();
  audio.currentTime = 0;
  audio.play().then(() => {
    playing = true;
    el.playBtn.textContent = '❚❚';
    playTimer = setTimeout(stopClip, lim * 1000 + 60);
    const tick = () => {
      if (!playing) return;
      const t = Math.min(audio.currentTime, lim);
      el.played.style.width = (t / max * 100) + '%';
      el.time.textContent = t.toFixed(1) + ' / ' + lim.toFixed(1) + 's';
      raf = requestAnimationFrame(tick);
    };
    tick();
  }).catch(() => toast('Could not load that clip — check your connection.'));
}

// ── rounds ─────────────────────────────────────────────────────────────────

function rng(seed) {
  let a = seed >>> 0;
  return () => { a ^= a << 13; a >>>= 0; a ^= a >> 17; a ^= a << 5; a >>>= 0; return a / 4294967296; };
}

const dayNumber = () => {
  const n = new Date();
  return Math.floor((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - EPOCH) / 864e5);
};

/* A seeded permutation of the pack, so the daily song never repeats until the
   whole pack has been used. Reshuffled each time round the cycle. */
function dailyIndex(day) {
  const list = pool(), N = list.length;
  const cycle = Math.floor(day / N), pos = ((day % N) + N) % N;
  const r = rng(cycle * 7919 + 104729 + hashCode(packId));
  return weightedOrder(list, r)[pos];
}

const hashCode = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 99991, 0);

/* Laufey is weighted up within whatever pool is playing. She is 97 of the 623
   songs, which on a straight draw would put her on screen about one round in
   six; 2.5x brings that closer to one in three without crowding out
   everything else the way an early 5x cut did. Matched on the artist field,
   so features and collaborations count. */
const LAUFEY = /(^|[^a-z])laufey([^a-z]|$)/i;
const LAUFEY_WEIGHT = 2.5;
const rawWeight = (i) => (LAUFEY.test(SONGS[i].artist) ? LAUFEY_WEIGHT : 1);

/* Luke's playlist and "mine" sit at 184 and 455 songs, so on Everything a flat
   shuffle surfaces one of mine about four times as often as one of Luke's —
   not because either playlist matters more, just because one of us kept fewer
   downloads.
 *
 * Each pack's songs are rescaled so the *pack's total* weight lands on a fixed
   target no matter how many songs are in it — and, importantly, no matter how
   Laufey's boost has already skewed things inside that pack. Doing this
   multiplicatively instead (pack weight times Laufey weight) does not work:
   since every Laufey song lives in "mine", her boost would inflate mine's
   total share on top of whatever the pack target was aiming for, and the two
   biases would compound into something well past "slightly more". Normalizing
   each pack's sum first keeps them independent — Laufey still gets more than
   an average "mine" song, but "mine" as a whole stays at its target regardless.
   MINE_EDGE sets that target a little above Luke's — a real playthrough
   only samples a handful of rounds at a time, so even a mathematically fair
   45/55 split can run a visible losing streak for one side by pure chance;
   1.15 keeps Luke's from needing to claw back from as far behind when that
   happens, while mine still edges it. All of this is computed once, since
   the packs and Laufey's in-pack boost are both fixed once songs.js is
   generated.
 *
 * Only Everything mixes packs, so only Everything needs any of this. Picking
 * either playlist on its own draws from it undiluted, at even odds among
 * itself (Laufey aside). */
const MINE_EDGE = 1.15;

const ALL_WEIGHT = PACKS.length > 1 ? (() => {
  const table = new Map();
  for (const p of PACKS) {
    const target = p.id === 'mine' ? MINE_EDGE : 1;
    const sum = p.songs.reduce((a, i) => a + rawWeight(i), 0);
    for (const i of p.songs) table.set(i, (table.get(i) ?? 0) + (rawWeight(i) / sum) * target);
  }
  return table;
})() : null;

const weightOf = (i) => (packId === 'all' && ALL_WEIGHT) ? (ALL_WEIGHT.get(i) ?? rawWeight(i)) : rawWeight(i);

/* Weighted shuffle, Efraimidis-Spirakis: give each song a key of r^(1/weight)
   and sort by it. Ordering by that key is equivalent to drawing without
   replacement in proportion to weight, which is the useful property here —
   every song still appears exactly once, so the daily cycle keeps its
   guarantee of no repeat, and a 1v1 never asks the same song twice. The bias
   decides where in the order things land, not how many times. */
function weightedOrder(list, rnd) {
  return list
    .map((i) => ({ i, key: Math.pow(rnd(), 1 / weightOf(i)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.i);
}

/* A running joke, not a weighting concern like the two above: every 5th
   Endless or 1v1 round is guaranteed to be AsapSCIENCE. Prefer one from the
   selected pack, but fall back to the full catalogue because Luke's playlist
   contains none and a "guarantee" that silently disappears is not one. */
let endlessCount = 0;
const ASAPSCIENCE = /(^|[^a-z])asapscience([^a-z]|$)/i;
const ASAP_SONGS = SONGS.map((song, i) => ({ song, i }))
  .filter(({ song }) => ASAPSCIENCE.test(song.artist))
  .map(({ i }) => i);

function pickAsapScience(used = new Set()) {
  const inPack = pool().filter((i) => ASAPSCIENCE.test(SONGS[i].artist) && !used.has(i));
  const candidates = inPack.length ? inPack : ASAP_SONGS.filter((i) => !used.has(i));
  return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
}

function pickEndlessSong() {
  endlessCount++;
  if (endlessCount % 5 === 0) {
    const asap = pickAsapScience();
    if (asap !== null) return asap;
  }
  return weightedOrder(pool(), Math.random)[0];
}

/* Insane draws mostly from tagged Lofi versions when the current pack has
   any — matched on title, since a lofi cut is its own catalogue entry, not a
   variant of the normal one. Only 4 exist today (all Laufey, all in "My
   library"), so on Luke's playlist or with a fresh catalogue this always
   falls back to a normal draw. */
const LOFI_RE = /\(lofi version\)/i;
const LOFI_CHANCE = 0.95;

function pickInsaneSong() {
  if (Math.random() < LOFI_CHANCE) {
    const lofi = pool().filter((i) => LOFI_RE.test(SONGS[i].title));
    if (lofi.length) return lofi[Math.floor(Math.random() * lofi.length)];
  }
  return weightedOrder(pool(), Math.random)[0];
}

function buildChoices(idx) {
  const song = SONGS[idx];
  const base = (() => {
    let title = song.title.trim(), previous;
    do {
      previous = title;
      title = title.replace(/\s*(?:\([^()]*\)|\[[^\[\]]*\])\s*$/, '').trim();
    } while (title && title !== previous);
    return title || song.title;
  })();

  const live = /\blive\b/i.test(song.title);
  const lofi = /\blo-?fi\b/i.test(song.title);
  const instrumental = /\binstrumental\b/i.test(song.title);
  const suffixes = live ? [
    'Live', 'Live at the Hollywood Bowl', 'Live with the Icelandic Orchestra',
    'Live at the Royal Albert Hall', 'Live at the Symphony', 'Live in Los Angeles',
    'Live Acoustic', 'Live from Reykjavík',
  ] : lofi ? [
    'Lofi Version', 'Lo-Fi Mix', 'Lofi Rework', 'Bedroom Lofi Version',
    'Slowed Lofi Version', 'Late Night Lofi Mix', 'Lofi Instrumental',
  ] : instrumental ? [
    'Instrumental', 'Orchestral Instrumental', 'Piano Instrumental',
    'Acoustic Instrumental', 'Studio Instrumental', 'Instrumental Rework',
  ] : [
    'Acoustic Version', 'Live', 'Studio Version', 'Orchestral Version',
    'Stripped Version', 'Demo', 'Rework', 'Live at the Hollywood Bowl',
  ];

  const catalogue = new Set(SONGS.map((s) => norm(s.title)));
  const seen = new Set([norm(song.title)]);
  const fakeTitles = suffixes.map((suffix) => `${base} (${suffix})`).filter((title) => {
    const key = norm(title);
    if (seen.has(key) || catalogue.has(key)) return false;
    seen.add(key); return true;
  });
  for (let n = 1; fakeTitles.length < 5; n++) {
    const title = `${base} (Alternate ${n === 1 ? 'Version' : 'Take ' + n})`;
    const key = norm(title);
    if (!seen.has(key) && !catalogue.has(key)) { seen.add(key); fakeTitles.push(title); }
  }

  const choices = [
    { i: idx, title: song.title, artist: song.artist, key: norm(song.title) },
    ...fakeTitles.slice(0, 5).map((title) => ({ i: -1, title, artist: song.artist, key: norm(title) })),
  ];

  // Fisher-Yates with the integer PRNG keeps the expanded search result stable
  // while the player edits the query, and identical for both 1v1 players.
  const orderRng = rng(hashCode(BUILD + '|choice-order|' + idx));
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(orderRng() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return choices;
}

function beginRound(idx, restore, cfg = NORMAL_CFG) {
  S = {
    idx, rows: [], done: false, won: false, hint: false, cfg, step: 0,
  };
  if (restore) {
    Object.assign(S, restore, { idx, cfg });
    if (restore.step == null) S.step = Math.min(S.rows.length, cfg.steps.length - 1);
  }
  audio.src = SONGS[idx].preview;
  audio.load();
  el.gameArea.style.display = '';
  el.result.classList.remove('show');
  el.guess.value = ''; el.ac.classList.remove('show'); acList = []; chosen = null;
  el.submitBtn.disabled = true;
  el.fullAudio.pause(); el.fullAudio.removeAttribute('src');
  render();
}

// ── rendering ──────────────────────────────────────────────────────────────

function render() {
  if (!S) return;

  const steps = S.cfg.steps, max = steps[steps.length - 1];

  el.guesses.innerHTML = '';
  for (let i = 0; i < steps.length; i++) {
    const r = S.rows[i], d = document.createElement('div');
    d.className = 'row ' + (r ? r.kind : (i === S.rows.length && !S.done ? 'active empty' : 'empty'));
    const mark = r ? (r.kind === 'right' ? '✓' : r.kind === 'skip' ? '›' : '✕') : '';
    const body = r
      ? (r.kind === 'skip' ? 'Skipped'
        : escapeHtml(r.text) + (r.hint ? ' <span class="cheat">*</span>' : ''))
      : '·';
    d.innerHTML = '<span class="mark">' + mark + '</span><span class="txt">' + body + '</span>';
    el.guesses.appendChild(d);
  }

  const lim = S.done ? max : limit();
  el.unlocked.style.width = (lim / max * 100) + '%';
  el.ticks.innerHTML = steps.map((s) =>
    '<span class="tick' + (s <= lim ? ' on' : '') + '" style="left:' + (s / max * 100) + '%">' + s + 's</span>'
  ).join('');
  el.time.textContent = '0.0 / ' + lim.toFixed(1) + 's';

  const left = steps.length - S.rows.length;
  el.status.textContent = S.done ? 'Full 30s preview below'
    : left + (left === 1 ? ' try left' : ' tries left');

  // Rounded to one decimal: Insane's steps are fractions of a second, and
  // subtracting them in floating point (0.7 - 0.5) can land on
  // 0.19999999999999998 rather than 0.2 without this.
  el.skipBtn.textContent = S.rows.length >= steps.length - 1
    ? 'Give up'
    : stage() >= steps.length - 1
      ? 'Skip (max clip)'
      : 'Skip (+' + Math.round((steps[stage() + 1] - lim) * 10) / 10 + 's)';

  showHint();
  // No hint in 1v1 (see revealHint) or Insane — Insane uses the ambiguous
  // six-version search results instead.
  el.hintbar.hidden = mode === 'versus' || mode === 'insane';
  el.nextBtn.style.display = mode === 'daily' || mode === 'versus' ? 'none' : '';
  el.shareBtn.style.display = mode === 'versus' ? 'none' : '';
  el.reportRow.style.display = mode === 'versus' ? 'none' : '';
  el.searchbox.hidden = false;
  el.submitBtn.hidden = false;
}

function showHint() {
  if (!S?.hint) {
    el.hintWord.hidden = true;
    el.hintBtn.disabled = false;
    el.hintBtn.textContent = 'Reveal first word';
    return;
  }
  el.hintBtn.disabled = true;
  el.hintBtn.textContent = 'Hint used';
  el.hintWord.hidden = false;
  el.hintWord.innerHTML = '<small>Title starts with</small>' + escapeHtml(firstWord(SONGS[S.idx].title));
}

function revealHint() {
  // Not offered in 1v1 (the two of you are racing the same clip, and a
  // button that trades points for the answer only muddies who actually knew
  // it) or in Insane (the whole point of that mode is no help at all).
  if (mode === 'versus' || mode === 'insane' || !S || S.done || S.hint) return;
  S.hint = true;
  showHint();
  saveDaily();
}

// ── autocomplete ───────────────────────────────────────────────────────────

let titles = [], acList = [], acSel = -1, chosen = null;

function rebuildTitles() {
  /* `key` is the title alone — it's what a guess has to exactly equal to be
     submittable, and what the guessed-set / share text are built from, so it
     has to stay title-only or a repeat guess would stop being recognized as
     one. `searchKey` is only for the filter below, and folds the artist in
     too, so typing an artist's name (recognized them, not sure of the title)
     narrows the list the same way typing part of the title does. */
  titles = pool().map((i) => ({
    i,
    title: SONGS[i].title,
    artist: SONGS[i].artist,
    key: norm(SONGS[i].title),
    searchKey: norm(SONGS[i].title + ' ' + SONGS[i].artist),
  }));
}

/* True for solo Insane and for an Insane 1v1 match. `mode` stays 'versus'
   during a match, so Insane-only UI and penalties must check its difficulty. */
const insaneRules = () => mode === 'insane' || (mode === 'versus' && !!match?.insane);

function updateAC() {
  const q = norm(el.guess.value);
  chosen = null; el.submitBtn.disabled = true; acList = [];
  if (!q || !S || S.done) { el.ac.classList.remove('show'); return; }

  const guessed = new Set(S.rows.filter((r) => r.kind !== 'skip').map((r) => norm(r.text)));

  if (insaneRules()) {
    const matches = titles.filter((t) => t.searchKey.includes(q) && !guessed.has(t.key))
      .sort((a, b) => a.searchKey.indexOf(q) - b.searchKey.indexOf(q) || a.key.localeCompare(b.key));
    const target = titles.find((t) => t.i === S.idx);
    const anchor = target?.searchKey.includes(q) && !guessed.has(target.key) ? target : matches[0];
    acList = anchor ? buildChoices(anchor.i).filter((t) => !guessed.has(t.key)) : [];
  } else {
    acList = titles.filter((t) => t.searchKey.includes(q) && !guessed.has(t.key))
      .sort((a, b) => a.searchKey.indexOf(q) - b.searchKey.indexOf(q) || a.key.localeCompare(b.key))
      .slice(0, 40);
  }

  if (!acList.length) { el.ac.classList.remove('show'); return; }
  acSel = 0;
  el.ac.innerHTML = acList.map((t, n) =>
    '<div data-n="' + n + '"' + (n === acSel ? ' class="sel"' : '') + '>' + escapeHtml(t.title) +
    '<small>' + escapeHtml(t.artist) + '</small></div>').join('');
  el.ac.classList.add('show');
  el.submitBtn.disabled = false;
}

function pick(n) {
  acSel = n;
  const t = acList[n]; if (!t) return;
  el.guess.value = t.title; el.ac.classList.remove('show');
  chosen = t; el.submitBtn.disabled = false; el.guess.focus();
}

function markSel() {
  [...el.ac.children].forEach((c, n) => c.classList.toggle('sel', n === acSel));
  el.ac.children[acSel]?.scrollIntoView({ block: 'nearest' });
  el.submitBtn.disabled = !acList[acSel];
}

// ── turns ──────────────────────────────────────────────────────────────────

function submit() {
  const t = chosen ?? acList[acSel];
  if (!t || !S || S.done) return;

  const right = t.i === S.idx;
  S.rows.push({ kind: right ? 'right' : 'wrong', text: t.title, hint: right && S.hint });
  if (!right) S.step = Math.min(stage() + (insaneRules() ? 2 : 1), S.cfg.steps.length - 1);
  el.guess.value = ''; el.ac.classList.remove('show');
  acList = []; chosen = null; el.submitBtn.disabled = true;
  stopClip();

  if (right) finish(true);
  else if (S.rows.length >= S.cfg.steps.length) finish(false);
  else { render(); saveDaily(); pushProgress(); setTimeout(playClip, 220); }
}

function skip() {
  if (!S || S.done) return;
  S.rows.push({ kind: 'skip', text: 'Skipped' });
  S.step = Math.min(stage() + 1, S.cfg.steps.length - 1);
  stopClip();
  if (S.rows.length >= S.cfg.steps.length) finish(false);
  else { render(); saveDaily(); pushProgress(); setTimeout(playClip, 220); }
}

function finish(won) {
  S.done = true; S.won = won;
  render();
  showResult();
  if (mode === 'versus') { finishVersusRound(); return; }

  const day = dayNumber();
  const fresh = mode === 'endless' || stats.lastDay !== day;
  if (mode === 'daily' && fresh) {
    stats.played++;
    if (won) {
      stats.wins++; stats.dist[S.rows.length - 1]++;
      stats.streak++; stats.max = Math.max(stats.max, stats.streak);
    } else stats.streak = 0;
    stats.lastDay = day;
    LS.set('stats', stats);
  }
  if (fresh) recordRun();
  saveDaily();
  drawStats();
  setTimeout(() => statsDlg.showModal(), 900);
}

function showResult(verdict) {
  const song = SONGS[S.idx];
  el.gameArea.style.display = 'none';
  el.result.classList.add('show');
  el.verdict.textContent = verdict ?? (S.won
    ? ['Instant.', 'Two seconds.', 'Nicely done.', 'Got there.', 'Just about.', 'Last try — phew.'][S.rows.length - 1]
    : 'Not this one.');
  el.art.src = song.art; el.art.alt = song.album ? song.album + ' cover art' : '';
  el.rTitle.textContent = song.title;
  el.rMeta.textContent = [song.artist, song.album, song.year].filter(Boolean).join(' · ');
  el.fullAudio.src = song.preview;
  el.fullAudio.volume = muted ? 0 : vol;
}

function saveDaily() {
  if (mode !== 'daily' || !S) return;
  LS.set('daily', {
    day: dayNumber(), pack: packId, idx: S.idx, rows: S.rows, done: S.done,
    won: S.won, hint: S.hint, step: S.step,
  });
}

// ── stats, leaderboard, reports ────────────────────────────────────────────

function recordRun() {
  board.push({
    title: SONGS[S.idx].title, pts: scoreOf(S), secs: secsOf(S),
    tries: S.rows.length, hint: !!S.hint, won: !!S.won, mode, pack: packId, at: Date.now(),
  });
  board.sort((a, b) => b.pts - a.pts || (a.secs ?? 99) - (b.secs ?? 99) || a.at - b.at);
  board = board.slice(0, 50);
  LS.set('board', board);
}

function drawStats() {
  el.sPlayed.textContent = stats.played;
  el.sWin.textContent = stats.played ? Math.round(stats.wins / stats.played * 100) + '%' : '0%';
  el.sStreak.textContent = stats.streak;
  el.sMax.textContent = stats.max;
  el.sVsPlayed.textContent = vsStats.played;
  el.sVsWon.textContent = vsStats.won;

  const top = Math.max(1, ...stats.dist);
  el.dist.innerHTML = stats.dist.map((v, i) =>
    '<div class="bar-row"><i>' + (i + 1) + '</i><div class="bar' +
    (S?.done && S.won && S.rows.length === i + 1 ? ' hi' : '') +
    '" style="width:' + (14 + v / top * 78) + '%">' + v + '</div></div>').join('');
}

function drawBoard() {
  if (!board.length) {
    el.board.innerHTML = '<div class="empty-board">No runs yet.<br>Finish a song and it lands here.</div>';
    el.boardNote.textContent = '';
    return;
  }
  el.board.innerHTML = board.map((b, n) =>
    '<div class="lb' + (n < 3 ? ' top' : '') + '">' +
      '<div class="rank">' + (n + 1) + '</div>' +
      '<div class="who"><b>' + escapeHtml(b.title) + (b.hint ? ' <span class="cheat">*</span>' : '') + '</b>' +
      '<span>' + (b.won ? 'solved at ' + b.secs + 's · ' + b.tries + (b.tries === 1 ? ' try' : ' tries') : 'missed') +
      ' · ' + escapeHtml(b.mode) + '</span></div>' +
      '<div class="pts">' + b.pts + '</div>' +
    '</div>').join('');

  const solved = board.filter((b) => b.won);
  el.boardNote.innerHTML = board.length + ' run' + (board.length === 1 ? '' : 's') +
    ' · total ' + board.reduce((a, b) => a + b.pts, 0) + ' pts' +
    (solved.length ? ' · best ' + Math.min(...solved.map((b) => b.secs)) + 's' : '') +
    '<br>Scores are kept on this device. <span class="cheat">*</span> means the hint was used.';
}

function shareText() {
  const squares = S.rows.map((r) => r.kind === 'right' ? '🟩' : r.kind === 'skip' ? '⬜' : '🟥').join('');
  const pad = '⬛'.repeat(Math.max(0, S.cfg.steps.length - S.rows.length));
  const label = mode === 'daily' ? 'lukeless #' + dayNumber() : 'lukeless (' + mode + ')';
  return label + ' · ' + (S.won ? secsOf(S) + 's' : 'X') + (S.hint ? ' *' : '') +
    '\n' + squares + pad + '\n' + scoreOf(S) + ' pts · aidiotic.github.io/lukeless';
}

function fullReport() {
  const L = ['=== lukeless — my results ==='];
  L.push('Pack: ' + pack().name);
  L.push('Stats: ' + stats.played + ' daily played · ' +
    (stats.played ? Math.round(stats.wins / stats.played * 100) : 0) + '% win rate · ' +
    'streak ' + stats.streak + ' · best streak ' + stats.max);
  L.push('Guess distribution (tries 1-6): ' + stats.dist.join(', '));
  L.push('1v1: ' + vsStats.played + ' played · ' + vsStats.won + ' won');

  if (S?.done) {
    L.push('', 'Latest: ' + (mode === 'daily' ? 'Daily #' + dayNumber() : mode) + ' — ' + SONGS[S.idx].title);
    L.push('  ' + (S.won ? 'solved at ' + secsOf(S) + 's in ' + S.rows.length +
      (S.rows.length === 1 ? ' try' : ' tries') : 'not solved') + (S.hint ? ' (hint used, *)' : ''));
    L.push('  ' + S.rows.map((r) => r.kind === 'right' ? '🟩' : r.kind === 'skip' ? '⬜' : '🟥').join('') +
      '⬛'.repeat(Math.max(0, S.cfg.steps.length - S.rows.length)));
  }
  if (board.length) {
    L.push('', 'Top runs:');
    board.slice(0, 10).forEach((b, n) => L.push('  ' + (n + 1) + '. ' + b.pts + ' pts — ' + b.title +
      (b.won ? ' (' + b.secs + 's)' : ' (missed)') + (b.hint ? ' *' : '')));
    L.push('', 'Total: ' + board.reduce((a, b) => a + b.pts, 0) + ' pts across ' +
      board.length + (board.length === 1 ? ' run.' : ' runs.'));
  }
  L.push('', '(* = the first word of the title was revealed before guessing)');
  return L.join('\n');
}

// ══ 1v1 ════════════════════════════════════════════════════════════════════

const myName = () => (el.vsName.value.trim() || 'You').slice(0, 16);

/* The host's choice at the moment a match actually starts (read in the
   'hello' handler) is what's authoritative — a guest's own toggle is purely
   cosmetic until 'setup' overwrites match.insane with the host's. */
let vsInsane = LS.get('vsInsane', false);

function syncDifficulty() {
  el.vsNormalBtn.setAttribute('aria-pressed', String(!vsInsane));
  el.vsInsaneBtn.setAttribute('aria-pressed', String(vsInsane));
}

function newMatch(isHost, code) {
  return {
    link: null, isHost, code,
    them: 'Opponent',
    round: -1, songs: [],
    mine: [], theirs: [],           // per-round { pts, secs, won, tries }
    live: null,                     // opponent's progress this round
    phase: 'lobby',
    readyMe: false, readyThem: false,
    sentDone: false,
    insane: false,                  // authoritative once 'setup' is sent (host) or received (guest)
  };
}

/* Host picks the songs. Sampling without replacement, so a match never asks
   the same song twice. Insane draws lean lofi the same way pickInsaneSong
   does for solo play, just without replacement across the full match. */
function drawSongs(insane) {
  const list = pool(), n = Math.min(insane ? INSANE_VS_ROUNDS : NORMAL_VS_ROUNDS, list.length);
  const used = new Set(), out = [];
  while (out.length < n) {
    let idx = null;
    if ((out.length + 1) % 5 === 0) idx = pickAsapScience(used);
    if (idx === null && insane && Math.random() < LOFI_CHANCE) {
      const lofi = list.filter((i) => LOFI_RE.test(SONGS[i].title) && !used.has(i));
      if (lofi.length) idx = lofi[Math.floor(Math.random() * lofi.length)];
    }
    if (idx === null) {
      idx = weightedOrder(list, Math.random).find((i) => !used.has(i));
    }
    if (idx === undefined || idx === null) break; // pool exhausted
    used.add(idx); out.push(idx);
  }
  return out;
}

function connLine(text, bad) {
  el.conn.textContent = text ?? '';
  el.conn.classList.toggle('bad', !!bad);
}

/* An invite is a code and a key. The code names the room and is fine to say
   out loud; the key is what lets you in, so it only ever travels in the link.
   A bare code cannot join, which is the point — overhearing one is useless. */
let inviteKey = '';

function readInvite(text) {
  const raw = String(text ?? '').trim();
  return {
    code: normaliseCode(/[?&]vs=([^&\s]+)/.exec(raw)?.[1] ?? raw),
    key: normaliseKey(/[?&]k=([^&\s]+)/.exec(raw)?.[1] ?? ''),
  };
}

async function openMatch() {
  const code = makeCode();
  match = newMatch(true, code);
  match.key = makeKey();
  el.codeOut.textContent = code;
  el.lobbyPick.hidden = true;
  el.lobbyWait.hidden = false;
  connLine('Waiting for someone to join…');

  match.link = new Versus({ on: versusHandlers() });
  try { await match.link.host(code, match.key); }
  catch (e) { connLine(e.message, true); resetLobby(); }
}

async function joinMatch() {
  const { code, key: pasted } = readInvite(el.joinCode.value);
  const key = pasted || inviteKey;
  if (code.length < 5) { connLine('That code is too short.', true); return; }

  match = newMatch(false, code);
  match.key = key;
  el.lobbyPick.hidden = true;
  el.lobbyWait.hidden = false;
  el.codeOut.textContent = code;
  connLine('Connecting…');

  match.link = new Versus({ on: versusHandlers() });
  try { await match.link.join(code, key); }
  catch (e) { connLine(e.message, true); resetLobby(); }
}

function versusHandlers() {
  return {
    open: () => {
      match.link.send({ t: 'hello', name: myName(), build: BUILD, pack: packId });
    },
    message: onVersusMessage,
    status: (text) => connLine(text),
    close: () => {
      if (!match) return;
      connLine('Your opponent disconnected.', true);
      endMatch('Opponent left.');
    },
    error: (err) => connLine('Connection trouble: ' + (err?.message ?? err?.type ?? 'unknown'), true),
  };
}

/* Everything arriving from the other browser is untrusted input, not a message
   from a known-good copy of this file. The relay forwards payloads without
   interpreting them, and the room code is the only thing gating who may send
   one — the Worker's Origin check stops a browser on another site, but any
   non-browser client sets that header to whatever it likes. So a "peer" is
   whoever holds the code.
 *
 * Each field is therefore narrowed here, once, to the shape the rest of the
   file already assumes, rather than at each of its use sites. Unknown mark
   kinds were an injection; a non-array `songs` or an out-of-range `round`
   indexes SONGS with garbage and throws mid-round, which strands the match
   with no way back to the lobby. */
const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/* Once setup has landed the real ceiling is this match's length, not the
   protocol's: round 13 is meaningless in a six-round match. Every consumer
   happens to compare against match.round first, so an over-range value is
   inert today — this keeps it inert if one of them ever stops comparing. */
const roundCeiling = () => Math.max(0, (match?.songs?.length || INSANE_VS_ROUNDS) - 1);

function cleanPeer(msg) {
  const t = String(msg.t ?? '');
  switch (t) {
    case 'hello':
      return { t, name: String(msg.name ?? 'Opponent').slice(0, 16), build: String(msg.build ?? ''), pack: String(msg.pack ?? '') };

    case 'setup':
      return {
        t, pack: String(msg.pack ?? ''), insane: !!msg.insane,
        songs: (Array.isArray(msg.songs) ? msg.songs : [])
          .filter((i) => Number.isInteger(i) && i >= 0 && i < SONGS.length)
          .slice(0, INSANE_VS_ROUNDS),
      };

    case 'progress':
      return {
        t, round: Math.trunc(clamp(msg.round, 0, roundCeiling())),
        marks: (Array.isArray(msg.marks) ? msg.marks : [])
          .filter((k) => PIP_KINDS.has(k)).slice(0, INSANE_VS_ROUNDS),
        done: !!msg.done, won: !!msg.won,
        pts: clamp(msg.pts, 0, 100000), secs: clamp(msg.secs, 0, 3600),
        tries: Math.trunc(clamp(msg.tries, 0, INSANE_VS_ROUNDS)),
      };

    case 'start':
    case 'ready':
      return { t, round: Math.trunc(clamp(msg.round, 0, roundCeiling())) };

    case 'over':
    case 'bye':
      return { t };

    default:
      return null;   // nothing else is part of the protocol
  }
}

function onVersusMessage(raw) {
  if (!match) return;

  const msg = cleanPeer(raw);
  if (!msg) return;

  switch (msg.t) {
    case 'hello': {
      match.them = String(msg.name ?? 'Opponent').slice(0, 16);
      if (msg.build !== BUILD) {
        connLine('You two are on different versions of the song list — reload both tabs.', true);
        endMatch('Version mismatch.');
        return;
      }
      // The host owns the setup, and answers the greeting with it.
      if (match.isHost) {
        match.insane = vsInsane;
        match.songs = drawSongs(match.insane);
        match.link.send({
          t: 'setup', songs: match.songs,
          pack: packId, insane: match.insane, rounds: match.songs.length,
        });
        startVersusRound(0);
        match.link.send({ t: 'start', round: 0 });
      }
      break;
    }

    case 'setup': {
      /* Direction matters as much as shape. The host owns the setup, the
         round pointer and the end of the match; a guest sending any of those
         is either a bug or someone cheating, since a guest that can rewrite
         `match.songs` mid-play picks the host's songs for them — and knows
         the answers. Only before the first round, too: a second setup during
         play would swap the catalogue out from under the round in progress. */
      if (match.isHost || match.phase !== 'lobby') break;
      // The guest plays the host's pack and difficulty, whatever it had picked.
      if (msg.pack && ALL_PACKS.some((p) => p.id === msg.pack)) { packId = msg.pack; syncPacks(); }
      match.insane = !!msg.insane;
      match.songs = msg.songs;
      // Nothing survived validation, so there is no match to play. Saying so
      // beats sitting in the lobby waiting for a round that cannot start.
      if (!match.songs.length) { connLine('The other player sent an unusable setup.', true); endMatch('Bad setup.'); }
      break;
    }

    case 'start':
      if (match.isHost) break;          // the host advances its own rounds, in maybeAdvance
      startVersusRound(msg.round);
      break;

    case 'progress':
      if (msg.round !== match.round) break;
      match.live = msg;
      if (msg.done) {
        match.theirs[match.round] = { pts: msg.pts, secs: msg.secs, won: msg.won, tries: msg.tries };
        maybeEndRound();
      }
      drawScoreboard();
      break;

    case 'ready':
      if (msg.round !== match.round) break;
      match.readyThem = true;
      // Only ever relabel this button in readyUp, i.e. when *this* player has
      // actually pressed it. Writing "waiting" here on the strength of the
      // opponent being ready deadlocked the match: the player who had not
      // pressed yet was told to wait, so they never pressed, so the round
      // never advanced and it sat there for good.
      drawScoreboard();
      if (match.isHost) maybeAdvance();
      break;

    case 'over':
      if (match.isHost) break;          // likewise: only the host calls a match finished
      showMatchResult();
      break;

    case 'bye':
      endMatch('Opponent left.');
      break;
  }
}

function startVersusRound(n) {
  if (!match || !match.songs.length) return;
  // The round number can come from the other browser. Clamping it to the
  // protocol's maximum is not enough — this match may be six rounds, not
  // fourteen — and `match.songs[n]` being undefined throws inside beginRound.
  if (!Number.isInteger(n) || n < 0 || n >= match.songs.length) return;
  clearInterval(clockTimer);

  match.round = n;
  match.live = null;
  match.readyMe = match.readyThem = false;
  match.sentDone = false;
  match.phase = 'playing';

  el.lobby.classList.remove('show');
  el.game.hidden = false;
  el.scoreboard.hidden = false;
  el.roundBar.hidden = false;
  el.roundLabel.textContent = 'Round ' + (n + 1) + ' of ' + match.songs.length + (match.insane ? ' · Insane' : '');
  el.guess.placeholder = 'Search by title or artist…';

  beginRound(match.songs[n], null, match.insane ? INSANE_CFG : NORMAL_CFG);
  drawScoreboard();
  startClock();
  el.guess.focus();
}

function startClock() {
  const deadline = Date.now() + VS_CLOCK * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    el.clock.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    el.clock.classList.toggle('low', left <= 15);
    if (left === 0) {
      clearInterval(clockTimer);
      if (S && !S.done) {
        // Out of time counts as a loss for the round, not a disconnect.
        while (S.rows.length < S.cfg.steps.length) S.rows.push({ kind: 'skip', text: 'Skipped' });
        stopClip();
        finish(false);
      }
    }
  };
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 250);
  tick();
}

/* Called from finish() when the mode is versus: bank the round, tell the other
   side, and wait for them if they are still going. */
function finishVersusRound() {
  clearInterval(clockTimer);
  match.mine[match.round] = { pts: scoreOf(S), secs: secsOf(S), won: S.won, tries: S.rows.length };
  pushProgress(true);
  drawScoreboard();
  maybeEndRound();
}

/* Progress goes out on every turn so the other side can watch the pips fill.
   It carries no song identity — only the shape of the guesses. */
function pushProgress(done) {
  if (mode !== 'versus' || !match?.link || !S) return;
  if (done && match.sentDone) return;
  if (done) match.sentDone = true;

  match.link.send({
    t: 'progress', round: match.round,
    marks: S.rows.map((r) => r.kind),
    done: !!S.done, won: !!S.won, hint: !!S.hint,
    pts: S.done ? scoreOf(S) : 0, secs: secsOf(S), tries: S.rows.length,
  });
}

function maybeEndRound() {
  if (!match || match.phase !== 'playing') return;
  if (!match.mine[match.round] || !match.theirs[match.round]) {
    if (S?.done) el.verdict.textContent = 'Waiting for ' + match.them + '…';
    return;
  }

  match.phase = 'roundOver';
  const me = match.mine[match.round], them = match.theirs[match.round];
  const verdict = me.pts > them.pts ? 'Round to you.'
    : me.pts < them.pts ? 'Round to ' + match.them + '.'
    : me.won ? 'Dead heat.' : 'Nobody got it.';

  showResult(verdict);
  drawScoreboard();

  const last = match.round >= match.songs.length - 1;
  el.nextBtn.style.display = '';
  el.nextBtn.textContent = last ? 'See the result' : 'Next round';
  el.nextBtn.disabled = false;
}

function readyUp() {
  if (!match || match.phase !== 'roundOver') return;
  match.readyMe = true;
  el.nextBtn.disabled = true;
  // Whichever side you are, what you are waiting on is the other player: the
  // round advances the moment both have pressed.
  el.nextBtn.textContent = 'Waiting for ' + match.them + '…';
  match.link.send({ t: 'ready', round: match.round });
  if (match.isHost) maybeAdvance();
}

function maybeAdvance() {
  if (!match?.isHost || !match.readyMe || !match.readyThem) return;
  const next = match.round + 1;
  if (next >= match.songs.length) { match.link.send({ t: 'over' }); showMatchResult(); return; }
  match.link.send({ t: 'start', round: next });
  startVersusRound(next);
}

const total = (rounds) => rounds.reduce((a, r) => a + (r?.pts ?? 0), 0);

function showMatchResult() {
  match.phase = 'matchOver';
  clearInterval(clockTimer);
  const mine = total(match.mine), theirs = total(match.theirs);

  vsStats.played++;
  if (mine > theirs) vsStats.won++;
  LS.set('vsStats', vsStats);

  el.gameArea.style.display = 'none';
  el.result.classList.add('show');
  el.verdict.textContent = mine > theirs ? 'You win, ' + mine + '–' + theirs
    : mine < theirs ? match.them + ' wins, ' + theirs + '–' + mine
    : 'A draw, ' + mine + ' each.';
  el.art.removeAttribute('src');
  el.rTitle.textContent = '';
  el.rMeta.textContent = match.songs.length + ' rounds · ' + pack().name;
  el.fullAudio.pause(); el.fullAudio.removeAttribute('src');
  el.nextBtn.textContent = 'New match';
  el.nextBtn.disabled = false;
  el.nextBtn.style.display = '';
  drawScoreboard();
}

function drawScoreboard() {
  if (!match) return;
  const mine = total(match.mine), theirs = total(match.theirs);

  el.meName.textContent = myName();
  el.themName.textContent = match.them;
  el.mePts.textContent = mine;
  el.themPts.textContent = theirs;
  el.sideMe.classList.toggle('lead', mine > theirs);
  el.sideThem.classList.toggle('lead', theirs > mine);

  const round = match.mine[match.round];
  el.meSub.textContent = round
    ? (round.won ? 'solved at ' + round.secs + 's · +' + round.pts : 'missed')
    : S && !S.done ? (S.cfg.steps.length - S.rows.length) + ' tries left' : ' ';

  const tr = match.theirs[match.round];
  el.themSub.textContent = tr
    ? (tr.won ? 'solved at ' + tr.secs + 's · +' + tr.pts : 'missed') +
      (match.readyThem ? ' · ready' : '')
    : match.live ? 'on try ' + (match.live.marks.length + 1) : 'still listening';

  el.mePips.innerHTML = pips(S ? S.rows.map((r) => r.kind) : []);
  el.themPips.innerHTML = pips(match.live?.marks ?? []);
}

/* The only three values that may ever reach that class attribute. `marks` can
   come from the opponent and this string goes through innerHTML, so an
   unfiltered value here was a peer-controlled script injection, closing the
   attribute and the tag to run what followed. Whitelisting is what makes
   that impossible — escaping
   alone would leave the next person to edit this line one mistake away from
   the same bug. Anything unrecognised draws a blank pip. */
const PIP_KINDS = new Set(['right', 'wrong', 'skip']);

const pips = (marks) => Array.from({ length: (match?.insane ? INSANE_CFG : NORMAL_CFG).steps.length },
  (_, i) => '<span class="pip ' + (PIP_KINDS.has(marks?.[i]) ? marks[i] : '') + '"></span>').join('');

function endMatch(why) {
  clearInterval(clockTimer);
  stopClip();
  match?.link?.close();
  match = null;
  el.scoreboard.hidden = true;
  el.roundBar.hidden = true;
  if (why) toast(why);
  if (mode === 'versus') resetLobby();
}

function resetLobby() {
  el.lobby.classList.add('show');
  el.game.hidden = true;
  el.lobbyPick.hidden = false;
  el.lobbyWait.hidden = true;
  el.joinCode.value = '';
  el.joinBtn.disabled = true;
}

// ── modes ──────────────────────────────────────────────────────────────────

function setMode(next) {
  if (mode === 'versus' && next !== 'versus') { match?.link?.send({ t: 'bye' }); endMatch(); }
  mode = next;
  clearInterval(clockTimer);
  stopClip();

  for (const [id, m] of [['modeDaily', 'daily'], ['modeEndless', 'endless'], ['modeInsane', 'insane'], ['modeVersus', 'versus']]) {
    el[id].setAttribute('aria-pressed', String(mode === m));
  }

  if (mode === 'versus') {
    S = null;
    el.scoreboard.hidden = true;
    el.roundBar.hidden = true;
    resetLobby();
    return;
  }

  el.lobby.classList.remove('show');
  el.game.hidden = false;
  el.scoreboard.hidden = true;
  el.roundBar.hidden = true;
  el.guess.placeholder = 'Search by title or artist…';

  if (mode === 'daily') {
    const saved = LS.get('daily', null);
    const idx = dailyIndex(dayNumber());
    const usable = saved && saved.day === dayNumber() && saved.pack === packId && saved.idx === idx;
    beginRound(idx, usable ? saved : null);
    if (S.done) showResult(S.won ? 'Solved today.' : 'Today got away.');
  } else if (mode === 'insane') {
    beginRound(pickInsaneSong(), null, INSANE_CFG);
  } else {
    beginRound(pickEndlessSong());
  }
}

function syncPacks() {
  el.packs.innerHTML = ALL_PACKS.map((p) =>
    '<button class="pill" data-pack="' + p.id + '" aria-pressed="' + (p.id === packId) + '">' +
    escapeHtml(p.name) + ' <span style="opacity:.6">' + p.songs.length + '</span></button>').join('');
  el.packs.hidden = ALL_PACKS.length < 2;
  rebuildTitles();
}

// ── events ─────────────────────────────────────────────────────────────────

el.playBtn.addEventListener('click', playClip);
el.skipBtn.addEventListener('click', skip);
el.submitBtn.addEventListener('click', submit);
el.hintBtn.addEventListener('click', revealHint);
el.guess.addEventListener('input', updateAC);
el.guess.addEventListener('focus', () => { if (el.guess.value) updateAC(); });

el.guess.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); acSel = Math.min(acSel + 1, acList.length - 1); markSel(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); acSel = Math.max(acSel - 1, 0); markSel(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (el.ac.classList.contains('show') && acList[acSel] && norm(el.guess.value) !== acList[acSel].key) pick(acSel);
    else submit();
  } else if (e.key === 'Escape') el.ac.classList.remove('show');
});

el.ac.addEventListener('mousedown', (e) => {
  const d = e.target.closest('[data-n]');
  if (d) { e.preventDefault(); pick(+d.dataset.n); }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchbox')) el.ac.classList.remove('show');
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target !== el.guess && e.target.tagName !== 'INPUT'
      && !document.querySelector('dialog[open]')) { e.preventDefault(); playClip(); }
});

el.modeDaily.addEventListener('click', () => setMode('daily'));
el.modeEndless.addEventListener('click', () => setMode('endless'));
el.modeInsane.addEventListener('click', () => setMode('insane'));
el.modeVersus.addEventListener('click', () => setMode('versus'));

el.packs.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pack]');
  // Only block switching once a match is actually under way. `match` is null
  // before one has been opened or joined — `match?.phase` then reads
  // undefined, which is never 'lobby', so this used to block every pack
  // click made on the 1v1 tab before a match even existed.
  if (!b || (mode === 'versus' && match && match.phase !== 'lobby')) return;
  packId = b.dataset.pack;
  localStorage.setItem('lukeless.pack', packId);
  syncPacks();
  if (mode !== 'versus') setMode(mode);
});

el.nextBtn.addEventListener('click', () => {
  // Stay in whichever of Endless/Insane you're already in — this used to
  // always jump to Endless, which meant finishing an Insane round and
  // hitting "Next song" silently dropped you back into normal mode.
  if (mode === 'endless' || mode === 'insane') { setMode(mode); return; }
  if (mode !== 'versus') return;
  if (match?.phase === 'matchOver') { endMatch(); return; }
  readyUp();
});

el.openBtn.addEventListener('click', openMatch);
el.joinBtn.addEventListener('click', joinMatch);
el.joinCode.addEventListener('input', () => {
  // Tidy a hand-typed code, but leave a pasted invite link intact — stripping
  // it down to five characters would throw the key away.
  if (!/[?&]vs=/.test(el.joinCode.value)) el.joinCode.value = normaliseCode(el.joinCode.value);
  const { code, key } = readInvite(el.joinCode.value);
  el.joinBtn.disabled = code.length < 5;
});
el.joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.joinBtn.disabled) joinMatch(); });
el.cancelBtn.addEventListener('click', () => {
  match?.link?.send({ t: 'bye' });
  endMatch();
});
el.vsName.addEventListener('input', () => { LS.set('name', el.vsName.value); drawScoreboard(); });

function setDifficulty(insane) {
  // Same rule as the pack pills: free to change before a match exists or
  // while still waiting in the lobby, locked the moment a round is live.
  if (match && match.phase !== 'lobby') return;
  vsInsane = insane;
  LS.set('vsInsane', vsInsane);
  syncDifficulty();
}
el.vsNormalBtn.addEventListener('click', () => setDifficulty(false));
el.vsInsaneBtn.addEventListener('click', () => setDifficulty(true));

el.copyLinkBtn.addEventListener('click', () => {
  // The key goes in the link and nowhere else, so this is the whole invite.
  const url = location.origin + location.pathname + '?vs=' + match.code + '&k=' + match.key;
  copy(url, 'Invite link copied');
});

el.shareBtn.addEventListener('click', () => copy(shareText(), 'Result copied'));
el.claudeBtn.addEventListener('click', () => copy(fullReport(), 'Full report copied'));
el.boardShareBtn.addEventListener('click', () => copy(fullReport(), 'Full report copied'));
// These three were inline onclick attributes. They moved here so that
// script-src can stay 'self' with no 'unsafe-inline' — a script-src that
// allows inline code cannot stop an injected <img onerror>, which is exactly
// the shape the pips() bug took.
el.howClose.addEventListener('click', () => howDlg.close());
el.statsClose.addEventListener('click', () => statsDlg.close());
el.boardClose.addEventListener('click', () => boardDlg.close());

el.howBtn.addEventListener('click', () => howDlg.showModal());
el.statsBtn.addEventListener('click', () => { drawStats(); statsDlg.showModal(); });
el.boardBtn.addEventListener('click', () => { drawBoard(); boardDlg.showModal(); });

window.addEventListener('beforeunload', () => match?.link?.send({ t: 'bye' }));

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { toast('Copy failed — select it by hand instead.'); }
}

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  setTimeout(() => el.toast.classList.remove('show'), 2200);
}

// ── maintenance ──────────────────────────────────────────────────────────
//
// The game client is static GitHub Pages; the WebSocket relay is deployed
// separately. This flag restarts the client side: flip it in config.js and
// push (or run ./restart.sh, which waits for both Pages publishes) and every
// open tab notices within one poll and reloads onto the notice below.

const MAINT_POLL_MS = 10000;

/* GitHub Pages serves config.js with its own Cache-Control (max-age=600),
   which serve.json cannot touch — that file only reaches the local `npx
   serve` preview, not the real deploy. The plain <script src="config.js">
   tag in index.html is therefore a normal cached request: if a browser
   fetched it while the flag briefly read true, every load of the page for
   up to ten minutes afterward — including a reload triggered *by this very
   poll* — re-serves that same stale answer. Left as it was, that turns "back
   up" into what looks like an infinite loop: the poll correctly notices the
   server has flipped back, reloads, and the reload immediately re-reads the
   cached true anyway.
 *
 * The fix is that the maintenance decision itself must never trust the
   cached global — window.LUKELESS_CONFIG is fine for ICE/peerServer settings,
   which are not safety-critical and rarely change, but both the boot check
   and the poll's baseline are read fresh here, the same no-store fetch
   either way, so there is exactly one source of truth and it is never the
   one thing the browser is allowed to cache. */
async function readMaintenance() {
  try {
    const text = await fetch('config.js?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.text());
    /* Anchored to the start of a line so the words "maintenance: true" sitting
       in a comment cannot put the site down with no way back. */
    const on = /^\s*maintenance:\s*true\s*,?\s*$/m.test(text);
    const m = text.match(/maintenanceNotice:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/);
    const notice = m ? (m[1] ?? m[2]).replace(/\\(.)/g, '$1') : null;
    const release = text.match(/release:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    const limited = /^\s*limited:\s*true\s*,?\s*$/m.test(text);
    const lm = text.match(/limitedNotice:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/);
    return { on, notice, release, limited, limitedNotice: lm ? (lm[1] ?? lm[2]).replace(/\\(.)/g, '$1') : null };
  } catch {
    // Offline for a moment. Falling back to the cached global is still
    // better than blocking the whole boot on a single failed fetch.
    return {
      on: !!window.LUKELESS_CONFIG?.maintenance,
      notice: window.LUKELESS_CONFIG?.maintenanceNotice,
      release: window.LUKELESS_CONFIG?.release ?? null,
      limited: !!window.LUKELESS_CONFIG?.limited,
      limitedNotice: window.LUKELESS_CONFIG?.limitedNotice ?? null,
    };
  }
}

function reloadFresh(release) {
  const url = new URL(location.href);
  url.searchParams.set('release', release || String(Date.now()));
  location.replace(url);
}

function showMaintenance(notice) {
  stopClip();                       // needs the controls, so it goes before the removal below
  match?.link?.close();
  match = null;

  /* Tear the app down rather than paint over it, so a maintenance state is
     true of the game itself and not just of one div.
   *
   * Treat this as a courtesy to players, never as a control: during an
   * incident the thing that actually stops play is the relay's LOCKDOWN
   * flag, which is enforced server-side. Reach for that one. */
  document.querySelector('.wrap')?.remove();
  audio.pause();
  audio.removeAttribute('src');

  el.maintOverlay.hidden = false;
  el.maintNotice.textContent = notice || 'lukeless is down for a quick update. Back in a few minutes.';
}

function pollMaintenance(was) {
  setInterval(async () => {
    const { on, release } = await readMaintenance();
    if (release && release !== ASSET_RELEASE) { reloadFresh(release); return; }
    if (on !== was) reloadFresh(release);
  }, MAINT_POLL_MS);
}

// ── boot ───────────────────────────────────────────────────────────────────

const maint = await readMaintenance();
if (maint.release && maint.release !== ASSET_RELEASE) {
  reloadFresh(maint.release);
} else if (maint.on) {
  pollMaintenance(maint.on);
  showMaintenance(maint.notice);
} else {
  pollMaintenance(maint.on);

  if (maint.limited) {
    el.limitedBanner.textContent = maint.limitedNotice
      || 'Limited mode — 1v1 is invite-link only.';
    el.limitedBanner.hidden = false;
  }

  el.vsName.value = LS.get('name', '');
  syncPacks();
  syncDifficulty();
  applyVolume();
  drawStats();

  /* ?vs=CODE is an invite. Land straight in the 1v1 tab with the code filled
     in rather than making someone type what they just clicked. */
  const params = new URLSearchParams(location.search);
  const invite = normaliseCode(params.get('vs') ?? '');
  inviteKey = normaliseKey(params.get('k') ?? '');
  if (invite.length === 5) {
    setMode('versus');
    el.joinCode.value = invite;
    el.joinBtn.disabled = false;
    connLine('Ready to join match ' + invite + '.');
  } else {
    setMode('daily');
  }

  if (!LS.get('seen', false)) { howDlg.showModal(); LS.set('seen', true); }
}
