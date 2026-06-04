import { defineConfig } from 'vite';

// base: './' keeps asset paths relative so the production build can be opened
// from any folder (e.g. served by any static host) and stays fully offline.
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    open: true,
  },
  build: {
    target: 'es2020',
  },
});
