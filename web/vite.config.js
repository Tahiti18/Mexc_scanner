import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During local dev you can proxy API to your worker by setting VITE_DEV_PROXY.
// On Railway (static hosting) the app and API are same-origin, so no proxy is used.
const devProxy = process.env.VITE_DEV_PROXY || ''

export default defineConfig({
  plugins: [react()],
  server: devProxy
    ? {
        proxy: {
          // forward API + SSE to your worker while running `npm run dev`
          '^/(alerts|stream|live)': {
            target: devProxy, // e.g. http://localhost:3000
            changeOrigin: true,
            ws: true
          }
        }
      }
    : undefined,
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
