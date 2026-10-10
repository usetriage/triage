/**
 * Find, start and restart the local triage daemon from the Electron main
 * process (ARCHITECTURE.md). The app attaches, it does not own: the daemon is
 * started with the same `cli.js start` path `triage start` uses, so it is
 * detached (or handed to the LaunchAgent) and survives the app quitting.
 *
 * Deliberately free of an `electron` import — packaging is detected from the
 * bundled runtime on disk — so this module also loads under plain node.
 */
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Mirrors `Health` in server/state.ts. */
export type DaemonHealth = { app: 'triage'; version: string; pid: number; port: number; db: string; liveSessions: number }

/** TRIAGE_APP_PORT lets the app be tested against an isolated daemon; else DEFAULT_PORT. */
export const PORT: number = Number(process.env.TRIAGE_APP_PORT) || 5178

export function daemonUrl(): string {
  return `http://localhost:${PORT}/`
}

/** Mirrors LOG_FILE in server/state.ts. */
export function logFile(): string {
  return path.join(process.env.TRIAGE_HOME || path.join(os.homedir(), '.triage'), 'server.log')
}

/**
 * Same three outcomes as `checkHealth` in server/state.ts: a health body,
 * 'other' (the port answers, or hangs, but isn't triage), null (nothing listens).
 */
export async function probe(): Promise<DaemonHealth | 'other' | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(1500),
    })
    const body: unknown = await res.json().catch(() => null)
    return isHealth(body) ? body : 'other'
  } catch (err) {
    // A timeout means something holds the port but won't answer HTTP —
    // that is "other", not "free". Connection refused means nothing listens.
    return (err as { name?: string })?.name === 'TimeoutError' ? 'other' : null
  }
}

function isHealth(body: unknown): body is DaemonHealth {
  return typeof body === 'object' && body !== null && (body as DaemonHealth).app === 'triage'
}

/**
 * Which node runs which cli.js. Packaged = the official Node binary shipped in
 * Resources (the server needs node:sqlite, so not Electron-as-node). Unpackaged
 * = the system node and the repo's own build (`npm run build` at the root).
 * The dev lookup uses the login-shell PATH once `loginShellEnv()` has run.
 */
export function runtime(): { node: string; cli: string; bundled: boolean } {
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (resources) {
    const node = path.join(resources, 'node', 'bin', 'node')
    if (existsSync(node)) {
      return { node, cli: path.join(resources, 'triage', 'dist', 'server', 'cli.js'), bundled: true }
    }
  }
  // desktop/dist/daemon.js → <repo>/dist/server/cli.js
  const here = path.dirname(fileURLToPath(import.meta.url))
  return {
    node: whichNode(cachedEnv?.PATH ?? fallbackPath()) ?? 'node',
    cli: path.resolve(here, '..', '..', 'dist', 'server', 'cli.js'),
    bundled: false,
  }
}

function whichNode(PATH: string): string | null {
  for (const dir of PATH.split(':')) {
    if (!dir) continue
    const candidate = path.join(dir, 'node')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

let cachedEnv: NodeJS.ProcessEnv | null = null

/**
 * The environment the daemon runs with. A Finder-launched app gets only
 * /usr/bin:/bin:/usr/sbin:/sbin, so `claude`, `gh` and `git` would not resolve:
 * PATH comes from the user's login shell, read once. Electron's own variables
 * are dropped — ELECTRON_RUN_AS_NODE leaking into the daemon would change how
 * every node it spawns behaves.
 */
export async function loginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cachedEnv) return cachedEnv
  let PATH = (await shellPath()) ?? fallbackPath()
  // Bundled node first, so the Agent SDK's `node` is the one that has node:sqlite.
  const bundled = runtime()
  if (bundled.bundled) PATH = dedupe([path.dirname(bundled.node), ...PATH.split(':')]).join(':')
  const env: NodeJS.ProcessEnv = { ...process.env, PATH }
  for (const key of Object.keys(env)) if (key.startsWith('ELECTRON_')) delete env[key]
  cachedEnv = env
  return env
}

const PATH_START = '__TRIAGE_PATH__'
const PATH_END = '__TRIAGE_END__'

/** `$SHELL -ilc`, with markers: rc files may print banners or junk around it. */
function shellPath(): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${PATH_START}%s${PATH_END}' "$PATH"`],
      // DISABLE_AUTO_UPDATE: oh-my-zsh's update prompt would sit on the timeout.
      { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' }, maxBuffer: 1024 * 1024 },
      (_err, stdout) => {
        const out = String(stdout ?? '')
        const start = out.lastIndexOf(PATH_START)
        const end = out.indexOf(PATH_END, start)
        const value = start >= 0 && end > start ? out.slice(start + PATH_START.length, end).trim() : ''
        resolve(value.includes('/') ? value : null)
      },
    ).stdin?.end()
  })
}

function fallbackPath(): string {
  const home = os.homedir()
  return dedupe([
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    ...(process.env.PATH ?? '').split(':'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]).join(':')
}

function dedupe(dirs: string[]): string[] {
  return [...new Set(dirs.filter(Boolean))]
}

/** Find a running triage, or start one; resolves once /api/health answers. */
export async function ensureDaemon(onStatus?: (msg: string) => void): Promise<DaemonHealth> {
  const health = await probe()
  if (health === 'other') {
    throw new Error(`port ${PORT} is used by something that isn't triage — quit it, or set TRIAGE_APP_PORT to another port`)
  }
  if (health) return health
  onStatus?.('Starting triage…')
  const out = await runCli('start')
  return waitForHealth(out, () => true)
}

/**
 * `cli.js restart` — through the LaunchAgent when it's loaded, else stop +
 * start. Done means a *different* pid answers health, not the old one
 * still on its way down.
 */
export async function restartDaemon(): Promise<DaemonHealth> {
  const before = await probe()
  const oldPid = before && before !== 'other' ? before.pid : null
  const out = await runCli('restart')
  return waitForHealth(out, (h) => h.pid !== oldPid)
}

type CliResult = { code: number | null; output: string }

/** Run the CLI to completion. `start` returns once the detached server is up (or failed). */
async function runCli(command: 'start' | 'restart'): Promise<CliResult> {
  const env = { ...(await loginShellEnv()), PORT: String(PORT) }
  const { node, cli, bundled } = runtime()
  if (!existsSync(cli)) {
    throw new Error(`triage is not built — ${cli} is missing${bundled ? '' : ' (run `npm run build` at the repo root)'}`)
  }
  return new Promise((resolve, reject) => {
    // The server it launches is detached with its own stdio (the log file),
    // so these pipes close when the CLI itself exits.
    const child = spawn(node, [cli, command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    // The CLI waits up to 15s (plus a 10s stop on restart); don't hang forever past that.
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`could not run ${node}: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output: output.trim() })
    })
  })
}

async function waitForHealth(cli: CliResult, accept: (h: DaemonHealth) => boolean): Promise<DaemonHealth> {
  const deadline = Date.now() + 20_000
  while (true) {
    const health = await probe()
    if (health && health !== 'other' && accept(health)) return health
    // A CLI that failed already waited for the server itself; don't wait twice.
    if (cli.code !== 0 || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 250))
  }
  const parts = [`triage did not come up on port ${PORT}${cli.code ? ` (cli exited ${cli.code})` : ''}`]
  if (cli.output) parts.push(cli.output)
  const tail = await logTail(20)
  if (tail) parts.push(`${logFile()}:\n${tail}`)
  throw new Error(parts.join('\n\n'))
}

async function logTail(lines: number): Promise<string> {
  try {
    const log = await readFile(logFile(), 'utf8')
    return log.trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}
