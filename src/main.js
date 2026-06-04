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
  analysisOn: true,
  annotateOn: true,
  depth: 15,
  thinking: false,
};

const history = []; // [{ san, color, from, to, uci, annotation, fen, opening }]
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let analysisAbort = null;
let viewPly = 0; // which ply the board is currently showing (history.length === live)
let hintShown = false; // whether the hint button is currently displaying its arrow

function resetHint() {
  hintShown = false;
  const b = document.getElementById('hint');
  if (b) { b.disabled = false; b.textContent = '💡 Show best move'; }
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
  game.reset();
  history.length = 0;
  board.setLastMove(null);
  board.drawArrow(null);
  $('result-banner').classList.add('hidden');
  board.setOrientation(state.mode === 'ai' ? state.humanSide : 'w');
  refreshAll();
  maybeEngineTurn();
}

function handleHumanMove({ from, to, promotion }) {
  if (state.thinking) return;
  const prevFen = game.fen();
  const move = game.move({ from, to, promotion: promotion || 'q' });
  if (!move) return;
  recordMove(move, prevFen);
}

function recordMove(move, prevFen) {
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
  // Opening name: use the most specific match for this position, otherwise
  // carry forward the previous move's opening so it persists out of book.
  const matched = openings[fenKey(game.fen())];
  history[ply].opening = matched || history[ply - 1]?.opening || null;

  board.setLastMove(move);
  board.drawArrow(null);
  refreshAll();
  playMoveSound(move);

  if (game.isGameOver()) {
    showResult();
    if (state.annotateOn) annotateMove(prevFen, ply); // still rate the final move
    return;
  }

  // Dispatch the engine's next job (AI reply or live analysis) BEFORE the
  // background annotation so the opponent responds promptly.
  maybeEngineTurn();
  if (state.annotateOn) annotateMove(prevFen, ply);
}

