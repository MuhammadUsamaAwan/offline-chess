// Renders an interactive chessboard from a chess.js game.
// Handles click-to-move and drag-and-drop, highlights, and a best-move arrow.

const GLYPHS = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export class Board {
  constructor(el, { onMove }) {
    this.el = el;
    this.onMove = onMove;
    this.orientation = 'w';
    this.selected = null;
    this.legalTargets = [];
    this.lastMove = null;
    this.interactive = true;
    this.game = null;
    this.threats = []; // squares to mark as "can be profitably captured"
    this.pinned = [];
    this.checkable = [];
    this._buildDom();
  }

  setThreats(squares) { this.threats = squares || []; }
  setPinned(squares) { this.pinned = squares || []; }
  setCheckable(squares) { this.checkable = squares || []; }

  _buildDom() {
    this.el.innerHTML = '';
    this.el.classList.add('board-grid');
    this.squares = {};
    const order = this.orientation === 'w'
      ? [8, 7, 6, 5, 4, 3, 2, 1]
      : [1, 2, 3, 4, 5, 6, 7, 8];
    const fileOrder = this.orientation === 'w' ? FILES : [...FILES].reverse();

    for (const rank of order) {
      for (const file of fileOrder) {
        const sq = file + rank;
        const cell = document.createElement('div');
        const dark = (FILES.indexOf(file) + rank) % 2 !== 0;
        cell.className = `sq ${dark ? 'dark' : 'light'}`;
        cell.dataset.sq = sq;
        cell.addEventListener('click', () => this._onClick(sq));
        cell.addEventListener('dragover', (e) => e.preventDefault());
        cell.addEventListener('drop', (e) => this._onDrop(e, sq));

        // Piece glyph lives in its own layer so coordinate labels survive renders.
        const pieceEl = document.createElement('span');
        pieceEl.className = 'piece';
        cell.appendChild(pieceEl);

        // Coordinates: ranks down the left edge, files along the bottom edge.
        if (file === fileOrder[0]) cell.appendChild(makeCoord('rank', rank));
        if (rank === order[order.length - 1]) cell.appendChild(makeCoord('file', file));

        this.el.appendChild(cell);
        this.squares[sq] = cell;
      }
    }
    // SVG overlay for the best-move arrow.
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'arrows');
    this.svg.setAttribute('viewBox', '0 0 8 8');
    this.svg.innerHTML = `<defs><marker id="ah" markerWidth="4" markerHeight="4"
      refX="2.2" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 Z" fill="currentColor"/></marker></defs>`;
    this.el.appendChild(this.svg);
  }

  setOrientation(o) {
    this.orientation = o;
    this._buildDom();
    if (this.game) this.render(this.game);
    this.drawArrow(this._arrow);
  }

  flip() {
    this.setOrientation(this.orientation === 'w' ? 'b' : 'w');
  }

  setInteractive(v) { this.interactive = v; }

  render(game) {
    this.game = game;
    const board = game.board(); // 8x8 from rank 8 -> 1
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = FILES[f] + (8 - r);
        const cell = this.squares[sq];
        const piece = board[r][f];
        cell.querySelector('.piece').textContent = piece ? GLYPHS[piece.color + piece.type.toUpperCase()] : '';
        cell.classList.toggle('white-piece', piece?.color === 'w');
        cell.classList.toggle('black-piece', piece?.color === 'b');
        cell.draggable = !!piece && this.interactive;
        if (piece && this.interactive) {
          cell.ondragstart = (e) => this._onDragStart(e, sq);
        } else {
          cell.ondragstart = null;
        }
        cell.classList.remove('sel', 'last', 'target', 'capture', 'check', 'threat', 'pinned', 'checkable');
      }
    }
    for (const sq of this.threats) this.squares[sq]?.classList.add('threat');
    for (const sq of this.pinned) this.squares[sq]?.classList.add('pinned');
    for (const sq of this.checkable) this.squares[sq]?.classList.add('checkable');
    if (this.lastMove) {
      this.squares[this.lastMove.from]?.classList.add('last');
      this.squares[this.lastMove.to]?.classList.add('last');
    }
    if (this.selected) {
      this.squares[this.selected]?.classList.add('sel');
      for (const t of this.legalTargets) {
        const cell = this.squares[t.to];
        if (!cell) continue;
        cell.classList.add(t.captured ? 'capture' : 'target');
      }
    }
    if (game.inCheck()) {
      const turn = game.turn();
      for (const [sq, cell] of Object.entries(this.squares)) {
        const p = game.get(sq);
        if (p && p.type === 'k' && p.color === turn) cell.classList.add('check');
      }
    }
  }

  _onClick(sq) {
    if (!this.interactive) return;
    const piece = this.game.get(sq);
    if (this.selected) {
      const move = this.legalTargets.find((m) => m.to === sq);
      if (move) {
        this._commit(this.selected, sq);
        return;
      }
      // clicked another own piece -> reselect; else clear
      if (piece && piece.color === this.game.turn()) {
        this._select(sq);
      } else {
        this.selected = null;
        this.legalTargets = [];
        this.render(this.game);
      }
    } else if (piece && piece.color === this.game.turn()) {
      this._select(sq);
    }
  }

  _select(sq) {
    this.selected = sq;
    this.legalTargets = this.game.moves({ square: sq, verbose: true });
    this.render(this.game);
  }

  _onDragStart(e, sq) {
    const piece = this.game.get(sq);
    if (!piece || piece.color !== this.game.turn()) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('text/plain', sq);
    this._select(sq);
  }

  _onDrop(e, sq) {
    e.preventDefault();
    const from = e.dataTransfer.getData('text/plain');
    if (!from) return;
    const move = this.game.moves({ square: from, verbose: true }).find((m) => m.to === sq);
    if (move) this._commit(from, sq);
  }

  _commit(from, to) {
    this.selected = null;
    this.legalTargets = [];
    // Promotion handling: ask for piece if a pawn reaches the last rank.
    const moving = this.game.get(from);
    let promotion;
    if (moving?.type === 'p' && (to[1] === '8' || to[1] === '1')) {
      promotion = promptPromotion();
    }
    this.onMove({ from, to, promotion });
  }

  setLastMove(move) {
    this.lastMove = move ? { from: move.from, to: move.to } : null;
  }

  // Draw a best-move arrow. move = {from, to} or null.
  drawArrow(move) {
    this._arrow = move;
    // remove existing line(s)
    this.svg.querySelectorAll('line').forEach((n) => n.remove());
    if (!move) return;
    const c = (sq) => {
      let f = FILES.indexOf(sq[0]);
      let r = 8 - +sq[1];
      if (this.orientation === 'b') { f = 7 - f; r = 7 - r; }
      return { x: f + 0.5, y: r + 0.5 };
    };
    const a = c(move.from);
    const b = c(move.to);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x);
    line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x);
    line.setAttribute('y2', b.y);
    line.setAttribute('class', 'arrow-line');
    line.setAttribute('marker-end', 'url(#ah)');
    this.svg.appendChild(line);
  }
}

function makeCoord(kind, value) {
  const el = document.createElement('span');
  el.className = `coord ${kind}`;
  el.textContent = value;
  return el;
}

function promptPromotion() {
  const v = (window.prompt('Promote to: q, r, b, or n', 'q') || 'q').toLowerCase();
  return ['q', 'r', 'b', 'n'].includes(v) ? v : 'q';
}
