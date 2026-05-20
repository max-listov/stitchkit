import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const BACKEND = 'http://localhost:3461';

// Plain Vite + React SPA. The stitchkit backend runs as a separate process;
// dev requests to /api and /ws are proxied to it.
export default defineConfig({
  server: {
    port: 3460,
    proxy: {
      '/api': BACKEND,
      '/ws': { target: BACKEND.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist/client',
  },
  resolve: {
    alias: {
      '@client': resolve(__dirname, 'src/client'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  plugins: [tailwindcss(), react()],
});
