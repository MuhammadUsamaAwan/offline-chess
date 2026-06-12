import { Chess } from 'chess.js';
import { Engine } from './engine.js';
import { Board } from './board.js';
import openings from './openings.json';
import { Sounds } from './sounds.js';
import './style.css';

// ---------- State ----------
const game = new Chess();
const engine = new Engine('./engine/stockfish.js');
const sounds = new Sounds();

const state = {
  mode: 'ai',        // 'ai' | 'human'
  elo: 1500,
  humanSide: 'w',    // which color the human plays in AI mode
  pauseAi: false,    // AI mode: let the human move both sides to explore lines
  analysisOn: true,
  showBestMove: false,
  showThreats: false,
  showCheckable: false,
  showPinned: false,
  showForks: false,
  showSkewers: false,
  annotateOn: true,
  showAccuracy: true,
  depth: 15,
  thinking: false,
};

const history = []; // [{ san, color, from, to, uci, annotation, fen, opening }]
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let analysisAbort = null;
let viewPly = 0; // which ply the board is currently showing (history.length === live)
// Latest engine lines and the FEN they were computed at, so the "Best lines"
// panel can preview a variation on the board without touching game/history.
let currentLines = [];
let analyzedFen = START_FEN;
let previewing = false;
// True when the board shows the live position and a human is on move — the
// only time live analysis / best-move arrows should be computed.
function atLiveHuman() {
  return viewPly >= history.length && !state.thinking
    && !game.isGameOver() && isHumanTurn();
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const board = new Board($('board'), { onMove: handleHumanMove });

// ---------- Engine status ----------
engine.whenReady().then(() => {
  $('engine-status').textContent = 'engine: ready';
  $('engine-status').classList.add('ok');
  startGame();
});

// ---------- Game flow ----------
function startGame() {
  engine.newGame(); // reset engine hash/history for a genuinely new game
  game.reset();
  history.length = 0;
  board.setLastMove(null);
  board.drawArrow(null);
  $('result-banner').classList.add('hidden');
  $('review-summary').classList.add('hidden');
  evalCache.clear();
  board.setOrientation(state.mode === 'ai' ? state.humanSide : 'w');
  refreshAll();
  maybeEngineTurn();
}

// Import a game from pasted/dropped text. Full PGN (with header tags, comments
// or NAGs) is parsed by chess.js for robustness; anything else falls through to
// the lenient move-list parser below. Returns an error message, or null on
// success.
function importGame(text) {
  const raw = (text || '').trim();
  if (!raw) return 'Nothing to import.';

  const looksPgn = /\[\s*\w+\s+"/.test(raw) || /\{[^}]*\}/.test(raw) || /\$\d+/.test(raw);
  if (!looksPgn) return loadMoves(raw);

  const probe = new Chess();
  try {
    probe.loadPgn(raw);
  } catch (e) {
    return `Couldn't parse PGN: ${e.message || 'invalid format'}.`;
  }
  const headers = probe.getHeaders();
  if (headers.FEN || headers.SetUp) {
    return "PGN starts from a custom position, which isn't supported yet.";
  }
  const moves = probe.history({ verbose: true });
  if (!moves.length) return 'PGN contained no moves.';

  if (analysisAbort) analysisAbort.abort();
  engine.newGame();
  game.reset();
  history.length = 0;
  evalCache.clear();
  for (const mv of moves) {
    appendHistory(game.move({ from: mv.from, to: mv.to, promotion: mv.promotion }));
  }
  finishImport();
  return null;
}

// Build a PGN string for the current game, stamping a few standard header tags
// (chess.js appends the result token automatically when the game is over).
function buildPgn() {
  game.setHeader('Event', 'Offline Chess Analyzer');
  game.setHeader('Site', 'offline');
  game.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
  if (state.mode === 'ai') {
    const ai = `Stockfish (${state.elo})`;
    game.setHeader(state.humanSide === 'w' ? 'Black' : 'White', ai);
    game.setHeader(state.humanSide === 'w' ? 'White' : 'Black', 'Human');
  }
  return game.pgn({ maxWidth: 80 });
}

// Import a sequence of moves pasted as SAN/PGN text, e.g.
// "1. d4 g6 2. Bf4 d6 3. Nf3 Bg7 4. c3". Strips move numbers, comments,
// variations, NAGs and the result token, then replays the moves from the
// start, rebuilding history. Returns an error message, or null on success.
function loadMoves(text) {
  const tokens = text
    .replace(/\{[^}]*\}/g, ' ')                 // { comments }
    .replace(/\([^)]*\)/g, ' ')                 // ( variations )
    .replace(/\$\d+/g, ' ')                     // $ NAGs
    .replace(/\b\d+\.(\.\.)?/g, ' ')            // move numbers: 1. or 1...
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, ' ')// result
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return 'No moves found.';

  if (analysisAbort) analysisAbort.abort();
  engine.newGame();
  game.reset();
  history.length = 0;
  evalCache.clear();

  for (let i = 0; i < tokens.length; i++) {
    let move;
    try { move = game.move(tokens[i]); } catch { move = null; }
    if (!move) {
      // Keep what loaded so far, but report where it broke.
      finishImport();
      return `Stopped at illegal move "${tokens[i]}" (loaded ${history.length}).`;
    }
    appendHistory(move);
  }
  finishImport();
  return null;
}

// Snap UI to the imported position and resume the engine, mirroring startGame.
function finishImport() {
  board.setLastMove(history.length ? lastMoveOf(history.length - 1) : null);
  board.drawArrow(null);
  $('result-banner').classList.add('hidden');
  $('review-summary').classList.add('hidden');
  refreshAll();
  if (game.isGameOver()) { showResult(); scheduleReview(); return; }
  maybeEngineTurn();
  scheduleReview();
}

function handleHumanMove({ from, to, promotion }) {
  if (state.thinking) return;
  // Playing from a reviewed (past) position deviates from the game: discard the
  // moves that came after it and continue as a new line from here. chess.js's
  // own history is rewound in step so PGN export stays correct.
  if (history.length > viewPly) {
    while (history.length > viewPly) { game.undo(); history.pop(); }
    $('result-banner').classList.add('hidden'); // any earlier game-over no longer applies
  }
  const prevFen = game.fen();
  const move = game.move({ from, to, promotion: promotion || 'q' });
  if (!move) return;
  recordMove(move, prevFen);
}

