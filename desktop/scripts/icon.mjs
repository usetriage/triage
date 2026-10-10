// build/icon.icns from web/public/icon-1024.png — the same sips + iconutil
// recipe as buildIcns in server/cli.ts. Skipped when the icns is newer than
// the master PNG. Run directly (`node scripts/icon.mjs`) or import buildIcon.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const master = path.resolve(desktop, '../web/public/icon-1024.png')
const out = path.join(desktop, 'build/icon.icns')

const SIZES = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
]

export function buildIcon({ force = false } = {}) {
  if (!force && existsSync(out) && statSync(out).mtimeMs >= statSync(master).mtimeMs) {
    return { path: out, built: false }
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'triage-icon-'))
  try {
    const iconset = path.join(tmp, 'icon.iconset')
    mkdirSync(iconset)
    for (const [px, name] of SIZES) {
      execFileSync('sips', ['-s', 'format', 'png', '-z', String(px), String(px), master, '--out', path.join(iconset, name)], { stdio: 'ignore' })
    }
    mkdirSync(path.dirname(out), { recursive: true })
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return { path: out, built: true }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { path: p, built } = buildIcon({ force: process.argv.includes('--force') })
  console.log(built ? `built ${path.relative(process.cwd(), p)}` : `${path.relative(process.cwd(), p)} is up to date`)
}