function isHumanTurn() {
  if (state.mode === 'human') return true;
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
    if (game.fen() !== fen) return; // position changed (new game / undo)
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
function startLiveAnalysis() {
  if (!state.analysisOn || game.isGameOver()) {
    renderLines([]);
    return;
  }
  if (analysisAbort) analysisAbort.abort();
  analysisAbort = new AbortController();
  const fen = game.fen();
  renderLines([], true);
  engine
    .analyze(fen, { depth: state.depth, multipv: 3, signal: analysisAbort.signal }, (lines) => {
      if (game.fen() === fen && state.analysisOn) renderLines(lines);
    })
    .then((res) => {
      // Bail out if this run was superseded/aborted or analysis was turned off.
      if (res.aborted || !state.analysisOn || game.fen() !== fen) return;
      renderLines(res.lines);
      if (res.lines[0]?.pv?.[0]) {
        const u = res.lines[0].pv[0];
        board.drawArrow({ from: u.slice(0, 2), to: u.slice(2, 4) });
      }
    })
    .catch(() => {});
}

// ---------- Move rating ----------
async function annotateMove(prevFen, ply) {
  try {
    const annDepth = Math.min(state.depth, 12);
    const before = await engine.analyze(prevFen, { depth: annDepth, multipv: 1 });
    const bestUci = before.bestmove;
    const bestEval = cpFromInfo(before.lines[0]); // perspective: side to move (the mover)

    const afterFen = applyUciToFen(prevFen, history[ply].uci);
    const after = await engine.analyze(afterFen, { depth: annDepth, multipv: 1 });
    const moverEvalAfter = -cpFromInfo(after.lines[0]); // flip opponent perspective -> mover

    const cpLoss = Math.max(0, bestEval - moverEvalAfter);
    const isBest = history[ply].uci === bestUci;
    history[ply].annotation = classify(cpLoss, isBest);
    renderMoveList();
  } catch (e) {
    /* ignore annotation failures */
  }
}

function classify(cpLoss, isBest) {
  if (isBest) return { tag: 'Best', sym: '★', cls: 'best' };
  if (cpLoss <= 20) return { tag: 'Excellent', sym: '!', cls: 'excellent' };
  if (cpLoss <= 50) return { tag: 'Good', sym: '', cls: 'good' };
  if (cpLoss <= 100) return { tag: 'Inaccuracy', sym: '?!', cls: 'inaccuracy' };
  if (cpLoss <= 250) return { tag: 'Mistake', sym: '?', cls: 'mistake' };
  return { tag: 'Blunder', sym: '??', cls: 'blunder' };
}

// ---------- Rendering ----------
// Called whenever the game itself changes (move / undo / new game): snap the
// view to the live position and redraw everything.
function refreshAll() {
  viewPly = history.length;
  resetHint();
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
  if (atLive) {
    board.setInteractive(!state.thinking);
    board.setLastMove(history.length ? lastMoveOf(history.length - 1) : null);
    board.render(game);
    updateTurnIndicator();
  } else {
    board.setInteractive(false);
    const fen = viewPly === 0 ? START_FEN : history[viewPly - 1].fen;
    board.setLastMove(viewPly > 0 ? lastMoveOf(viewPly - 1) : null);
    board.drawArrow(null);
    board.render(new Chess(fen));
    setTurnText(`Reviewing ${viewPly}/${history.length} — → or End to resume`);
  }
  highlightActiveMove();
}

// Step to a specific ply and, when resuming the live position, restart analysis.
function goToPly(p) {
  const target = Math.max(0, Math.min(history.length, p));
  if (target === viewPly) return;
  viewPly = target;
  resetHint();
  renderBoardForView();
  if (viewPly >= history.length && state.analysisOn && !state.thinking
      && !game.isGameOver() && isHumanTurn()) {
    startLiveAnalysis();
  }
}

function highlightActiveMove() {
  const box = $('movelist');
  box.querySelectorAll('.mv.active').forEach((el) => el.classList.remove('active'));
  if (viewPly > 0) {
    const el = box.querySelector(`.mv[data-ply="${viewPly - 1}"]`);
    if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
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

function updateOpening() {
  $('opening').textContent = history.at(-1)?.opening || 'Starting position';
}

// FEN reduced to the fields that define a position for opening lookup.
function fenKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

function updateTurnIndicator() {
  if (game.isGameOver()) return;
  setTurnText((game.turn() === 'w' ? 'White' : 'Black') + ' to move');
}
function setTurnText(t) { $('turn-indicator').textContent = t; }

function renderLines(lines, loading = false) {
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
  ol.innerHTML = '';
  for (const line of lines) {
    const li = document.createElement('li');
    const ev = document.createElement('span');
    ev.className = 'ev';
    const whiteCp = game.turn() === 'w' ? rawScore(line) : flip(rawScore(line));
    ev.textContent = formatScore(line, game.turn());
    ev.classList.add(whiteCp.adv > 0 ? 'pos' : whiteCp.adv < 0 ? 'neg' : 'eq');
    const pv = document.createElement('span');
    pv.className = 'pv';
    pv.textContent = pvToSan(game.fen(), line.pv).join(' ');
    li.append(ev, pv);
    ol.appendChild(li);
  }
  // eval bar follows the top line (White perspective)
  if (lines[0]) setEvalBar(toWhiteCp(lines[0], game.turn()));
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
  if (h.annotation) {
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
  fill.style.height = pct + '%';
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
function applyUciToFen(fen, uci) {
  const g = new Chess(fen);
  g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
  return g.fen();
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
$('depth').addEventListener('input', (e) => {
  state.depth = +e.target.value;
  $('depth-label').textContent = state.depth;
});
$('depth').addEventListener('change', () => { if (isHumanTurn()) startLiveAnalysis(); });

$('hint').addEventListener('click', async () => {
  const btn = $('hint');
  // Toggle off: a hint arrow is already showing -> clear it.
  if (hintShown) { board.drawArrow(null); resetHint(); return; }
  // Only hint the live position, and only when a move is to be made.
  if (game.isGameOver() || viewPly < history.length) return;
  const fen = game.fen();
  btn.disabled = true;
  btn.textContent = 'Thinking…';
  try {
    const res = await engine.analyze(fen, { depth: state.depth, multipv: 1 });
    const u = res.bestmove || res.lines[0]?.pv?.[0];
    if (u && game.fen() === fen) {
      board.drawArrow({ from: u.slice(0, 2), to: u.slice(2, 4) });
      hintShown = true;
      btn.disabled = false;
      btn.textContent = '💡 Hide best move';
      return;
    }
  } catch { /* ignore */ }
  btn.disabled = false;
  resetHint();
});

$('analysis-toggle').addEventListener('change', (e) => {
  state.analysisOn = e.target.checked;
  if (state.analysisOn) {
    if (isHumanTurn()) startLiveAnalysis();
  } else {
    if (analysisAbort) analysisAbort.abort();
    board.drawArrow(null);
    renderLines([]);
    resetHint();
  }
});
$('annotate-toggle').addEventListener('change', (e) => { state.annotateOn = e.target.checked; });
$('sound-toggle').addEventListener('change', (e) => { sounds.setEnabled(e.target.checked); });

// Move navigation: click a move to jump there; arrow keys / Home / End to step.
$('movelist').addEventListener('click', (e) => {
  const mv = e.target.closest('.mv');
  if (mv) goToPly(+mv.dataset.ply + 1);
});
document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); goToPly(viewPly - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); goToPly(viewPly + 1); }
  else if (e.key === 'Home') { e.preventDefault(); goToPly(0); }
  else if (e.key === 'End') { e.preventDefault(); goToPly(history.length); }
});

$('new-game').addEventListener('click', startGame);
$('flip').addEventListener('click', () => board.flip());
$('copy-fen').addEventListener('click', async () => {
  await navigator.clipboard.writeText(game.fen());
  flash($('copy-fen'), 'Copied!');
});
$('undo').addEventListener('click', () => {
  if (state.thinking) return;
  // In AI mode, undo a full move pair so it's the human's turn again.
  const steps = state.mode === 'ai' && history.length >= 2 && !isHumanTurn() ? 1 : (state.mode === 'ai' ? 2 : 1);
  for (let i = 0; i < steps && history.length; i++) {
    game.undo();
    history.pop();
  }
  board.setLastMove(history.length ? { from: history.at(-1).from, to: history.at(-1).to } : null);
  if (game.isGameOver() === false) $('result-banner').classList.add('hidden');
  refreshAll();
  if (isHumanTurn()) startLiveAnalysis(); else maybeEngineTurn();
});

function flash(el, text) {
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => (el.textContent = old), 900);
}