// Append one applied move to `history`, deriving its opening name. Shared by
// live play (recordMove) and bulk import (loadMoves).
function appendHistory(move) {
  const ply = history.length;
  history.push({
    san: move.san,
    color: move.color,
    from: move.from,
    to: move.to,
    uci: move.from + move.to + (move.promotion || ''),
    annotation: null,
    fen: game.fen(),
  });
  // Opening: use the entry whose mainline ends at this position, otherwise
  // carry forward the previous move's opening so it persists out of book.
  const matched = openingAt(game.fen());
  history[ply].opening = matched || history[ply - 1]?.opening || null;
}

function recordMove(move, prevFen) {
  appendHistory(move);
  board.setLastMove(move);
  board.drawArrow(null);
  refreshAll();
  playMoveSound(move);

  if (game.isGameOver()) {
    showResult();
    scheduleReview();
    return;
  }

  // Dispatch the engine's next job (AI reply or live analysis) before the
  // background review so the opponent responds promptly.
  maybeEngineTurn();
  scheduleReview();
}

function isHumanTurn() {
  if (state.mode === 'human' || state.pauseAi) return true;
  return game.turn() === state.humanSide;
}

async function maybeEngineTurn() {
  if (game.isGameOver()) return;
  if (state.mode === 'ai' && !isHumanTurn()) {
    await aiMove();
  } else {
    startLiveAnalysis();
  }
}

async function aiMove() {
  state.thinking = true;
  board.setInteractive(false);
  setTurnText('AI is thinking…');
  const fen = game.fen();
  try {
    const uci = await engine.bestMove(fen, { elo: state.elo });
    if (game.fen() !== fen) return; // position changed (new game / deviation)
    const prevFen = fen;
    const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    state.thinking = false;
    board.setInteractive(true);
    if (move) recordMove(move, prevFen);
  } catch (e) {
    state.thinking = false;
    board.setInteractive(true);
    console.error(e);
  }
}

// ---------- Live analysis ----------
// Runs the engine if EITHER the analysis panel or the best-move arrow is
// wanted; each output is rendered according to its own toggle, so the two
// settings are fully independent.
function startLiveAnalysis() {
  if (analysisAbort) analysisAbort.abort();
  if (!state.showBestMove) board.drawArrow(null);
  if (!state.analysisOn) renderLines([]);

  if ((!state.analysisOn && !state.showBestMove) || game.isGameOver()) return;

  analysisAbort = new AbortController();
  const fen = game.fen();
  const multipv = state.analysisOn ? 3 : 1; // only need 1 line for the arrow
  if (state.analysisOn) renderLines([], { loading: true });

  engine
    .analyze(fen, { depth: state.depth, multipv, signal: analysisAbort.signal }, (lines) => {
      if (game.fen() === fen && state.analysisOn) renderLines(lines);
    })
    .then((res) => {
      if (res.aborted || game.fen() !== fen) return;
      // Reuse this eval for move ratings / accuracy instead of recomputing it.
      if (res.lines[0]) evalCache.set(fen, { cp: cpFromInfo(res.lines[0]), bestmove: res.lines[0].pv?.[0] });
      if (state.analysisOn) renderLines(res.lines);
      if (state.showBestMove && res.lines[0]?.pv?.[0]) {
        const u = res.lines[0].pv[0];
        board.drawArrow({ from: u.slice(0, 2), to: u.slice(2, 4) });
      } else if (!state.showBestMove) {
        board.drawArrow(null);
      }
    })
    .catch(() => {});
}

function classify(cpLoss, isBest) {
  if (isBest) return { tag: 'Best', sym: '★', cls: 'best' };
  if (cpLoss <= 20) return { tag: 'Excellent', sym: '!', cls: 'excellent' };
  if (cpLoss <= 50) return { tag: 'Good', sym: '', cls: 'good' };
  if (cpLoss <= 100) return { tag: 'Inaccuracy', sym: '?!', cls: 'inaccuracy' };
  if (cpLoss <= 250) return { tag: 'Mistake', sym: '?', cls: 'mistake' };
  return { tag: 'Blunder', sym: '??', cls: 'blunder' };
}

// ---------- Move review / accuracy ----------
// Each position is evaluated once and cached by FEN, so as the game grows only
// the new position costs an engine eval. This powers both the per-move ratings
// and the accuracy summary, and refreshes automatically after every move.
const evalCache = new Map(); // fen -> { cp (side-to-move perspective), bestmove }
let reviewToken = 0;

async function evalPosition(fen) {
  if (evalCache.has(fen)) return evalCache.get(fen);
  const res = await engine.analyze(fen, { depth: state.depth, multipv: 1 });
  const v = { cp: res.lines[0] ? cpFromInfo(res.lines[0]) : 0, bestmove: res.bestmove };
  evalCache.set(fen, v);
  return v;
}

// Run when ratings or the accuracy summary are wanted. Computes annotations for
// the whole game and (if enabled) the per-side accuracy. Safe to call often.
function scheduleReview() {
  if (state.annotateOn || state.showAccuracy) updateReview();
}

async function updateReview() {
  const box = $('review-summary');
  if (!history.length) { box.classList.add('hidden'); return; }
  const token = ++reviewToken;

  const fens = [START_FEN, ...history.map((h) => h.fen)];
  const evals = [];
  for (let i = 0; i < fens.length; i++) {
    if (state.showAccuracy && !evalCache.has(fens[i])) {
      box.classList.remove('hidden');
      box.innerHTML = `<div class="rev-title">Analyzing… ${i}/${fens.length}</div>`;
    }
    const v = await evalPosition(fens[i]);
    if (token !== reviewToken) return; // superseded by a newer review
    evals.push(v);
  }

  const acc = { w: [], b: [] };
  const counts = { w: {}, b: {} };
  for (let k = 0; k < history.length; k++) {
    const mover = history[k].color;
    const bestEval = evals[k].cp;        // best play, mover perspective
    const afterEval = -evals[k + 1].cp;  // after the move, mover perspective
    const ann = classify(Math.max(0, bestEval - afterEval), history[k].uci === evals[k].bestmove);
    history[k].annotation = ann;
    counts[mover][ann.tag] = (counts[mover][ann.tag] || 0) + 1;
    acc[mover].push(moveAccuracy(bestEval, afterEval));
  }

  renderMoveList();
  highlightActiveMove();
  if (state.showAccuracy) showReviewSummary(acc, counts);
  else box.classList.add('hidden');
}

