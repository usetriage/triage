/**
 * Phone access (server/remote.ts): who counts as this machine, who needs the
 * pairing token, and which pages may write.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type http from 'node:http'
import {
  accessOf,
  codesAllowed,
  hostnameOf,
  isPrivateAddress,
  livePairCode,
  newPairCode,
  PAIR_CODE_MAX_MISSES,
  PAIR_CODE_TTL_MS,
  sameOrigin,
  tokenMatches,
  tryPairCode,
  type RemoteConfig,
} from '../server/remote.js'

const TOKEN = 'a'.repeat(32)
const on: RemoteConfig = { enabled: true, token: TOKEN, tunnel: false }
const off: RemoteConfig = { enabled: false, token: TOKEN, tunnel: false }

function req(remoteAddress: string, headers: Record<string, string>): http.IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as http.IncomingMessage
}

test('hostnameOf: strips the port, unwraps IPv6', () => {
  assert.equal(hostnameOf('localhost:5178'), 'localhost')
  assert.equal(hostnameOf('[::1]:5178'), '::1')
  assert.equal(hostnameOf('192.168.1.20:5178'), '192.168.1.20')
  assert.equal(hostnameOf(undefined), '')
})

test('accessOf: loopback socket and loopback host is this machine, on or off', () => {
  for (const cfg of [on, off]) {
    assert.equal(accessOf(req('127.0.0.1', { host: 'localhost:5178' }), cfg), 'local')
    assert.equal(accessOf(req('::ffff:127.0.0.1', { host: '127.0.0.1:5178' }), cfg), 'local')
    assert.equal(accessOf(req('::1', { host: '[::1]:5178' }), cfg), 'local')
  }
})

test('accessOf: DNS rebinding reaches loopback under a foreign host and is not local', () => {
  assert.equal(accessOf(req('127.0.0.1', { host: 'evil.example:5178' }), off), 'denied')
  assert.equal(accessOf(req('127.0.0.1', { host: 'evil.example:5178' }), on), 'denied')
})

test('accessOf: another device needs access on and the token', () => {
  const lan = (headers: Record<string, string>) => req('192.168.1.40', { host: '192.168.1.20:5178', ...headers })
  assert.equal(accessOf(lan({}), on), 'denied')
  assert.equal(accessOf(lan({ cookie: `triage_token=${TOKEN}` }), off), 'denied')
  assert.equal(accessOf(lan({ cookie: `triage_ws=x; triage_token=${TOKEN}` }), on), 'paired')
  assert.equal(accessOf(lan({ authorization: `Bearer ${TOKEN}` }), on), 'paired')
  assert.equal(accessOf(lan({ cookie: 'triage_token=wrong' }), on), 'denied')
})

test('accessOf: a loopback proxy forwarding a phone is the phone, whatever Host it claims', () => {
  const proxied = (headers: Record<string, string>) => req('127.0.0.1', { 'x-forwarded-for': '192.168.1.40', ...headers })
  assert.equal(accessOf(proxied({ host: 'localhost:5189' }), on), 'denied')
  assert.equal(accessOf(proxied({ host: '192.168.1.20:5189', cookie: `triage_token=${TOKEN}` }), on), 'paired')
  // A client-supplied loopback entry before the proxy's own does not count.
  assert.equal(accessOf(proxied({ host: 'localhost:5189', 'x-forwarded-for': '127.0.0.1, 192.168.1.40' }), on), 'denied')
  // The proxy in dev, forwarding this machine's own browser, is still local.
  assert.equal(accessOf(proxied({ host: 'localhost:5189', 'x-forwarded-for': '127.0.0.1' }), on), 'local')
})

test('sameOrigin: our own page writes; other pages do not', () => {
  const local = (origin?: string) => req('127.0.0.1', { host: 'localhost:5188', ...(origin ? { origin } : {}) })
  assert.equal(sameOrigin(local(), 'local'), true, 'no Origin: not a browser')
  assert.equal(sameOrigin(local('http://localhost:5189'), 'local'), true, 'the Vite dev page')
  assert.equal(sameOrigin(local('https://evil.example'), 'local'), false)
  const phone = (origin: string) => req('192.168.1.40', { host: '192.168.1.20:5178', origin })
  assert.equal(sameOrigin(phone('http://192.168.1.20:5178'), 'paired'), true)
  assert.equal(sameOrigin(phone('http://localhost:5178'), 'paired'), false, 'loopback origins only count for local requests')
  assert.equal(sameOrigin(phone('https://evil.example'), 'paired'), false)
})

test('tokenMatches: exact, length-safe', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true)
  assert.equal(tokenMatches(TOKEN.slice(1), TOKEN), false)
  assert.equal(tokenMatches(undefined, TOKEN), false)
  assert.equal(tokenMatches('', TOKEN), false)
})

test('pair code: six digits, works once', () => {
  const pc = newPairCode(0)
  assert.match(pc.code, /^\d{6}$/)
  const spaced = `${pc.code.slice(0, 3)} ${pc.code.slice(3)}`
  assert.deepEqual(tryPairCode(pc, spaced, 1000), { ok: true, next: null }, 'typed with a space still counts')
  assert.equal(tryPairCode(null, pc.code, 1000).ok, false, 'used up: the same digits do nothing')
})

test('pair code: expires, and live replaces it', () => {
  const pc = newPairCode(0)
  assert.equal(tryPairCode(pc, pc.code, PAIR_CODE_TTL_MS).ok, false)
  assert.equal(livePairCode(pc, PAIR_CODE_TTL_MS - 1), pc, 'still showing the same code before it lapses')
  assert.notEqual(livePairCode(pc, PAIR_CODE_TTL_MS), pc)
})

test('pair code: enough misses burn it, even the right digits after', () => {
  let pc: ReturnType<typeof newPairCode> | null = { code: '123456', expiresAt: PAIR_CODE_TTL_MS, misses: 0 }
  for (let i = 0; i < PAIR_CODE_MAX_MISSES; i++) {
    const r = tryPairCode(pc, '000000', 1)
    assert.equal(r.ok, false)
    pc = r.next
  }
  assert.equal(pc, null)
  assert.equal(tryPairCode(pc, '123456', 1).ok, false)
})

test('isPrivateAddress: home, office, Tailscale and link-local nets; not the internet', () => {
  for (const a of ['192.168.1.40', '10.0.0.5', '172.20.1.1', '100.101.102.103', '169.254.3.4', '::ffff:192.168.1.40', 'fe80::1', 'fd12::3'])
    assert.equal(isPrivateAddress(a), true, a)
  for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2a00:1450::1', '127.0.0.1', undefined]) assert.equal(isPrivateAddress(a), false, String(a))
})

test('codesAllowed: a direct local-network socket only — never through a tunnel, whatever it claims', () => {
  assert.equal(codesAllowed(req('192.168.1.40', {})), true)
  assert.equal(codesAllowed(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.40', host: 'abc.ngrok-free.app' })), false)
  assert.equal(codesAllowed(req('8.8.8.8', {})), false)
})
