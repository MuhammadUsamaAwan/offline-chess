// Build src/openings.json from the vendored Lichess chess-openings TSVs
// (data/eco/*.tsv, CC0). Run with: npm run build:openings
//
// Emits two structures:
//   entries: [{ eco, name, pgn }]        -> drives opening search / load
//   byEpd:   { "<epd>": entryIndex }     -> O(1) live naming + the explorer.
//            Keyed by the first 4 FEN fields (board, side, castling, ep),
//            matching fenKey() in main.js. A position is recorded only for the
//            opening whose mainline *ends* there (its terminal position);
//            intermediate positions inherit the last named opening via the
//            carry-forward in main.js. On transposition the shortest line wins.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Chess } from 'chess.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ecoDir = join(root, 'data', 'eco');

const epdOf = (fen) => fen.split(' ').slice(0, 4).join(' ');

// Collect rows from every <letter>.tsv, skipping the header line.
const rows = [];
for (const file of readdirSync(ecoDir).filter((f) => f.endsWith('.tsv')).sort()) {
  const text = readFileSync(join(ecoDir, file), 'utf8');
  for (const line of text.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const [eco, name, pgn] = line.split('\t');
    if (eco && name && pgn) rows.push({ eco, name, pgn: pgn.trim() });
  }
}

// Replay a PGN's mainline and return the epd of its terminal position.
function terminalEpd(pgn) {
  const game = new Chess();
  const sans = pgn
    .replace(/\b\d+\.(\.\.)?/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const san of sans) game.move(san); // TSV is canonical; a throw is a real data error
  return epdOf(game.fen());
}

// Sort by PGN length so shorter (more general) lines are written first and win
// when two openings transpose to the same terminal position.
rows.sort((a, b) => a.pgn.length - b.pgn.length);

const entries = rows.map(({ eco, name, pgn }) => ({ eco, name, pgn }));
const byEpd = {};
entries.forEach((entry, i) => {
  const epd = terminalEpd(entry.pgn);
  if (!(epd in byEpd)) byEpd[epd] = i;
});

const out = { entries, byEpd };
writeFileSync(join(root, 'src', 'openings.json'), JSON.stringify(out));
console.log(
  `Wrote ${entries.length} openings, ${Object.keys(byEpd).length} positions ` +
    `(${(JSON.stringify(out).length / 1024).toFixed(0)} KB).`
);