function winPct(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
function moveAccuracy(beforeCp, afterCp) {
  const a = 103.1668 * Math.exp(-0.04354 * (winPct(beforeCp) - winPct(afterCp))) - 3.1669;
  return Math.max(0, Math.min(100, a));
}
function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}

const SUMMARY_TAGS = [
  { tag: 'Best', sym: '★', cls: 'best' },
  { tag: 'Excellent', sym: '!', cls: 'excellent' },
  { tag: 'Good', sym: '✓', cls: 'good' },
  { tag: 'Inaccuracy', sym: '?!', cls: 'inaccuracy' },
  { tag: 'Mistake', sym: '?', cls: 'mistake' },
  { tag: 'Blunder', sym: '??', cls: 'blunder' },
];

function showReviewSummary(acc, counts) {
  const box = $('review-summary');
  const row = (label, color) => {
    const a = mean(acc[color]);
    const chips = SUMMARY_TAGS
      .filter((t) => counts[color][t.tag])
      .map((t) => `<span class="rc ${t.cls}">${t.sym || '✓'} ${counts[color][t.tag]}</span>`)
      .join('');
    return `<div class="rev-row"><span class="rev-side">${label}</span>
      <span class="rev-acc">${a == null ? '—' : a.toFixed(1) + '%'}</span>
      <span class="rev-chips">${chips || '—'}</span></div>`;
  };
  box.innerHTML = `<div class="rev-title">Accuracy</div>${row('White', 'w')}${row('Black', 'b')}`;
  box.classList.remove('hidden');
}

// ---------- Rendering ----------
// Called whenever the game itself changes (move / deviation / new game): snap the
// view to the live position and redraw everything.
function refreshAll() {
  viewPly = history.length;
  renderMoveList();
  renderBoardForView();
  updateEvalBarFromTurn();
  updateOpening();
}

function lastMoveOf(i) {
  return { from: history[i].from, to: history[i].to };
}

// Render the board for the currently viewed ply (live or a past position).
function renderBoardForView() {
  const atLive = viewPly >= history.length;
  const g = atLive ? game : new Chess(viewPly === 0 ? START_FEN : history[viewPly - 1].fen);
  board.setThreats(state.showThreats ? hangingSquares(g) : []);
  board.setPinned(state.showPinned ? pinnedSquares(g) : []);
  board.setCheckable(state.showCheckable ? checkableKingSquares(g) : []);
  board.setForks(state.showForks ? forkSquares(g) : []);
  board.setSkewers(state.showSkewers ? skewerSquares(g) : []);
  if (atLive) {
    board.setInteractive(!state.thinking);
    board.setLastMove(history.length ? lastMoveOf(history.length - 1) : null);
  } else {
    // Let the human play from here to deviate into a new line. The board only
    // allows moving the side to move, so gate interactivity on whose turn it is.
    const humanCanMove = state.mode === 'human' || state.pauseAi || g.turn() === state.humanSide;
    board.setInteractive(humanCanMove && !state.thinking);
    board.setLastMove(viewPly > 0 ? lastMoveOf(viewPly - 1) : null);
    analyzeReviewPosition(g.fen(), g.turn());
  }
  board.render(g);
  updateCaptured(g);
  if (atLive) updateTurnIndicator();
  else {
    const canPlay = state.mode === 'human' || state.pauseAi || g.turn() === state.humanSide;
    const hint = canPlay ? 'play a move to branch, or → / End to resume' : '→ or End to resume';
    setTurnText(`Reviewing ${viewPly}/${history.length} — ${hint}`);
  }
  highlightActiveMove();
  renderExplorer();
  updateNavButtons();
}

// Reflect navigability: disable Back/First at the start, Forward/Last at live.
function updateNavButtons() {
  const atStart = viewPly === 0;
  const atLive = viewPly >= history.length;
  $('nav-first').disabled = atStart;
  $('nav-prev').disabled = atStart;
  $('nav-next').disabled = atLive;
  $('nav-last').disabled = atLive;
}

// Analyze a reviewed (past) position: refresh the "Best lines" panel and the
// best-move arrow for the position now on the board. A token guards against
// rapid stepping so a slow engine result never lands on a position the user has
// already left; the previous request is aborted so the queue stays responsive.
let reviewAnalysisAbort = null;
let reviewViewToken = 0;
const linesCache = new Map(); // fen -> sorted engine lines (multipv 3), for review
function analyzeReviewPosition(fen, turn) {
  reviewViewToken++;
  const token = reviewViewToken;
  if (reviewAnalysisAbort) { reviewAnalysisAbort.abort(); reviewAnalysisAbort = null; }

  const drawUci = (u) => {
    if (token === reviewViewToken && state.showBestMove) {
      board.drawArrow(u ? { from: u.slice(0, 2), to: u.slice(2, 4) } : null);
    }
  };
  if (!state.showBestMove) board.drawArrow(null);
  if (!state.analysisOn && !state.showBestMove) return; // nothing to show

  // Already analyzed this position (e.g. stepping back to it, or ending a line
  // preview): render straight from cache with no engine round-trip.
  const cachedLines = linesCache.get(fen);
  if (cachedLines) {
    if (state.analysisOn) renderLines(cachedLines, { fen, turn });
    drawUci(cachedLines[0]?.pv?.[0]);
    return;
  }
  // Arrow only (panel hidden) and we already have this eval: draw it instantly.
  const cached = evalCache.get(fen);
  if (!state.analysisOn && cached?.bestmove) { drawUci(cached.bestmove); return; }

  if (state.analysisOn) renderLines([], { loading: true, fen, turn });
  if (state.showBestMove) board.drawArrow(null); // clear stale arrow while working

  reviewAnalysisAbort = new AbortController();
  engine
    .analyze(
      fen,
      { depth: state.depth, multipv: state.analysisOn ? 3 : 1, signal: reviewAnalysisAbort.signal },
      (lines) => {
        if (token === reviewViewToken && state.analysisOn) renderLines(lines, { fen, turn });
      }
    )
    .then((res) => {
      if (res.aborted || token !== reviewViewToken) return;
      if (res.lines[0]) evalCache.set(fen, { cp: cpFromInfo(res.lines[0]), bestmove: res.lines[0].pv?.[0] });
      if (state.analysisOn && res.lines.length) linesCache.set(fen, res.lines);
      if (state.analysisOn) renderLines(res.lines, { fen, turn });
      drawUci(res.lines[0]?.pv?.[0]);
    })
    .catch(() => {});
}

