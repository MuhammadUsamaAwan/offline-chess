import { defineConfig } from 'vite';

// base: './' keeps asset paths relative so the production build can be served
// from any static host and stays fully offline.
//
// The multi-threaded Stockfish build uses SharedArrayBuffer, which browsers
// only expose to cross-origin-isolated pages. That requires these two response
// headers on the document. They must also be set by whatever serves the
// production build (a plain static file host or file:// won't enable threads).
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    open: true,
    headers: crossOriginIsolation,
  },
  preview: {
    headers: crossOriginIsolation,
  },
  build: {
    target: 'es2020',
  },
});
