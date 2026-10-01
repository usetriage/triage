/**
 * Phone access: letting a device on the same network use this daemon.
 *
 * The daemon listens on every interface, but a connection that does not come
 * from this machine is dropped at accept unless phone access is switched on —
 * so "off" behaves exactly like a loopback-only bind, and switching it on or
 * off never means restarting the server (which would kill every live Claude
 * subprocess).
 *
 * With it on, a non-local request needs the pairing token: once from the QR
 * code's `/api/pair?token=` link, which trades it for an HttpOnly cookie, and
 * from then on as that cookie (or an `Authorization: Bearer` header). Local
 * means the socket is loopback *and* the Host header names loopback — a DNS
 * rebinding page reaches 127.0.0.1 under its own hostname, so it is treated
 * as remote and has no token. A loopback proxy in front of us (Vite in dev,
 * `tailscale serve`) is seen through via X-Forwarded-For.
 *
 * The token lives in ~/.triage/remote.json at 0600. Rotating it unpairs every
 * device at once. Typing it on a phone is no fun, so Settings shows a 6-digit
 * pairing code instead: single use, ten minutes, burned after five misses —
 * short enough to type, too short-lived to guess (5 tries in a million).
 */
import { execFileSync } from 'node:child_process'
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { TRIAGE_DIR } from './state.js'

export const REMOTE_FILE = path.join(TRIAGE_DIR, 'remote.json')
export const TOKEN_COOKIE = 'triage_token'
/** 400 days, the longest lifetime browsers honour. */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60

export interface RemoteConfig {
  enabled: boolean
  token: string
  /** also reachable from the internet, through an ngrok tunnel (server/tunnel.ts) */
  tunnel: boolean
}

export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

export function loadRemote(file = REMOTE_FILE): RemoteConfig {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RemoteConfig>
    if (typeof raw.token === 'string' && raw.token.length >= 16) return { enabled: raw.enabled === true, token: raw.token, tunnel: raw.tunnel === true }
  } catch {
    // missing or unreadable: off, with a fresh token ready for when it is turned on
  }
  return { enabled: false, token: newToken(), tunnel: false }
}

export async function saveRemote(cfg: RemoteConfig, file = REMOTE_FILE): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  await chmod(file, 0o600)
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  return a === '::1' || a.startsWith('127.')
}

/** `localhost:5178` → `localhost`, `[::1]:5178` → `::1`. */
export function hostnameOf(host: string | undefined): string {
  if (!host) return ''
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']')).toLowerCase()
  const colon = host.lastIndexOf(':')
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase()
}

export function isLoopbackHostname(h: string): boolean {
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || isLoopbackAddress(h)
}

/** A local-network address: RFC 1918, link-local, Tailscale's 100.64/10, IPv6 ULA and link-local. */
export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  const m = /^(\d+)\.(\d+)\./.exec(a)
  if (m) {
    const [x, y] = [Number(m[1]), Number(m[2])]
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127)
  }
  return /^f[cd]/i.test(a) || /^fe[89ab]/i.test(a)
}

/**
 * Whether this request may pair with the 6-digit code: only a device talking
 * to us directly from the local network. Anything proxied — the ngrok tunnel
 * above all — needs the QR code's long token; six digits are no defence
 * against the whole internet. Read off the socket, so no header can fake it.
 */
export function codesAllowed(req: http.IncomingMessage): boolean {
  const sock = req.socket.remoteAddress
  return !isLoopbackAddress(sock) && isPrivateAddress(sock)
}

/** Where the request really comes from: the socket, unless a loopback proxy says otherwise. */
export function clientAddress(req: http.IncomingMessage): string | undefined {
  const sock = req.socket.remoteAddress
  const fwd = req.headers['x-forwarded-for']
  if (!isLoopbackAddress(sock) || !fwd) return sock
  // The proxy appends the address it saw; anything before that is the client's say-so.
  const hops = (Array.isArray(fwd) ? fwd.join(',') : fwd).split(',')
  return hops[hops.length - 1].trim() || sock
}

function cookie(req: http.IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

function presentedToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  return cookie(req, TOKEN_COOKIE)
}