// ---------- Captured pieces / material ----------
// Counts the pieces each side has lost (relative to the starting array) and the
// net material difference, then renders a tray of captured pieces above and
// below the board with a "+N" badge on whichever side is ahead. Promotions can
// make a missing-count clamp to zero, but the material badge stays accurate
// because it sums the values actually on the board.
const START_COUNT = { q: 1, r: 2, b: 2, n: 2, p: 8 };
const PIECE_VAL = { q: 9, r: 5, b: 3, n: 3, p: 1 };
const CAP_ORDER = ['q', 'r', 'b', 'n', 'p']; // most to least valuable
const CAP_GLYPHS = {
  w: { q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

function updateCaptured(g) {
  const onBoard = { w: {}, b: {} };
  for (const c of ['w', 'b']) for (const t of CAP_ORDER) onBoard[c][t] = 0;
  let diff = 0; // material from White's perspective (+ = White ahead)
  for (const row of g.board()) {
    for (const sq of row) {
      if (!sq || sq.type === 'k') continue;
      onBoard[sq.color][sq.type]++;
      diff += (sq.color === 'w' ? 1 : -1) * PIECE_VAL[sq.type];
    }
  }
  const missing = { w: {}, b: {} };
  for (const c of ['w', 'b']) for (const t of CAP_ORDER) {
    missing[c][t] = Math.max(0, START_COUNT[t] - onBoard[c][t]);
  }

  // A player's tray shows the opponent pieces they have captured, plus a "+N"
  // badge when that player is ahead on material.
  const trayHtml = (playerColor) => {
    const lost = playerColor === 'w' ? 'b' : 'w'; // opponent's missing pieces
    let html = '';
    for (const t of CAP_ORDER) {
      for (let i = 0; i < missing[lost][t]; i++) {
        html += `<span class="cap-pc cap-${lost}">${CAP_GLYPHS[lost][t]}</span>`;
      }
    }
    const adv = playerColor === 'w' ? diff : -diff;
    if (adv > 0) html += `<span class="cap-adv">+${adv}</span>`;
    return html;
  };

  const bottom = board.orientation;            // color shown at the bottom
  const top = bottom === 'w' ? 'b' : 'w';
  $('captured-top').innerHTML = trayHtml(top);
  $('captured-bottom').innerHTML = trayHtml(bottom);
}

// ---------- Threats / hanging pieces ----------
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const SEE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

// Squares holding a piece that the opposing side can win material by capturing
// (static exchange evaluation > 0). Covers both colors: your hanging pieces and
// the opponent's. Pure board math — no engine needed.
function hangingSquares(g) {
  const out = [];
  const b = g.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      if (!b[r][f]) continue;
      const sq = FILES[f] + (8 - r);
      if (seeOnSquare(g, sq) > 0) out.push(sq);
    }
  }
  return out;
}

// Static Exchange Evaluation: material the attacking side gains by initiating
// captures on `sq` (ignores x-ray/pins/promotions — good enough for a hint).
function seeOnSquare(g, sq) {
  const target = g.get(sq);
  if (!target || target.type === 'k') return 0;
  const enemy = target.color === 'w' ? 'b' : 'w';
  const atk = g.attackers(sq, enemy).map((s) => SEE_VAL[g.get(s).type]).sort((a, b) => a - b);
  if (atk.length === 0) return 0;
  const def = g.attackers(sq, target.color).map((s) => SEE_VAL[g.get(s).type]).sort((a, b) => a - b);

  // Interleave the least-valuable capturer of each side, enemy capturing first.
  const caps = [];
  let ai = 0, di = 0, side = 0;
  while (side === 0 ? ai < atk.length : di < def.length) {
    caps.push(side === 0 ? atk[ai++] : def[di++]);
    side ^= 1;
  }
  const gain = [SEE_VAL[target.type]];
  for (let d = 1; d <= caps.length; d++) gain[d] = caps[d - 1] - gain[d - 1];
  for (let d = caps.length - 1; d >= 1; d--) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
  return gain[0];
}

// Squares of kings that the opposing side could put in check with a single move.
// Tries both colors regardless of whose turn it is by swapping the FEN side-to-move.
function checkableKingSquares(g) {
  const out = [];
  for (const kingColor of ['w', 'b']) {
    const enemy = kingColor === 'w' ? 'b' : 'w';
    const probe = chessWithTurn(g, enemy);
    if (!probe) continue;
    const moves = probe.moves({ verbose: true });
    if (moves.some((m) => m.san.includes('+') || m.san.includes('#'))) {
      const ksq = findKing(probe, kingColor);
      if (ksq) out.push(ksq);
    }
  }
  return out;
}

// Squares of pinned pieces (absolute and relative): walk every enemy slider's
// 8 rays; the first piece on the ray is the pin candidate, and if the next piece
// behind it on the same ray is a more valuable friend (or the king), the
// candidate is pinned — moving it loses the piece behind.
function pinnedSquares(g) {
  const out = new Set();
  const DIRS = [
    { df: 1, dr: 0, slider: 'r' }, { df: -1, dr: 0, slider: 'r' },
    { df: 0, dr: 1, slider: 'r' }, { df: 0, dr: -1, slider: 'r' },
    { df: 1, dr: 1, slider: 'b' }, { df: 1, dr: -1, slider: 'b' },
    { df: -1, dr: 1, slider: 'b' }, { df: -1, dr: -1, slider: 'b' },
  ];
  const b = g.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sl = b[r][f];
      if (!sl) continue;
      if (sl.type !== 'q' && sl.type !== 'r' && sl.type !== 'b') continue;
      const victim = sl.color === 'w' ? 'b' : 'w';
      for (const { df, dr, slider } of DIRS) {
        if (sl.type !== 'q' && sl.type !== slider) continue;
        let x = f + df, y = r - dr;
        let candidate = null;
        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
          const p = b[y][x];
          if (p) {
            if (!candidate) {
              if (p.color !== victim) break;
              candidate = { sq: FILES[x] + (8 - y), val: SEE_VAL[p.type] };
            } else {
              if (p.color === victim && (p.type === 'k' || SEE_VAL[p.type] > candidate.val)) {
                out.add(candidate.sq);
              }
              break;
            }
          }
          x += df; y -= dr;
        }
      }
    }
  }
  return [...out];
}

function findKing(g, color) {
  const b = g.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = b[r][f];
      if (p && p.type === 'k' && p.color === color) return FILES[f] + (8 - r);
    }
  }
  return null;
}

