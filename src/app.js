/* lukeless — the game.
 *
 * Three modes over one engine. A round is always the same thing: a song index,
 * a list of guesses, and a clip that grows by one step every time you get it
 * wrong. Daily and Endless differ only in how the index is chosen. 1v1 differs
 * only in that the index arrives from the other browser and the result gets
 * sent back.
 */

import { Versus, makeCode, normaliseCode } from './versus.js';

const STEPS  = [1, 2, 4, 7, 11, 16];
const POINTS = [100, 80, 60, 45, 30, 20];
const HINT_COST = 25;
const MAX = STEPS[STEPS.length - 1];
const EPOCH = Date.UTC(2026, 0, 1);

const VS_ROUNDS = 6;
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
const BUILD = SONGS.length + '.' + SONGS.reduce((h, s) => (h * 31 + s.title.length) % 99991, 7);

let packId = localStorage.getItem('lukeless.pack') ?? ALL_PACKS[0]?.id;
if (!ALL_PACKS.some((p) => p.id === packId)) packId = ALL_PACKS[0]?.id;

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

const stage = () => Math.min(S.rows.length, STEPS.length - 1);
const limit = () => STEPS[stage()];

function scoreOf(st) {
  if (!st?.won) return 0;
  return Math.max(0, (POINTS[st.rows.length - 1] ?? 0) - (st.hint ? HINT_COST : 0));
}
const secsOf = (st) => (st?.won ? STEPS[st.rows.length - 1] : null);

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
  el.time.textContent = '0.0 / ' + (S ? (S.done ? MAX : limit()) : STEPS[0]).toFixed(1) + 's';
}

