import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Usage notes:
// - No dev proxy here. In production (Railway static), the app calls the worker via absolute URL
//   if you set VITE_API_BASE. Otherwise it uses same-origin.
// - Build outputs to /web/dist (served by Railway with `npx serve -s dist` or Caddy).

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173
  },
  preview: {
    host: true,
    port: 5173
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false
  }
});