// Return a Chess at the same position but with side-to-move forced to `turn`.
// If the resulting FEN is illegal (e.g. side-not-to-move already in check), bail.
function chessWithTurn(g, turn) {
  if (g.turn() === turn) return g;
  const parts = g.fen().split(' ');
  parts[1] = turn;
  parts[3] = '-'; // clear en passant — it belonged to the other side's move
  try { return new Chess(parts.join(' ')); } catch { return null; }
}

// Squares of pieces currently delivering a fork: a single piece attacking two or
// more enemy pieces where at least one target is the king or a piece more
// valuable than the attacker (i.e. an unavoidable material/check gain).
function forkSquares(g) {
  const out = [];
  const b = g.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = b[r][f];
      if (!p) continue;
      const sq = FILES[f] + (8 - r);
      const enemy = p.color === 'w' ? 'b' : 'w';
      const myVal = SEE_VAL[p.type];
      let hits = 0, gainful = false;
      for (let rr = 0; rr < 8; rr++) {
        for (let ff = 0; ff < 8; ff++) {
          const t = b[rr][ff];
          if (!t || t.color !== enemy) continue;
          const tsq = FILES[ff] + (8 - rr);
          if (g.attackers(tsq, p.color).includes(sq)) {
            hits++;
            if (t.type === 'k' || SEE_VAL[t.type] > myVal) gainful = true;
          }
        }
      }
      if (hits >= 2 && gainful) out.push(sq);
    }
  }
  return out;
}

// Squares involved in a skewer: an enemy slider attacks one of our pieces, and
// directly behind it on the same ray sits another of our pieces of equal-or-
// lesser value. Mark both pieces.
function skewerSquares(g) {
  const out = new Set();
  const DIRS = [
    { df: 1, dr: 0, slider: 'r' }, { df: -1, dr: 0, slider: 'r' },
    { df: 0, dr: 1, slider: 'r' }, { df: 0, dr: -1, slider: 'r' },
    { df: 1, dr: 1, slider: 'b' }, { df: 1, dr: -1, slider: 'b' },
    { df: -1, dr: 1, slider: 'b' }, { df: -1, dr: -1, slider: 'b' },
  ];
  const b = g.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sl = b[r][f];
      if (!sl) continue;
      const slType = sl.type;
      if (slType !== 'q' && slType !== 'r' && slType !== 'b') continue;
      const victim = sl.color === 'w' ? 'b' : 'w';
      const sx = f, sy = r;
      for (const { df, dr, slider } of DIRS) {
        if (slType !== 'q' && slType !== slider) continue;
        let x = sx + df, y = sy - dr; // dr in rank-up; board rows count down
        let front = null;
        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
          const p = b[y][x];
          if (p) {
            if (!front) {
              if (p.color !== victim) break;
              front = { sq: FILES[x] + (8 - y), val: SEE_VAL[p.type] };
            } else {
              if (p.color === victim && p.type !== 'k' && front.val > SEE_VAL[p.type]) {
                out.add(front.sq);
                out.add(FILES[x] + (8 - y));
              }
              break;
            }
          }
          x += df; y -= dr;
        }
      }
    }
  }
  return [...out];
}

// Step to a specific ply and, when resuming the live position, restart analysis.
function goToPly(p) {
  const target = Math.max(0, Math.min(history.length, p));
  if (target === viewPly) return;
  previewing = false; // navigation supersedes any hovered preview
  viewPly = target;
  renderBoardForView();
  if (atLiveHuman()) startLiveAnalysis();
}

function highlightActiveMove() {
  const box = $('movelist');
  box.querySelectorAll('.mv.active').forEach((el) => el.classList.remove('active'));
  if (viewPly > 0) {
    const el = box.querySelector(`.mv[data-ply="${viewPly - 1}"]`);
    if (el) {
      el.classList.add('active');
      const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
      box.scrollTop = Math.max(0, top);
    }
  }
}

function playMoveSound(move) {
  if (game.isGameOver()) return sounds.gameEnd();
  if (game.inCheck()) return sounds.check();
  const f = move.flags || '';
  if (f.includes('k') || f.includes('q')) return sounds.castle();
  if (f.includes('p')) return sounds.promote();
  if (move.captured || f.includes('c') || f.includes('e')) return sounds.capture();
  return sounds.move();
}

// The opening entry ({ eco, name, pgn }) whose mainline ends at `fen`, or null.
function openingAt(fen) {
  const i = openings.byEpd[fenKey(fen)];
  return i == null ? null : openings.entries[i];
}

function renderOpening(op) {
  const el = $('opening');
  if (!op) {
    el.innerHTML = '<span class="opening-name">Starting position</span>';
  } else {
    el.innerHTML = '';
    const code = document.createElement('span');
    code.className = 'eco-code';
    code.textContent = op.eco;
    const name = document.createElement('span');
    name.className = 'opening-name';
    name.textContent = op.name;
    el.append(code, name);
  }
}

function updateOpening() {
  renderOpening(history.at(-1)?.opening);
}

// Opening at `fen` after walking `pv` plies; carries forward when out of book.
function openingAfterPv(fen, pv, depth) {
  const baseIdx = history.findIndex((h) => h.fen === fen);
  let op = baseIdx >= 0 ? history[baseIdx].opening : openingAt(fen);
  const g = new Chess(fen);
  for (let i = 0; i < depth && i < pv.length; i++) {
    const u = pv[i];
    const mv = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || undefined });
    if (!mv) break;
    op = openingAt(g.fen()) || op;
  }
  return op;
}

// FEN reduced to the fields that define a position for opening lookup.
function fenKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

// Full FEN of the position currently on the board (live or while reviewing).
function viewedFen() {
  return viewPly === 0 ? START_FEN : history[viewPly - 1].fen;
}

// ---------- Opening explorer & search ----------
// The explorer panel shows, for the viewed position, the legal moves that lead
// into a named opening (transposition-aware via byEpd). Typing in the search
// box replaces that list with matching openings that load onto the board.
const explorerEl = $('explorer-list');
const searchEl = $('opening-search');

