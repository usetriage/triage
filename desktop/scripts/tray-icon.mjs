// Renders the menu-bar template images (src/trayTemplate.png + @2x) from the
// triage mark (assets/brand/triage-mark.svg) — three round-capped strokes and a
// dot — with plain node:zlib, so no image tooling is needed. Black glyph on
// alpha: macOS tints template images for light/dark menu bars.
// Run: node scripts/tray-icon.mjs
import { writeFileSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'

// The mark, in its 48×48 viewBox.
const STROKE = 5.5
const segments = [[9, 40, 25, 12.3], [20, 40, 30, 22.7], [31, 40, 36, 31.3]]
const dot = { x: 42.5, y: 40, r: 2.9 }
// The square of the viewBox to frame: the mark's ink box plus a hair of air.
const FRAME = { x: 4.5, y: 5, size: 42 }

const segDist = (px, py, [x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}
const inside = (x, y) =>
  segments.some((s) => segDist(x, y, s) <= STROKE / 2) || Math.hypot(x - dot.x, y - dot.y) <= dot.r

function render(px) {
  const SS = 8 // supersamples per axis, for the anti-aliased edge
  const scale = FRAME.size / px
  const rows = []
  for (let y = 0; y < px; y++) {
    const row = Buffer.alloc(1 + px * 4) // filter byte 0 + RGBA, RGB stays 0 (black)
    for (let x = 0; x < px; x++) {
      let hits = 0
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++)
          if (inside(FRAME.x + (x + (sx + 0.5) / SS) * scale, FRAME.y + (y + (sy + 0.5) / SS) * scale)) hits++
      row[1 + x * 4 + 3] = Math.round((hits / (SS * SS)) * 255)
    }
    rows.push(row)
  }
  return png(px, px, Buffer.concat(rows))
}

function png(w, h, raw) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 18pt sits like the system's own menu-bar glyphs.
const out = new URL('../src/', import.meta.url)
writeFileSync(new URL('trayTemplate.png', out), render(18))
writeFileSync(new URL('trayTemplate@2x.png', out), render(36))
console.log('wrote src/trayTemplate.png, src/trayTemplate@2x.png')
