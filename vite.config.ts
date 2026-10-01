import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/** The node server (API + WebSocket) that the dev server proxies back to. */
const SERVER_PORT = Number(process.env.PORT || 5188)

/** Repo root (this file's dir). The Vite root is `web/`, but brand assets live
 * in `assets/` at the repo root, reachable from client code as `@assets/…`. */
const repoRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: { '@assets': fileURLToPath(new URL('./assets', import.meta.url)) },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5189,
    strictPort: true,
    // `TRIAGE_DEV_LAN=1 npm run dev` to try the UI from a phone. The server
    // still wants the pairing token: xfwd tells it the request came from the
    // phone, not from this proxy on loopback.
    host: process.env.TRIAGE_DEV_LAN === '1' ? true : undefined,
    // `web/` is the Vite root; allow serving the sibling `assets/` in dev.
    fs: { allow: [repoRoot] },
    // Same-origin in dev, so the client's `ws://${location.host}/ws` works
    // unchanged whether it is served by Vite or by the node server.
    proxy: {
      '/api': { target: `http://localhost:${SERVER_PORT}`, xfwd: true },
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true, xfwd: true },
    },
  },
})