function renderExplorer() {
  if (searchEl.value.trim()) return; // search results own the list while typing
  const g = new Chess(viewedFen());
  const num = Math.floor(viewPly / 2) + 1;
  const prefix = g.turn() === 'w' ? `${num}.` : `${num}…`;
  const seen = new Set();
  const kids = [];
  for (const m of g.moves({ verbose: true })) {
    g.move(m);
    const op = openingAt(g.fen());
    g.undo();
    if (op && !seen.has(m.san)) { seen.add(m.san); kids.push({ san: m.san, op }); }
  }
  if (!kids.length) {
    explorerEl.innerHTML = '<li class="explorer-empty">No book moves from here.</li>';
    return;
  }
  explorerEl.innerHTML = kids
    .map(({ san, op }) =>
      `<li class="explorer-item" data-san="${san}">` +
        `<span class="ex-move">${prefix}${san}</span>` +
        `<span class="ex-name"><span class="eco-code">${op.eco}</span>${escapeHtml(op.name)}</span>` +
      `</li>`)
    .join('');
}

function renderSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) { renderExplorer(); return; }
  const hits = [];
  for (let i = 0; i < openings.entries.length && hits.length < 60; i++) {
    const e = openings.entries[i];
    if (e.name.toLowerCase().includes(q) || e.eco.toLowerCase().includes(q)) hits.push(i);
  }
  explorerEl.innerHTML = hits.length
    ? hits.map((i) => {
        const e = openings.entries[i];
        return `<li class="explorer-item search-hit" data-entry="${i}">` +
          `<span class="ex-name"><span class="eco-code">${e.eco}</span>${escapeHtml(e.name)}</span>` +
        `</li>`;
      }).join('')
    : '<li class="explorer-empty">No matching openings.</li>';
}

// Play a book continuation from the viewed position, discarding any later moves.
function playExplorerMove(san) {
  if (state.thinking) return;
  // Discard moves after the viewed ply, keeping chess.js's own history in sync
  // (via undo) so PGN export stays correct — same as deviating with a board move.
  while (history.length > viewPly) { game.undo(); history.pop(); }
  const prevFen = game.fen();
  let move;
  try { move = game.move(san); } catch { move = null; }
  if (!move) return;
  recordMove(move, prevFen);
}

function loadOpening(i) {
  const entry = openings.entries[i];
  if (!entry) return;
  searchEl.value = '';
  importGame(entry.pgn);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function updateTurnIndicator() {
  if (game.isGameOver()) return;
  setTurnText((game.turn() === 'w' ? 'White' : 'Black') + ' to move');
}
function setTurnText(t) { $('turn-indicator').textContent = t; }

// Render the "Best lines" panel for a given position. `fen`/`turn` default to
// the live game but are passed explicitly while reviewing so the panel reflects
// the position currently on the board, not the live one.
function renderLines(lines, opts = {}) {
  const { loading = false, fen = game.fen(), turn = game.turn() } = opts;
  const ol = $('lines');
  if (!state.analysisOn) {
    ol.innerHTML = '<li class="muted">Analysis hidden.</li>';
    $('eval-bar').classList.add('hidden');
    return;
  }
  $('eval-bar').classList.remove('hidden');
  if (loading && lines.length === 0) {
    ol.innerHTML = '<li class="muted">Thinking…</li>';
    return;
  }
  if (lines.length === 0) {
    ol.innerHTML = '<li class="muted">—</li>';
    return;
  }
  // Remember these lines (and the position they were computed at) so hovering
  // a move in the panel can preview that variation on the board.
  currentLines = lines;
  analyzedFen = fen;
  ol.innerHTML = '';
  lines.forEach((line, idx) => {
    const li = document.createElement('li');
    const ev = document.createElement('span');
    ev.className = 'ev';
    const whiteCp = turn === 'w' ? rawScore(line) : flip(rawScore(line));
    ev.textContent = formatScore(line, turn);
    ev.classList.add(whiteCp.adv > 0 ? 'pos' : whiteCp.adv < 0 ? 'neg' : 'eq');
    li.append(ev, buildPv(fen, line.pv, idx));
    ol.appendChild(li);
  });
  // eval bar follows the top line (White perspective)
  if (lines[0]) setEvalBar(toWhiteCp(lines[0], turn));
}

function renderMoveList() {
  const box = $('movelist');
  box.innerHTML = '';
  for (let i = 0; i < history.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'move-row';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = (i / 2 + 1) + '.';
    row.appendChild(num);
    row.appendChild(moveSpan(history[i], i));
    if (history[i + 1]) row.appendChild(moveSpan(history[i + 1], i + 1));
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

function moveSpan(h, i) {
  const s = document.createElement('span');
  s.className = 'mv';
  s.dataset.ply = i;
  s.textContent = h.san;
  if (h.annotation && state.annotateOn) {
    const a = document.createElement('sup');
    a.className = 'anno ' + h.annotation.cls;
    a.textContent = h.annotation.sym || '•';
    a.title = h.annotation.tag;
    s.appendChild(a);
  }
  return s;
}

function showResult() {
  let msg = 'Game over';
  if (game.isCheckmate()) msg = (game.turn() === 'w' ? 'Black' : 'White') + ' wins by checkmate';
  else if (game.isStalemate()) msg = 'Draw — stalemate';
  else if (game.isThreefoldRepetition()) msg = 'Draw — threefold repetition';
  else if (game.isInsufficientMaterial()) msg = 'Draw — insufficient material';
  else if (game.isDraw()) msg = 'Draw — 50-move rule';
  const b = $('result-banner');
  b.textContent = msg;
  b.classList.remove('hidden');
  setTurnText(msg);
}

// ---------- Eval bar ----------
function setEvalBar(white) {
  const fill = $('eval-fill');
  const num = $('eval-num');
  let pct, label;
  if (white.mate != null) {
    pct = white.mate > 0 ? 100 : 0;
    label = 'M' + Math.abs(white.mate);
  } else {
    const cp = white.cp;
    const p = 1 / (1 + Math.pow(10, -cp / 400)); // win prob for White
    pct = p * 100;
    label = (cp >= 0 ? '+' : '') + (cp / 100).toFixed(1);
  }
  fill.style.setProperty('--eval-pct', pct + '%');
  num.textContent = label;
}
function updateEvalBarFromTurn() {
  if (!state.analysisOn) $('eval-bar').classList.add('hidden');
}

// ---------- Score helpers ----------
function cpFromInfo(info) {
  if (!info) return 0;
  if (info.scoreType === 'mate') {
    const v = info.scoreValue;
    return (v >= 0 ? 1 : -1) * (100000 - Math.abs(v) * 100);
  }
  return info.scoreValue;
}
function rawScore(info) {
  return info.scoreType === 'mate'
    ? { adv: info.scoreValue >= 0 ? 1 : -1 }
    : { adv: Math.sign(info.scoreValue) };
}
function flip(s) { return { adv: -s.adv }; }
function toWhiteCp(info, turn) {
  const sign = turn === 'w' ? 1 : -1;
  if (info.scoreType === 'mate') return { mate: sign * info.scoreValue };
  return { cp: sign * info.scoreValue };
}
function formatScore(info, turn) {
  const w = toWhiteCp(info, turn);
  if (w.mate != null) return 'M' + Math.abs(w.mate) + (w.mate >= 0 ? '' : '');
  return (w.cp >= 0 ? '+' : '') + (w.cp / 100).toFixed(2);
}

// Replay a UCI principal variation into SAN for display.
function pvToSan(fen, pv) {
  const g = new Chess(fen);
  const out = [];
  for (const u of pv.slice(0, 8)) {
    const mv = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || undefined });
    if (!mv) break;
    out.push(mv.san);
  }
  return out;
}

// Build the principal-variation span as individually hoverable moves, with
// move numbers. Each move carries its line index and depth so hovering can
// replay the variation up to that point on the board (see previewLine).
function buildPv(fen, pv, lineIdx) {
  const span = document.createElement('span');
  span.className = 'pv';
  const sans = pvToSan(fen, pv);
  let num = +fen.split(' ')[5] || 1;   // fullmove number
  let white = fen.split(' ')[1] === 'w';
  sans.forEach((san, i) => {
    if (i > 0) span.appendChild(document.createTextNode(' '));
    if (white || i === 0) {
      const n = document.createElement('span');
      n.className = 'pvnum';
      n.textContent = white ? num + '.' : num + '…';
      span.appendChild(n);
    }
    const m = document.createElement('span');
    m.className = 'pvm';
    m.dataset.line = lineIdx;
    m.dataset.depth = i + 1; // number of plies to replay for this move
    m.textContent = san;
    span.appendChild(m);
    if (!white) num++;
    white = !white;
  });
  return span;
}

// Preview the first `depth` moves of best line `lineIdx` on the board, without
// altering the real game. The final move is highlighted as the "last move".
function previewLine(lineIdx, depth) {
  const pv = currentLines[lineIdx]?.pv;
  if (!pv) return;
  const g = new Chess(analyzedFen);
  let last = null;
  for (let i = 0; i < depth && i < pv.length; i++) {
    const u = pv[i];
    const mv = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || undefined });
    if (!mv) break;
    last = mv;
  }
  previewing = true;
  board.setInteractive(false);
  board.setThreats(state.showThreats ? hangingSquares(g) : []);
  board.setPinned(state.showPinned ? pinnedSquares(g) : []);
  board.setCheckable(state.showCheckable ? checkableKingSquares(g) : []);
  board.setForks(state.showForks ? forkSquares(g) : []);
  board.setSkewers(state.showSkewers ? skewerSquares(g) : []);
  board.setLastMove(last ? { from: last.from, to: last.to } : null);
  board.drawArrow(null);
  board.render(g);
  updateCaptured(g);
  setTurnText(`Preview — ${g.turn() === 'w' ? 'White' : 'Black'} to move`);
  renderOpening(openingAfterPv(analyzedFen, pv, depth));
}

