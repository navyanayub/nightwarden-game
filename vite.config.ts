import { defineConfig } from 'vite';

// Static build for GitHub Pages: https://<user>.github.io/nightwarden-game/
export default defineConfig({
  base: '/nightwarden-game/',
  publicDir: 'public',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    assetsDir: 'static',
    target: 'es2022',
    chunkSizeWarningLimit: 7000,
    sourcemap: false,
  },
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
});
