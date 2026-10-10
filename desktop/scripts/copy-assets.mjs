// tsc only emits .js — the preload (CommonJS, for the sandbox), the splash page
// and the tray images ride alongside main.js in dist/.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'

const src = new URL('../src/', import.meta.url)
const dist = new URL('../dist/', import.meta.url)
mkdirSync(dist, { recursive: true })
for (const f of readdirSync(src)) {
  if (/\.(cjs|html|png)$/.test(f)) copyFileSync(new URL(f, src), new URL(f, dist))
}
