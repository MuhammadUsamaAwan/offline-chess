// Thin wrapper around the Stockfish (WASM) Web Worker.
// Multi-threaded build => uses SharedArrayBuffer, so the page must be
// cross-origin isolated (COOP/COEP headers). See README for host requirements.
//
// The engine runs one job at a time. Both "find best move for the AI" and
// "analyze this position" go through the same command pipeline; callers await
// their turn so requests never interleave.

export class Engine {
  constructor(path = './engine/stockfish.js') {
    this.worker = new Worker(path);
    this.ready = false;
    this._listeners = new Set();
    this._queue = Promise.resolve(); // serializes jobs
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : e.data?.data ?? '';
      for (const cb of this._listeners) cb(line);
    };
    this._readyPromise = this._init();
  }

  _send(cmd) {
    this.worker.postMessage(cmd);
  }

  // Wait until a line matching `test` arrives.
  _await(test, { onLine } = {}) {
    return new Promise((resolve) => {
      const cb = (line) => {
        if (onLine) onLine(line);
        const m = test(line);
        if (m) {
          this._listeners.delete(cb);
          resolve(m === true ? line : m);
        }
      };
      this._listeners.add(cb);
    });
  }

  async _init() {
    this._send('uci');
    await this._await((l) => l.startsWith('uciok'));
    // This is the multi-threaded WASM build: splitting the search across cores
    // is the single biggest speedup at high depth. Leave one core for the UI/OS
    // so the page stays responsive while the engine thinks.
    const cores = navigator.hardwareConcurrency || 4;
    this._setoption('Threads', Math.max(1, cores - 1));
    // A larger transposition table lets deeper searches reuse work on
    // transposed positions instead of re-searching them; the payoff grows with
    // depth. With threads pushing deeper, give it more room than the 128 MB
    // single-threaded default.
    this._setoption('Hash', 256);
    this._send('isready');
    await this._await((l) => l.startsWith('readyok'));
    this.ready = true;
  }

  whenReady() {
    return this._readyPromise;
  }

  // Signal a fresh game so the engine resets its hash/history. Searches don't
  // need this per-call — `position fen` fully sets the position — and sending it
  // before every job would wipe the transposition table each time, throwing away
  // the work that makes deeper searches fast. So we send it only here, when the
  // caller actually starts or loads a new game.
  newGame() {
    return this._run(async () => {
      await this._readyPromise;
      this._send('ucinewgame');
      this._send('isready');
      await this._await((l) => l.startsWith('readyok'));
    });
  }

  // Run a job exclusively. `fn` receives a helper to send commands and to
  // collect "info"/"bestmove" output.
  _run(fn) {
    const job = this._queue.then(() => fn());
    // keep the chain alive even if a job throws
    this._queue = job.catch(() => {});
    return job;
  }

  _setoption(name, value) {
    this._send(`setoption name ${name} value ${value}`);
  }

  /**
   * Analyze a position. Streams parsed top lines via onUpdate.
   * @returns {Promise<{lines: Array, bestmove: string}>}
   */
  analyze(fen, { depth = 15, multipv = 3, signal } = {}, onUpdate) {
    return this._run(async () => {
      await this._readyPromise;
      this._setoption('UCI_LimitStrength', 'false');
      this._setoption('MultiPV', multipv);
      this._send(`position fen ${fen}`);

      const lines = new Map(); // multipv index -> info
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        this._send('stop');
      };
      if (signal) {
        if (signal.aborted) return { lines: [], bestmove: null, aborted: true };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this._send(`go depth ${depth}`);
      const result = await this._await(
        (l) => (l.startsWith('bestmove') ? l : false),
        {
          onLine: (l) => {
            if (l.startsWith('info') && l.includes(' pv ')) {
              const info = parseInfo(l);
              if (info && info.multipv) {
                lines.set(info.multipv, info);
                if (onUpdate) onUpdate(sortedLines(lines));
              }
            }
          },
        }
      );
      if (signal) signal.removeEventListener('abort', onAbort);
      const bestmove = result.split(' ')[1];
      return { lines: sortedLines(lines), bestmove, aborted };
    });
  }

  /**
   * Ask the engine for a move at a target Elo. Returns a UCI move string.
   */
  bestMove(fen, { elo = 1500 } = {}) {
    return this._run(async () => {
      await this._readyPromise;
      this._setoption('MultiPV', 1);
      applyStrength(this, elo);
      this._send(`position fen ${fen}`);

      // Weaker levels: cap thinking time/nodes so play is faster *and* worse.
      const movetime = elo < 1000 ? 200 : elo < 1500 ? 400 : elo < 2200 ? 700 : elo < 2850 ? 1000 : 1500;
      this._send(`go movetime ${movetime}`);
      const line = await this._await((l) => (l.startsWith('bestmove') ? l : false));
      return line.split(' ')[1];
    });
  }

  destroy() {
    this.worker.terminate();
  }
}

// Map a target Elo to engine options. Stockfish's UCI_Elo range is 1320..3190;
// above 2850 the published Elo curve flattens, so we let it run unconstrained.
function applyStrength(engine, elo) {
  if (elo > 2850) {
    engine._setoption('UCI_LimitStrength', 'false');
    engine._setoption('Skill Level', 20);
  } else {
    engine._setoption('UCI_LimitStrength', 'true');
    engine._setoption('UCI_Elo', Math.round(elo));
    engine._setoption('Skill Level', 20);
  }
}

function parseInfo(line) {
  const t = line.split(/\s+/);
  const info = { pv: [] };
  for (let i = 0; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': info.depth = +t[++i]; break;
      case 'multipv': info.multipv = +t[++i]; break;
      case 'score':
        info.scoreType = t[++i]; // 'cp' or 'mate'
        info.scoreValue = +t[++i];
        break;
      case 'pv':
        info.pv = t.slice(i + 1);
        i = t.length;
        break;
      default: break;
    }
  }
  return info.scoreType ? info : null;
}

function sortedLines(map) {
  return [...map.values()].sort((a, b) => a.multipv - b.multipv);
}