function playClip() {
  if (!S) return;
  if (playing) { stopClip(); return; }
  const lim = S.done ? MAX : limit();
  audio.currentTime = 0;
  audio.play().then(() => {
    playing = true;
    el.playBtn.textContent = '❚❚';
    playTimer = setTimeout(stopClip, lim * 1000 + 60);
    const tick = () => {
      if (!playing) return;
      const t = Math.min(audio.currentTime, lim);
      el.played.style.width = (t / MAX * 100) + '%';
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
  const order = [...Array(N).keys()], r = rng(cycle * 7919 + 104729 + hashCode(packId));
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return list[order[pos]];
}

const hashCode = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 99991, 0);

function beginRound(idx, restore) {
  S = { idx, rows: [], done: false, won: false, hint: false };
  if (restore) Object.assign(S, restore, { idx });
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

  el.guesses.innerHTML = '';
  for (let i = 0; i < STEPS.length; i++) {
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

  const lim = S.done ? MAX : limit();
  el.unlocked.style.width = (lim / MAX * 100) + '%';
  el.ticks.innerHTML = STEPS.map((s) =>
    '<span class="tick' + (s <= lim ? ' on' : '') + '" style="left:' + (s / MAX * 100) + '%">' + s + 's</span>'
  ).join('');
  el.time.textContent = '0.0 / ' + lim.toFixed(1) + 's';

  const left = STEPS.length - S.rows.length;
  el.status.textContent = S.done ? 'Full 30s preview below'
    : left + (left === 1 ? ' try left' : ' tries left');

  el.skipBtn.textContent = S.rows.length >= STEPS.length - 1
    ? 'Give up' : 'Skip (+' + (STEPS[stage() + 1] - lim) + 's)';

  showHint();
  el.nextBtn.style.display = mode === 'daily' || mode === 'versus' ? 'none' : '';
  el.shareBtn.style.display = mode === 'versus' ? 'none' : '';
  el.reportRow.style.display = mode === 'versus' ? 'none' : '';
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
  if (!S || S.done || S.hint) return;
  S.hint = true;
  showHint();
  saveDaily();
}

// ── autocomplete ───────────────────────────────────────────────────────────

let titles = [], acList = [], acSel = -1, chosen = null;

function rebuildTitles() {
  titles = pool().map((i) => ({ i, title: SONGS[i].title, key: norm(SONGS[i].title) }));
}

function updateAC() {
  const q = norm(el.guess.value);
  chosen = null; el.submitBtn.disabled = true;
  if (!q || !S || S.done) { el.ac.classList.remove('show'); return; }

  const guessed = new Set(S.rows.filter((r) => r.kind !== 'skip').map((r) => norm(r.text)));
  acList = titles.filter((t) => t.key.includes(q) && !guessed.has(t.key))
    .sort((a, b) => a.key.indexOf(q) - b.key.indexOf(q) || a.key.localeCompare(b.key))
    .slice(0, 40);

  if (!acList.length) { el.ac.classList.remove('show'); return; }
  acSel = 0;
  el.ac.innerHTML = acList.map((t, n) =>
    '<div data-n="' + n + '"' + (n === acSel ? ' class="sel"' : '') + '>' + escapeHtml(t.title) +
    '<small>' + escapeHtml(SONGS[t.i].artist) + '</small></div>').join('');
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
  el.guess.value = ''; el.ac.classList.remove('show');
  acList = []; chosen = null; el.submitBtn.disabled = true;
  stopClip();

  if (right) finish(true);
  else if (S.rows.length >= STEPS.length) finish(false);
  else { render(); saveDaily(); pushProgress(); setTimeout(playClip, 220); }
}

function skip() {
  if (!S || S.done) return;
  S.rows.push({ kind: 'skip', text: 'Skipped' });
  stopClip();
  if (S.rows.length >= STEPS.length) finish(false);
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
  LS.set('daily', { day: dayNumber(), pack: packId, idx: S.idx, rows: S.rows, done: S.done, won: S.won, hint: S.hint });
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
  const pad = '⬛'.repeat(Math.max(0, STEPS.length - S.rows.length));
  const label = mode === 'daily' ? 'lukeless #' + dayNumber() : 'lukeless (endless)';
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
      '⬛'.repeat(Math.max(0, STEPS.length - S.rows.length)));
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
  };
}

/* Host picks the songs. Sampling without replacement, so a match never asks
   the same song twice. */
function drawSongs() {
  const list = [...pool()];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list.slice(0, Math.min(VS_ROUNDS, list.length));
}

function connLine(text, bad) {
  el.conn.textContent = text ?? '';
  el.conn.classList.toggle('bad', !!bad);
}

async function openMatch() {
  const code = makeCode();
  match = newMatch(true, code);
  el.codeOut.textContent = code;
  el.lobbyPick.hidden = true;
  el.lobbyWait.hidden = false;
  connLine('Waiting for someone to join…');

  match.link = new Versus({ on: versusHandlers() });
  try { await match.link.host(code); }
  catch (e) { connLine(e.message, true); resetLobby(); }
}

async function joinMatch() {
  const code = normaliseCode(el.joinCode.value);
  if (code.length < 5) { connLine('That code is too short.', true); return; }

  match = newMatch(false, code);
  el.lobbyPick.hidden = true;
  el.lobbyWait.hidden = false;
  el.codeOut.textContent = code;
  connLine('Connecting…');

  match.link = new Versus({ on: versusHandlers() });
  try { await match.link.join(code); }
  catch (e) { connLine(e.message, true); resetLobby(); }
}

function versusHandlers() {
  return {
    open: () => {
      match.link.send({ t: 'hello', name: myName(), build: BUILD, pack: packId });
    },
    message: onVersusMessage,
    close: () => {
      if (!match) return;
      connLine('Your opponent disconnected.', true);
      endMatch('Opponent left.');
    },
    error: (err) => connLine('Connection trouble: ' + (err?.message ?? err?.type ?? 'unknown'), true),
  };
}

function onVersusMessage(msg) {
  if (!match) return;

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
        match.songs = drawSongs();
        match.link.send({ t: 'setup', songs: match.songs, pack: packId, rounds: match.songs.length });
        startVersusRound(0);
        match.link.send({ t: 'start', round: 0 });
      }
      break;
    }

    case 'setup': {
      // The guest plays the host's pack, whatever it had selected.
      if (msg.pack && ALL_PACKS.some((p) => p.id === msg.pack)) { packId = msg.pack; syncPacks(); }
      match.songs = msg.songs ?? [];
      break;
    }

    case 'start':
      startVersusRound(msg.round ?? 0);
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
      if (match.isHost) maybeAdvance();
      else el.nextBtn.textContent = 'Waiting for host…';
      break;

    case 'over':
      showMatchResult();
      break;

    case 'bye':
      endMatch('Opponent left.');
      break;
  }
}

