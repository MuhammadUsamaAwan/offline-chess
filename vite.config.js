import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,svg,png,ico,json}'],
        maximumFileSizeToCacheInBytes: 50 * 1024 * 1024,
      },
      manifest: {
        name: 'Offline Chess Analyzer',
        short_name: 'Chess',
        description: 'Play chess vs Stockfish with live analysis. Fully offline.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#1a1a1a',
        theme_color: '#1a1a1a',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
          { src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
        ],
      },
    }),
  ],
});