export function tokenMatches(given: string | undefined | null, token: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const PAIR_CODE_TTL_MS = 10 * 60_000
export const PAIR_CODE_MAX_MISSES = 5

export interface PairCode {
  code: string
  expiresAt: number
  misses: number
}

export function newPairCode(now: number): PairCode {
  return { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: now + PAIR_CODE_TTL_MS, misses: 0 }
}

/** The code to show: the current one while it lasts, else a fresh one. */
export function livePairCode(pc: PairCode | null, now: number): PairCode {
  return pc && now < pc.expiresAt && pc.misses < PAIR_CODE_MAX_MISSES ? pc : newPairCode(now)
}

/**
 * Spend a typed code. Right: paired, and the code is used up. Wrong: one more
 * miss, and enough misses burn it — Settings then shows a new one.
 */
export function tryPairCode(pc: PairCode | null, typed: string, now: number): { ok: boolean; next: PairCode | null } {
  if (!pc || now >= pc.expiresAt || pc.misses >= PAIR_CODE_MAX_MISSES) return { ok: false, next: null }
  if (tokenMatches(typed.replace(/\D/g, ''), pc.code)) return { ok: true, next: null }
  const misses = pc.misses + 1
  return { ok: false, next: misses >= PAIR_CODE_MAX_MISSES ? null : { ...pc, misses } }
}

/** `local`: this machine. `paired`: a device holding the token. `denied`: anyone else. */
export type Access = 'local' | 'paired' | 'denied'

export function accessOf(req: http.IncomingMessage, cfg: RemoteConfig): Access {
  if (isLoopbackAddress(clientAddress(req)) && isLoopbackHostname(hostnameOf(req.headers.host))) return 'local'
  if (!cfg.enabled) return 'denied'
  return tokenMatches(presentedToken(req), cfg.token) ? 'paired' : 'denied'
}

/**
 * Whether a browser request comes from our own page: no Origin (not a
 * browser), a loopback origin on a local request, or an origin naming the
 * very host the request was sent to. Any page can make a browser POST or open
 * a WebSocket to us; this is what stops it.
 */
export function sameOrigin(req: http.IncomingMessage, access: Access): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const o = new URL(origin)
    if (access === 'local' && isLoopbackHostname(o.hostname.replace(/^\[|\]$/g, ''))) return true
    return o.host === req.headers.host
  } catch {
    return false
  }
}

export function pairCookie(token: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`
}

export interface LanAddress {
  name: string
  address: string
}

/** The addresses a phone on the same network could reach us on: IPv4, not loopback. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address })
    }
  }
  // Wi-Fi / Ethernet (en*) first; VPN and bridge interfaces after.
  return out.sort((x, y) => Number(!x.name.startsWith('en')) - Number(!y.name.startsWith('en')))
}

let bonjour: string | null | undefined
/** `Your-Mac.local` — survives the router handing out a new IP. macOS only; null elsewhere. */
export function bonjourName(): string | null {
  if (bonjour !== undefined) return bonjour
  try {
    const name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim()
    bonjour = name ? `${name}.local` : null
  } catch {
    bonjour = null
  }
  return bonjour
}

/** The typed-code half of the pairing page — offered only where codes are accepted (codesAllowed). */
const CODE_FORM = `<p>Or type the 6-digit code shown there:</p>
<form method="get" action="/api/pair"><input name="code" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" autocomplete="one-time-code" placeholder="000 000" aria-label="Pairing code" autofocus><button>Pair</button></form>`

/** The page an unpaired device gets: what to do, plus a box for the code. */
export function pairPageHtml(error?: string, codes = true): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<title>triage — pair this device</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; background: #000; color: rgba(252,253,255,0.86);
    font: 15px/1.5 Inter, -apple-system, system-ui, sans-serif; display: grid; place-items: center; }
  main { width: min(26rem, calc(100vw - 48px)); padding: 48px 0; }
  h1 { font: 400 32px/1.1 "Domaine Display", Georgia, serif; color: #fcfdff; margin: 0 0 16px; letter-spacing: -0.3px; }
  p { margin: 0 0 16px; color: #a1a4a5; }
  b { color: #fcfdff; font-weight: 500; }
  form { display: flex; gap: 8px; margin-top: 24px; }
  input { flex: 1; min-width: 0; height: 52px; padding: 0 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14);
    background: #0a0a0c; color: #fcfdff; font: 22px "Geist Mono", ui-monospace, monospace; letter-spacing: 0.2em; text-align: center; }
  button { height: 52px; padding: 0 18px; border-radius: 9999px; border: 0; background: #fcfdff; color: #000; font: 500 14px Inter, system-ui, sans-serif; }
  .err { color: #ff2047; }
</style></head><body><main>
<h1>Pair this device.</h1>
<p>This is a triage running on your Mac. On the Mac, open <b>Settings → Phone</b> and scan the QR code with this device's camera.</p>
${error ? `<p class="err">${error}</p>` : ''}
${codes ? CODE_FORM : ''}
</main></body></html>`
}