// Commit `depth` plies of best line `lineIdx` into the real game from the
// analyzed position, discarding any later moves and resuming engine play.
function commitLine(lineIdx, depth) {
  const pv = currentLines[lineIdx]?.pv;
  if (!pv) return;
  if (state.thinking) return;
  // Map analyzedFen back to a ply in history; bail if unknown.
  let basePly;
  if (analyzedFen === START_FEN) basePly = 0;
  else {
    const idx = history.findIndex((h) => h.fen === analyzedFen);
    if (idx < 0) return;
    basePly = idx + 1;
  }
  previewing = false;
  while (history.length > basePly) { game.undo(); history.pop(); }
  let lastMove = null;
  for (let i = 0; i < depth && i < pv.length; i++) {
    const u = pv[i];
    const mv = game.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || undefined });
    if (!mv) break;
    appendHistory(mv);
    lastMove = mv;
  }
  $('result-banner').classList.add('hidden');
  board.drawArrow(null);
  refreshAll();
  if (lastMove) playMoveSound(lastMove);
  if (game.isGameOver()) { showResult(); scheduleReview(); return; }
  maybeEngineTurn();
  scheduleReview();
}

// Drop the preview and restore whatever the board was actually showing.
function endPreview() {
  if (!previewing) return;
  previewing = false;
  renderBoardForView();
  updateOpening();
  // Re-draw the live best-move arrow that renderBoardForView leaves to analysis.
  if (atLiveHuman() && state.showBestMove && currentLines[0]?.pv?.[0]) {
    const u = currentLines[0].pv[0];
    board.drawArrow({ from: u.slice(0, 2), to: u.slice(2, 4) });
  }
}

// ---------- Controls ----------
$('mode-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  [...$('mode-seg').children].forEach((b) => b.classList.toggle('active', b === btn));
  $('ai-options').style.display = state.mode === 'ai' ? '' : 'none';
  startGame();
});

$('elo').addEventListener('input', (e) => {
  state.elo = +e.target.value;
  $('elo-label').textContent = state.elo + ' Elo';
});
$('ai-side').addEventListener('change', (e) => {
  state.humanSide = e.target.value;
  startGame();
});
// Pause the AI to explore lines by hand: the human can now move both sides and
// the engine won't auto-reply. Unpausing hands the turn back, so if it's the
// AI's move it plays immediately. Either way refresh interactivity / analysis.
$('pause-ai-toggle').addEventListener('change', (e) => {
  state.pauseAi = e.target.checked;
  if (state.thinking) return; // engine mid-move; it'll settle and we re-render then
  renderBoardForView();
  if (viewPly >= history.length) maybeEngineTurn();
});
$('depth').addEventListener('input', (e) => {
  state.depth = +e.target.value;
  $('depth-label').textContent = state.depth;
});
$('depth').addEventListener('change', () => {
  evalCache.clear(); // cached evals were at the old depth
  linesCache.clear();
  if (atLiveHuman()) startLiveAnalysis();
  scheduleReview();
});

