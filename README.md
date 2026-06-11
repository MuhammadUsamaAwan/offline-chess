# Offline Chess Analyzer

A fully offline chess app: play against the Stockfish engine at adjustable Elo,
play a friend on the same computer, and get live engine analysis with move
quality ratings. Everything runs in your browser — **no internet needed** after
the first install. The engine is the multi-threaded Stockfish 18 (lite NNUE)
build compiled to WebAssembly.

## Features

- **Play vs AI** — strength slider from 1320 to 3190 Elo (Stockfish's real
  `UCI_Elo` range). Choose your color.
- **Play vs Human** — two players, same screen (pass-and-play).
- **Live analysis** — top 3 engine lines with evaluations and an evaluation bar.
  Hover a line to preview that variation on the board.
- **Best-move arrow** — drawn on the board; independent toggle from the analysis panel.
- **Move ratings** — each move is graded ★ Best / Excellent (!) / Good /
  Inaccuracy (?!) / Mistake (?) / Blunder (??) based on centipawn loss. Toggle on/off.
- **Accuracy summary** — a per-side accuracy % plus a count of each move-quality
  grade, updated automatically as you play. Toggle on/off.
- **Pause AI** — stop the engine from replying so you can move both sides
  to explore lines by hand.
- **Tactical highlights** (each independently toggleable):
  - Threats / hanging pieces — pieces that can be profitably captured (static
    exchange evaluation).
  - Checkable king — squares from which the side-to-move can give check.
  - Pinned pieces — absolute and relative pins.
  - Forks and skewers.
- **Captured pieces** — trays above and below the board with a `+N` material
  advantage badge.
- **Move navigation** — click a move or use ←/→/Home/End to step through the game.
  Play a move from any past position to branch off into a new line.
- **Opening explorer** — names every position from the Lichess ECO database
  (transposition-aware), lists the book moves available from the current position,
  and lets you search openings by name or ECO code and load them onto the board.
- **PGN import / export** — paste a PGN (with comments/NAGs) or a plain move list,
  or drop a `.pgn` file anywhere on the page; copy or download the current game as PGN.
- **Sound effects** for moves, captures, castling, check, promotion, and game end.
- **Adjustable search depth**, board flip, copy FEN, board coordinates.
- Click-to-move or drag-and-drop, with legal-move dots, last-move and check
  highlighting, and pawn promotion prompts.
- **Installable PWA** — built with `vite-plugin-pwa`. Install to your home screen
  or desktop and the app (engine included) works fully offline via a service
  worker that precaches every asset.

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

The `dist/` folder is self-contained and works offline, but it has two serving
requirements:

- **Served over `http(s)`**, not `file://` — browsers won't load the WebAssembly
  engine from a `file://` page.
- **Cross-origin isolation headers.** The engine is the multi-threaded Stockfish
  build, which needs `SharedArrayBuffer`. Browsers only expose that to
  cross-origin-isolated pages, so the host must send these two response headers
  on every request:

  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```

  `npm run preview` and the Vite dev server set them automatically, and the
  included `vercel.json` sets them on Vercel. A plain static server (`npx serve
  dist`, `python -m http.server`) does **not** send these headers, so the engine
  will fail to start there with a `SharedArrayBuffer is not defined` error.

## How it works

- `chess.js` enforces the rules and tracks game state.
- `src/engine.js` runs Stockfish in a Web Worker and speaks UCI. AI strength uses
  `UCI_LimitStrength` / `UCI_Elo` across 1320–2850; above 2850 the published Elo
  curve flattens, so the engine runs unconstrained at `Skill Level 20`.
- Analysis uses `MultiPV 3`; move ratings compare the engine's best evaluation
  before the move against the evaluation after the move actually played. Each
  position is evaluated once and cached by FEN, so the ratings and accuracy
  summary refresh after every move without re-analyzing the whole game.
- Accuracy % is derived from the per-move win-probability drop (Lichess-style).
- Opening names come from `src/openings.json`, built from the vendored Lichess
  chess-openings TSVs (`data/eco/*.tsv`, CC0) via `npm run build:openings`.
- The engine files live in `public/engine/` (copied from the `stockfish` npm
  package) so they are served as static assets and work offline.
- `vite-plugin-pwa` generates the service worker and Web App Manifest at build
  time. Workbox precaches every JS/CSS/HTML/WASM/SVG/PNG/JSON asset (cache size
  bumped to 50 MB to fit the Stockfish NNUE), and `registerSW({ immediate: true })`
  in `src/main.js` auto-updates clients when a new build ships.
