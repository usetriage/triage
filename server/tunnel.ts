/**
 * Phone access from anywhere: an ngrok tunnel to this daemon.
 *
 * The daemon runs the user's own `ngrok` (their install, their account, their
 * authtoken) as a child process and reads the public URL from its JSON log.
 * Nothing about access changes: ngrok forwards from loopback under its own
 * hostname, which server/remote.ts already treats as remote — so every
 * request through the tunnel still needs the pairing token.
 *
 * A stand-in until triage has its own relay (or a Cloudflare tunnel); the
 * interface here — start, stop, a status with a URL — is what either would
 * implement too.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TunnelStatus } from '../shared/protocol.js'
import { TRIAGE_DIR } from './state.js'


/** The last agent we started, so a daemon that died without cleaning up does not leave one holding the account's session. */
const PID_FILE = path.join(TRIAGE_DIR, 'ngrok.pid')

/** Turn ngrok's error into something to act on; its own messages bury the fix. */
function explain(raw: string): string {
  if (/ERR_NGROK_4018|authtoken/i.test(raw)) return 'ngrok needs your authtoken: sign up free at ngrok.com, then run `ngrok config add-authtoken <token>`.'
  if (/ERR_NGROK_108|simultaneous|session limit/i.test(raw)) return 'ngrok is already running somewhere else on this account (the free plan allows one at a time). Stop it, then try again.'
  if (/ERR_NGROK_334|already online/i.test(raw)) return 'Your ngrok domain is already in use by another ngrok on this account (the free plan has one domain). Stop that one (`pkill ngrok`), then try again.'
  return raw.trim() || 'ngrok stopped unexpectedly.'
}

export class NgrokTunnel {
  #child: ChildProcess | null = null
  #status: TunnelStatus = { state: 'off' }
  #onChange: () => void

  constructor(onChange: () => void = () => {}) {
    this.#onChange = onChange
  }

  get status(): TunnelStatus {
    return this.#status
  }

  #set(s: TunnelStatus) {
    this.#status = s
    this.#onChange()
  }

  start(port: number): void {
    if (this.#child) return
    killStale()
    this.#set({ state: 'starting' })
    let child: ChildProcess
    try {
      child = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.#set({ state: 'error', error: String(err) })
      return
    }
    this.#child = child
    let lastError = ''
    let buf = ''
    const onLine = (line: string) => {
      type LogRecord = { lvl?: string; msg?: string; url?: string; err?: string }
      let rec: LogRecord
      try {
        rec = JSON.parse(line) as LogRecord
      } catch {
        // ngrok also echoes its fatal error as plain `ERROR:` lines; keep the first useful one, the JSON record wins
        const text = line.replace(/^ERROR:\s*/, '').trim()
        if (text && !lastError) lastError = text
        return
      }
      if (rec.msg === 'started tunnel' && rec.url?.startsWith('https://')) this.#set({ state: 'up', url: rec.url })
      else if (rec.lvl === 'eror' || rec.lvl === 'crit') lastError = rec.err || rec.msg || lastError
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk: string) => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        lines.forEach(onLine)
      })
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      this.#child = null
      this.#set({
        state: 'error',
        error: err.code === 'ENOENT' ? 'ngrok is not installed: `brew install ngrok`, then `ngrok config add-authtoken <token>`.' : String(err),
      })
    })
    child.on('exit', () => {
      if (this.#child !== child) return // stopped on purpose
      this.#child = null
      void rm(PID_FILE, { force: true })
      this.#set({ state: 'error', error: explain(lastError) })
    })
    if (child.pid) void writeFile(PID_FILE, String(child.pid))
  }

  stop(): void {
    const child = this.#child
    this.#child = null
    if (child) child.kill('SIGTERM')
    void rm(PID_FILE, { force: true })
    if (this.#status.state !== 'off') this.#set({ state: 'off' })
  }
}

/** Kill an agent a previous daemon left behind — but only if that pid is still an ngrok. */
function killStale() {
  let pid: number
  try {
    pid = Number(readFileSync(PID_FILE, 'utf8').trim())
  } catch {
    return
  }
  if (!Number.isInteger(pid) || pid <= 1) return
  try {
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim()
    if (path.basename(comm) === 'ngrok') process.kill(pid, 'SIGTERM')
  } catch {
    // not running any more
  }
}