$('analysis-toggle').addEventListener('change', (e) => {
  state.analysisOn = e.target.checked;
  if (!state.analysisOn) renderLines([]); // hide lines + eval bar immediately
  if (atLiveHuman()) startLiveAnalysis();
  else if (viewPly < history.length) renderBoardForView(); // refresh lines in review
});
$('bestmove-toggle').addEventListener('change', (e) => {
  state.showBestMove = e.target.checked;
  if (!state.showBestMove) board.drawArrow(null);
  if (atLiveHuman()) startLiveAnalysis();
  else if (viewPly < history.length) renderBoardForView(); // redraw arrow in review
});
$('threats-toggle').addEventListener('change', (e) => {
  state.showThreats = e.target.checked;
  renderBoardForView();
});
$('checkable-toggle').addEventListener('change', (e) => {
  state.showCheckable = e.target.checked;
  renderBoardForView();
});
$('pinned-toggle').addEventListener('change', (e) => {
  state.showPinned = e.target.checked;
  renderBoardForView();
});
$('fork-toggle').addEventListener('change', (e) => {
  state.showForks = e.target.checked;
  renderBoardForView();
});
$('skewer-toggle').addEventListener('change', (e) => {
  state.showSkewers = e.target.checked;
  renderBoardForView();
});
$('annotate-toggle').addEventListener('change', (e) => {
  state.annotateOn = e.target.checked;
  renderMoveList();      // show/hide the rating symbols
  highlightActiveMove();
  if (state.annotateOn) scheduleReview(); // compute any missing ratings
});
$('sound-toggle').addEventListener('change', (e) => { sounds.setEnabled(e.target.checked); });

// Best-line preview: hover a move to play that variation out on the board.
$('lines').addEventListener('mouseover', (e) => {
  const m = e.target.closest('.pvm');
  if (m) previewLine(+m.dataset.line, +m.dataset.depth);
});
$('lines').addEventListener('mouseleave', endPreview);
// Click a PV move to commit that variation into the game.
$('lines').addEventListener('click', (e) => {
  const m = e.target.closest('.pvm');
  if (m) commitLine(+m.dataset.line, +m.dataset.depth);
});

// Move navigation: click a move to jump there; arrow keys / Home / End to step.
$('movelist').addEventListener('click', (e) => {
  const mv = e.target.closest('.mv');
  if (mv) goToPly(+mv.dataset.ply + 1);
});
// Opening explorer / search: click a book move to play it, or a search hit to load it.
$('explorer-list').addEventListener('click', (e) => {
  const li = e.target.closest('.explorer-item');
  if (!li) return;
  if (li.dataset.san != null) playExplorerMove(li.dataset.san);
  else if (li.dataset.entry != null) loadOpening(+li.dataset.entry);
});
$('opening-search').addEventListener('input', (e) => renderSearch(e.target.value));

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === 'Escape') {
    if (closeAllSheets()) { e.preventDefault(); return; }
  }
  if (e.key === 'ArrowLeft') { e.preventDefault(); goToPly(viewPly - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); goToPly(viewPly + 1); }
  else if (e.key === 'Home') { e.preventDefault(); goToPly(0); }
  else if (e.key === 'End') { e.preventDefault(); goToPly(history.length); }
});

function openSheet(which) {
  closeAllSheets();
  const id = which === 'controls' ? 'panel-controls' : 'panel-info';
  document.getElementById(id)?.classList.add('open');
  document.getElementById('sheet-backdrop')?.classList.add('open');
}
function closeAllSheets() {
  const a = document.getElementById('panel-controls');
  const b = document.getElementById('panel-info');
  const bd = document.getElementById('sheet-backdrop');
  const wasOpen = a?.classList.contains('open') || b?.classList.contains('open');
  a?.classList.remove('open');
  b?.classList.remove('open');
  bd?.classList.remove('open');
  return wasOpen;
}
function setInfoTab(tab) {
  const panel = document.getElementById('panel-info');
  if (!panel) return;
  panel.dataset.tab = tab;
  panel.querySelectorAll('.tabbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tabTarget === tab);
  });
}
document.getElementById('open-controls')?.addEventListener('click', () => openSheet('controls'));
document.getElementById('open-info')?.addEventListener('click', () => openSheet('info'));
document.getElementById('sheet-backdrop')?.addEventListener('click', closeAllSheets);
document.querySelectorAll('[data-close-sheet]').forEach((el) => {
  el.addEventListener('click', closeAllSheets);
});
document.querySelectorAll('.tabbtn').forEach((b) => {
  b.addEventListener('click', () => setInfoTab(b.dataset.tabTarget));
});
setInfoTab('moves');

$('nav-first').addEventListener('click', () => goToPly(0));
$('nav-prev').addEventListener('click', () => goToPly(viewPly - 1));
$('nav-next').addEventListener('click', () => goToPly(viewPly + 1));
$('nav-last').addEventListener('click', () => goToPly(history.length));

$('accuracy-toggle').addEventListener('change', (e) => {
  state.showAccuracy = e.target.checked;
  if (state.showAccuracy) updateReview();
  else $('review-summary').classList.add('hidden');
});

function runImport(text, { clearOnSuccess = false } = {}) {
  const err = importGame(text);
  const box = $('paste-error');
  if (err) {
    box.textContent = err;
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
    if (clearOnSuccess) $('moves-input').value = '';
  }
  return !err;
}

$('load-moves').addEventListener('click', () => {
  runImport($('moves-input').value, { clearOnSuccess: true });
});

$('copy-pgn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(buildPgn());
  flash($('copy-pgn'), 'Copied!');
});

$('export-pgn').addEventListener('click', () => {
  const blob = new Blob([buildPgn()], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `game-${new Date().toISOString().slice(0, 10)}.pgn`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------- Drag & drop a .pgn file anywhere on the page ----------
const dropOverlay = $('drop-overlay');
let dragDepth = 0; // dragenter/leave fire per child element; count to know when we truly left
function hasFiles(e) {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (dragDepth++ === 0) dropOverlay.classList.remove('hidden');
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.add('hidden'); }
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const text = await file.text();
  $('moves-input').value = text;
  $('app')?.querySelector('.paste')?.setAttribute('open', '');
  runImport(text);
});

$('new-game').addEventListener('click', startGame);
$('flip').addEventListener('click', () => {
  board.flip();
  if (board.game) updateCaptured(board.game); // re-render trays for the new side
});
$('copy-fen').addEventListener('click', async () => {
  await navigator.clipboard.writeText(game.fen());
  flash($('copy-fen'), 'Copied!');
});
function flash(el, text) {
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => (el.textContent = old), 900);
}
