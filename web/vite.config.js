import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Usage:
//  VITE_API_BASE is optional. If not set, the app uses the same host it’s served from.
//  For local dev pointing to your Railway worker, run:
//  VITE_API_BASE="https://worker-production-ad5d.up.railway.app" npm run dev

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
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false
  }
});