function startVersusRound(n) {
  if (!match || !match.songs.length) return;
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
  el.roundLabel.textContent = 'Round ' + (n + 1) + ' of ' + match.songs.length;

  beginRound(match.songs[n]);
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
        while (S.rows.length < STEPS.length) S.rows.push({ kind: 'skip', text: 'Skipped' });
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
  el.nextBtn.textContent = match.isHost ? 'Waiting for ' + match.them + '…' : 'Waiting for host…';
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
    : S && !S.done ? (STEPS.length - S.rows.length) + ' tries left' : ' ';

  const tr = match.theirs[match.round];
  el.themSub.textContent = tr
    ? (tr.won ? 'solved at ' + tr.secs + 's · +' + tr.pts : 'missed')
    : match.live ? 'on try ' + (match.live.marks.length + 1) : 'still listening';

  el.mePips.innerHTML = pips(S ? S.rows.map((r) => r.kind) : []);
  el.themPips.innerHTML = pips(match.live?.marks ?? []);
}

const pips = (marks) => Array.from({ length: STEPS.length },
  (_, i) => '<span class="pip ' + (marks[i] ?? '') + '"></span>').join('');

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

  for (const [id, m] of [['modeDaily', 'daily'], ['modeEndless', 'endless'], ['modeVersus', 'versus']]) {
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

  if (mode === 'daily') {
    const saved = LS.get('daily', null);
    const idx = dailyIndex(dayNumber());
    const usable = saved && saved.day === dayNumber() && saved.pack === packId && saved.idx === idx;
    beginRound(idx, usable ? saved : null);
    if (S.done) showResult(S.won ? 'Solved today.' : 'Today got away.');
  } else {
    const list = pool();
    beginRound(list[Math.floor(Math.random() * list.length)]);
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
el.modeVersus.addEventListener('click', () => setMode('versus'));

el.packs.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pack]');
  if (!b || (mode === 'versus' && match?.phase !== 'lobby')) return;
  packId = b.dataset.pack;
  localStorage.setItem('lukeless.pack', packId);
  syncPacks();
  if (mode !== 'versus') setMode(mode);
});

el.nextBtn.addEventListener('click', () => {
  if (mode !== 'versus') { setMode('endless'); return; }
  if (match?.phase === 'matchOver') { endMatch(); return; }
  readyUp();
});

el.openBtn.addEventListener('click', openMatch);
el.joinBtn.addEventListener('click', joinMatch);
el.joinCode.addEventListener('input', () => {
  el.joinCode.value = normaliseCode(el.joinCode.value);
  el.joinBtn.disabled = el.joinCode.value.length < 5;
});
el.joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.joinBtn.disabled) joinMatch(); });
el.cancelBtn.addEventListener('click', () => endMatch());
el.vsName.addEventListener('input', () => { LS.set('name', el.vsName.value); drawScoreboard(); });

el.copyLinkBtn.addEventListener('click', () => {
  const url = location.origin + location.pathname + '?vs=' + match.code;
  copy(url, 'Invite link copied');
});

el.shareBtn.addEventListener('click', () => copy(shareText(), 'Result copied'));
el.claudeBtn.addEventListener('click', () => copy(fullReport(), 'Full report copied'));
el.boardShareBtn.addEventListener('click', () => copy(fullReport(), 'Full report copied'));
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

// ── boot ───────────────────────────────────────────────────────────────────

el.vsName.value = LS.get('name', '');
syncPacks();
applyVolume();
drawStats();

/* ?vs=CODE is an invite. Land straight in the 1v1 tab with the code filled in
   rather than making someone type what they just clicked. */
const invite = normaliseCode(new URLSearchParams(location.search).get('vs') ?? '');
if (invite.length === 5) {
  setMode('versus');
  el.joinCode.value = invite;
  el.joinBtn.disabled = false;
  connLine('Ready to join match ' + invite + '.');
} else {
  setMode('daily');
}

if (!LS.get('seen', false)) { howDlg.showModal(); LS.set('seen', true); }
