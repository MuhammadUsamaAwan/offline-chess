# Offline Chess Analyzer

A fully offline chess app: play against the Stockfish engine at adjustable Elo,
play a friend on the same computer, and get live engine analysis with move
quality ratings. Everything runs in your browser — **no internet needed** after
the first install. The engine is Stockfish 18 (lite NNUE) compiled to WebAssembly.

## Features

- **Play vs AI** — strength slider from ~600 to 2850 Elo. Choose your color.
- **Play vs Human** — two players, same screen (pass-and-play).
- **Live analysis** — top 3 engine lines with evaluations and an evaluation bar.
- **Best-move arrow** — drawn on the board; independent toggle from the analysis panel.
- **Move ratings** — each move is graded ★ Best / Excellent / Good /
  Inaccuracy (?!) / Mistake (?) / Blunder (??) based on centipawn loss. Toggle on/off.
- **Full game review** — one button evaluates every move and reports a per-side
  accuracy % plus a breakdown of move quality.
- **Threats / hanging pieces** — optional red highlight on any piece (either color)
  that can be profitably captured (static exchange evaluation).
- **Move navigation** — click a move or use ←/→/Home/End to step through the game.
  Play a move from any past position to branch off into a new line.
- **Opening names** from the Lichess ECO database.
- **Sound effects** for moves, captures, castling, check, promotion, and game end.
- **Adjustable search depth**, board flip, copy FEN, board coordinates.
- Click-to-move or drag-and-drop, with legal-move dots, last-move and check
  highlighting, and pawn promotion prompts.

## Run it

```bash
npm install        # first time only (downloads dependencies)
npm run dev        # opens http://localhost:5173
```

### Build a standalone offline copy

```bash
npm run build      # outputs to dist/
npm run preview    # serves the built app locally
```

The `dist/` folder is self-contained. It must be served over **http** (browsers
won't load the WebAssembly engine from a `file://` page), but any static server
works offline — e.g. `npx serve dist` or `python -m http.server` inside `dist`.

## How it works

- `chess.js` enforces the rules and tracks game state.
- `src/engine.js` runs Stockfish in a Web Worker and speaks UCI. AI strength uses
  `UCI_LimitStrength` / `UCI_Elo` (≥1320 Elo) and `Skill Level` below that.
- Analysis uses `MultiPV 3`; move ratings compare the engine's best evaluation
  before the move against the evaluation after the move actually played.
- The engine files live in `public/engine/` (copied from the `stockfish` npm
  package) so they are served as static assets and work offline.
