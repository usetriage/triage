#!/usr/bin/env node
/**
 * `triage` — lifecycle wrapper around the server (server/index.ts).
 *
 *   triage             start the server in the background if it isn't running
 *   triage serve       run the server in the foreground (debugging, launchd)
 *   triage stop        stop the background server
 *   triage restart     stop + start (picks up a newly installed version)
 *   triage status      is it running, where, since when
 *   triage logs        print the tail of ~/.triage/server.log
 *   triage install     keep it running: a macOS LaunchAgent (restarts after reboot/crash)
 *   triage uninstall   remove the LaunchAgent
 *   triage doctor      check the environment watches depend on
 *
 * "Is triage running" is always decided by GET /api/health — a pid file can
 * lie after a crash or reboot; the health check cannot. The state file
 * (~/.triage/server.json) only records the port so stop/status/restart can
 * find a server started with --port.
 *
 * Port conflicts fail fast with a message instead of auto-incrementing: the
 * MCP shim and browser bookmarks assume a stable port, so silently moving
 * to 5179 would break every other consumer.
 */
import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  DEFAULT_PORT,
  LOG_FILE,
  TRIAGE_DIR,
  checkHealth,
  pkgVersion,
  readState,
  type Health,
} from './state.js'
import {
  installLaunchAgent,
  kickstartLaunchAgent,
  launchAgentInstalled,
  launchAgentLoaded,
  launchAgentPlist,
  loadLaunchAgent,
  uninstallLaunchAgent,
  unloadLaunchAgent,
} from './launchd.js'

// --- styling -----------------------------------------------------------------
// Dependency-free ANSI. Colors turn off when piped or when NO_COLOR is set.

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = paint('1')
const dim = paint('2')
const red = paint('31')
const green = paint('32')
const yellow = paint('33')
const cyan = paint('36')

const execFileP = promisify(execFile)
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const tilde = (p: string) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p)

/** Rounded box around pre-styled lines (width measured without ANSI codes). */
function box(lines: string[]) {
  const width = Math.max(...lines.map((l) => stripAnsi(l).length))
  console.log(dim('╭' + '─'.repeat(width + 4) + '╮'))
  for (const line of lines) {
    const pad = ' '.repeat(width - stripAnsi(line).length)
    console.log(dim('│') + '  ' + line + pad + '  ' + dim('│'))
  }
  console.log(dim('╰' + '─'.repeat(width + 4) + '╯'))
}

const row = (label: string, value: string) => dim(label.padEnd(9)) + value

const HELP = `
  ${bold('triage')} ${dim('v' + pkgVersion())} — ranked work inbox for engineers

  ${bold('Usage')}
    ${cyan('triage')}             start the server in the background ${dim('(no-op if running)')}
    ${cyan('triage serve')}       run the server in the foreground
    ${cyan('triage stop')}        stop the background server
    ${cyan('triage restart')}     stop, then start ${dim('(picks up a newly installed version)')}
    ${cyan('triage status')}      show whether the server is running and where
    ${cyan('triage logs')}        print the tail of the server log

  ${bold('Keep it running')} ${dim('(macOS — watches only run while triage runs)')}
    ${cyan('triage install')}     install a LaunchAgent: starts at login, restarts after a crash
    ${cyan('triage uninstall')}   remove the LaunchAgent
    ${cyan('triage doctor')}      check node, claude, gh, the agent, and the server

  ${bold('Workspaces')} ${dim('(.docs/workspaces.md)')}
    ${cyan('triage workspace list')}              list workspaces ${dim('(default marked *)')}
    ${cyan('triage workspace create <name>')}     create a workspace ${dim('(--color #rrggbb)')}
    ${cyan('triage workspace use <name|id>')}     make a workspace the default

  ${bold('Desktop app')} ${dim('(macOS)')}
    ${cyan('triage app install')}    install Triage.app ${dim('(opens the UI in its own window)')}
    ${cyan('triage app uninstall')}  remove Triage.app

  ${bold('Options')}
    ${cyan('--port <n>')}         port to serve on ${dim(`(default ${DEFAULT_PORT}; PORT env works too)`)}
    ${cyan('--color <hex>')}      workspace color for ${cyan('workspace create')}
    ${cyan('--version')}          print the version
    ${cyan('--help')}             show this help

  ${bold('Files')}
    ${dim('~/.triage/server.log')}        server output when started in the background
    ${dim('~/.triage/server.json')}       pid/port of the last started server
    ${dim('~/.triage/workspaces.json')}   the workspace registry
    ${dim('~/.triage/workspaces/<id>/')}  each workspace's DB and auth material
`

function die(message: string): never {
  console.error(`${red('✗')} triage: ${message}`)
  process.exit(1)
}

// --- argv ------------------------------------------------------------------

const args = process.argv.slice(2)
let explicitPort: number | null = null
let explicitColor: string | null = null
const positional: string[] = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--help' || a === '-h') {
    console.log(HELP)
    process.exit(0)
  } else if (a === '--version' || a === '-v') {
    console.log(pkgVersion())
    process.exit(0)
  } else if (a === '--port') {
    explicitPort = Number(args[++i])
  } else if (a.startsWith('--port=')) {
    explicitPort = Number(a.slice('--port='.length))
  } else if (a === '--color') {
    explicitColor = args[++i] ?? null
  } else if (a.startsWith('--color=')) {
    explicitColor = a.slice('--color='.length)
  } else if (a.startsWith('-')) {
    die(`unknown option ${a} — try ${cyan('triage --help')}`)
  } else {
    positional.push(a)
  }
}
if (explicitColor !== null && !/^#[0-9a-fA-F]{6}$/.test(explicitColor)) {
  die(`--color needs a hex color, e.g. ${cyan('--color #7aa2f7')}`)
}
if (explicitPort !== null && (!Number.isInteger(explicitPort) || explicitPort <= 0 || explicitPort > 65535)) {
  die(`--port needs a port number, e.g. ${cyan('--port 5179')}`)
}
const command = positional[0] ?? 'start'

/**
 * Which port to talk to. A fresh start uses the default unless overridden;
 * stop/status/restart/logs prefer the port the last server recorded, so they
 * find a --port server without the flag being repeated.
 */
async function resolvePort(forStart: boolean): Promise<number> {
  if (explicitPort !== null) return explicitPort
  if (process.env.PORT) return Number(process.env.PORT)
  if (!forStart) {
    const state = await readState()
    if (state?.port) return state.port
  }
  return DEFAULT_PORT
}

// --- commands ---------------------------------------------------------------

function printRunning(health: Health, verb: string, showDb = false) {
  const lines = [
    `${green('●')} ${bold(`triage ${verb}`)}`,
    '',
    `${dim('→')} ${bold(cyan(`http://triage.localhost:${health.port}`))}`,
    `${dim('  also http://localhost:' + health.port)}`,
    '',
    row('version', health.version),
    row('pid', String(health.pid)),
  ]
  if (health.liveSessions > 0) {
    lines.push(row('sessions', yellow(`${health.liveSessions} live`)))
  }
  lines.push(row('logs', tilde(LOG_FILE)))
  if (showDb) lines.push(row('db', tilde(health.db)))
  lines.push('', `${cyan('triage restart')} ${dim('·')} ${cyan('triage stop')} ${dim('·')} ${cyan('triage logs')}`)
  box(lines)
}

async function logTail(lines: number): Promise<string> {
  try {
    const log = await readFile(LOG_FILE, 'utf8')
    return log.trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

async function start(port: number) {
  const health = await checkHealth(port)
  if (health === 'other') {
    die(
      `port ${port} is in use by something that isn't triage — pick another port: ${cyan(`triage --port ${port + 1}`)}`,
    )
  }
  if (health) {
    printRunning(health, 'is already running')
    return
  }

  if (launchAgentInstalled()) {
    // The LaunchAgent owns the process: load it and wait for health.
    await loadLaunchAgent()
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      const up = await checkHealth(port)
      if (up && up !== 'other') {
        printRunning(up, 'started (LaunchAgent)')
        return
      }
    }
    die(`the LaunchAgent did not bring triage up on port ${port} within 15s — check ${cyan('triage logs')}`)
  }

  await mkdir(TRIAGE_DIR, { recursive: true })
  const logFd = openSync(LOG_FILE, 'a')
  // Re-invoke this same script with `serve`, detached, logging to the file.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(port) },
  })
  let exited: number | null = null
  child.on('exit', (code) => {
    exited = code ?? 1
  })
  child.unref()

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    if (exited !== null) {
      const tail = await logTail(15)
      console.error(`${red('✗')} triage: server exited before it came up ${dim(`(code ${exited})`)}`)
      if (tail) console.error(dim(tail))
      process.exit(1)
    }
    const up = await checkHealth(port)
    if (up && up !== 'other') {
      printRunning(up, 'started')
      return
    }
  }
  die(`server did not come up on port ${port} within 15s — check ${cyan('triage logs')}`)
}

async function stop(port: number): Promise<boolean> {
  const health = await checkHealth(port)
  if (health === 'other') {
    die(`port ${port} is in use by something that isn't triage — nothing to stop`)
  }
  if (!health) {
    const state = await readState()
    if (state && state.port === port && isAlive(state.pid)) {
      die(
        `process ${state.pid} from ${TRIAGE_DIR}/server.json is alive but not answering ` +
          `/api/health — not touching it; if it's a hung triage, run ${cyan(`kill ${state.pid}`)}`,
      )
    }
    console.log(`${dim('○')} triage is not running`)
    return false
  }

  if (health.liveSessions > 0) {
    console.log(
      `${yellow('!')} stopping ends ${bold(String(health.liveSessions))} live Claude session${health.liveSessions === 1 ? '' : 's'}`,
    )
  }
  // KeepAlive would restart a killed server: unload the agent first. It loads
  // again on `triage start` or at the next login.
  if (launchAgentInstalled()) await unloadLaunchAgent()
  process.kill(health.pid, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    if (!isAlive(health.pid)) {
      console.log(`${green('✓')} triage stopped ${dim(`(pid ${health.pid})`)}`)
      return true
    }
  }
  process.kill(health.pid, 'SIGKILL')
  console.log(`${yellow('!')} triage did not exit within 10s — killed ${dim(`(pid ${health.pid})`)}`)
  return true
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function status(port: number) {
  const health = await checkHealth(port)
  if (health === 'other') {
    console.log(`${dim('○')} triage is not running ${dim(`(port ${port} is in use by something else)`)}`)
    process.exitCode = 1
    return
  }
  if (!health) {
    console.log(`${dim('○')} triage is not running — start it with ${cyan('triage')}`)
    process.exitCode = 1
    return
  }
  printRunning(health, 'is running', true)
}

async function logs() {
  const tail = await logTail(50)
  if (!tail) {
    console.log(
      `${dim('○')} no log file yet at ${tilde(LOG_FILE)} — the server hasn't been started in the background`,
    )
    return
  }
  console.log(tail)
  console.log(dim(`\n(full log: ${tilde(LOG_FILE)})`))
}

// --- workspaces ---------------------------------------------------------------
// Prefer the running server's API (it owns the registry while it's up — edits
// behind its back would diverge from the runtimes it already built); fall back
// to the registry file only when no server is running.

type WireWorkspace = { id: string; name: string; color: string; authBackend: string; isDefault: boolean }

async function serverPort(): Promise<number | null> {
  const port = await resolvePort(false)
  const health = await checkHealth(port)
  return health && health !== 'other' ? port : null
}

function printWorkspaces(rows: WireWorkspace[]) {
  for (const w of rows) {
    const mark = w.isDefault ? green('*') : ' '
    console.log(`${mark} ${bold(w.name)} ${dim(`(${w.id} · ${w.authBackend})`)}`)
  }
}

async function workspaceCmd(sub: string | undefined, name: string | undefined) {
  const { loadRegistry, saveRegistry, slugify, ensureWorkspaceDirs } = await import('./workspaces.js')
  const port = await serverPort()

  if (sub === 'list' || sub === undefined) {
    if (port) {
      const body = (await (await fetch(`http://localhost:${port}/api/workspaces`)).json()) as {
        ok: boolean
        workspaces?: WireWorkspace[]
        error?: string
      }
      if (!body.ok || !body.workspaces) die(body.error ?? 'could not list workspaces')
      printWorkspaces(body.workspaces)
    } else {
      const reg = loadRegistry()
      printWorkspaces(reg.workspaces.map((w) => ({ ...w, isDefault: w.id === reg.defaultId })))
    }
    return
  }

  if (sub === 'create') {
    if (!name) die(`workspace create needs a name, e.g. ${cyan('triage workspace create work')}`)
    if (port) {
      const body = (await (
        await fetch(`http://localhost:${port}/api/workspaces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, ...(explicitColor ? { color: explicitColor } : {}) }),
        })
      ).json()) as { ok: boolean; workspace?: WireWorkspace; error?: string }
      if (!body.ok || !body.workspace) die(body.error ?? 'could not create the workspace')
      console.log(`${green('✓')} created workspace ${bold(body.workspace.name)} ${dim(`(${body.workspace.id})`)}`)
    } else {
      const reg = loadRegistry()
      let id = slugify(name)
      for (let n = 2; reg.workspaces.some((w) => w.id === id); n++) id = `${slugify(name)}-${n}`
      reg.workspaces.push({ id, name, color: explicitColor ?? '#7aa2f7', authBackend: 'inherit', createdAt: Date.now() })
      ensureWorkspaceDirs(id)
      saveRegistry(reg)
      console.log(`${green('✓')} created workspace ${bold(name)} ${dim(`(${id})`)} — picked up on the next server start`)
    }
    return
  }

  if (sub === 'use') {
    if (!name) die(`workspace use needs a name or id, e.g. ${cyan('triage workspace use work')}`)
    const reg = loadRegistry()
    const match = reg.workspaces.find((w) => w.id === name || w.name.toLowerCase() === name.toLowerCase())
    if (!match) die(`no workspace named "${name}" — see ${cyan('triage workspace list')}`)
    if (port) {
      const body = (await (
        await fetch(`http://localhost:${port}/api/workspaces/default`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: match.id }),
        })
      ).json()) as { ok: boolean; error?: string }
      if (!body.ok) die(body.error ?? 'could not switch the default workspace')
    } else {
      reg.defaultId = match.id
      saveRegistry(reg)
    }
    console.log(`${green('✓')} default workspace is now ${bold(match.name)} ${dim(`(${match.id})`)}`)
    return
  }

  die(`unknown workspace command "${sub}" — try ${cyan('triage workspace list')}`)
}

// --- macOS desktop app --------------------------------------------------------
// A dependency-free way to run triage in its own window, Dock icon and Cmd-Tab
// entry with no browser chrome: a tiny .app bundle whose launcher opens the UI
// in a dedicated, chromeless Chrome profile (Chrome's --app mode). macOS only;
// the eventual native app replaces this. Nothing here touches the server.

const APP_NAME = 'Triage.app'
const CHROME_APPS = [
  '/Applications/Google Chrome.app',
  path.join(os.homedir(), 'Applications/Google Chrome.app'),
]

/** The 1024px master icon shipped in the package (dist/web) or the dev tree. */
function iconMasterPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(here, '..', 'web', 'icon-1024.png'), // published: dist/server → dist/web
    path.join(here, '..', '..', 'web', 'public', 'icon-1024.png'), // dev: server → web/public
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Rasterize a multi-resolution .icns from a PNG master via sips + iconutil. */
async function buildIcns(masterPng: string, outIcns: string) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'triage-icon-'))
  const iconset = path.join(tmp, 'icon.iconset')
  mkdirSync(iconset)
  const sizes: [number, string][] = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ]
  for (const [px, name] of sizes) {
    await execFileP('sips', ['-s', 'format', 'png', '-z', String(px), String(px), masterPng, '--out', path.join(iconset, name)])
  }
  await execFileP('iconutil', ['-c', 'icns', iconset, '-o', outIcns])
  rmSync(tmp, { recursive: true, force: true })
}

const infoPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Triage</string>
  <key>CFBundleDisplayName</key><string>Triage</string>
  <key>CFBundleIdentifier</key><string>sh.usetriage.app</string>
  <key>CFBundleVersion</key><string>${pkgVersion()}</string>
  <key>CFBundleShortVersionString</key><string>${pkgVersion()}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>triage-launcher</string>
  <key>CFBundleIconFile</key><string>triage</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`

const launcherScript = (port: number) => `#!/bin/bash
# Triage — opens the local UI in a chromeless Chrome app window. Reuses the
# already-running Chrome (default profile) so the window pops instantly; a
# dedicated --user-data-dir would cold-start a second Chrome and feel slow.
URL="http://triage.localhost:${port}/"
# Best-effort, non-blocking: nudge the daemon up without delaying the window.
( command -v triage >/dev/null 2>&1 && triage start ) >/dev/null 2>&1 &
CHROME=""
for C in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
  [ -x "$C" ] && CHROME="$C" && break
done
# No Chrome? Fall back to the default browser so the app still works.
[ -n "$CHROME" ] || { open "$URL"; exit 0; }
exec "$CHROME" --app="$URL"
`

/** Prefer /Applications; fall back to ~/Applications when it isn't writable. */
function chooseAppDir(): string {
  const system = '/Applications'
  const probe = path.join(system, '.triage-write-probe')
  try {
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return path.join(system, APP_NAME)
  } catch {
    const user = path.join(os.homedir(), 'Applications')
    mkdirSync(user, { recursive: true })
    return path.join(user, APP_NAME)
  }
}

async function appInstall(port: number) {
  if (process.platform !== 'darwin') die(`${cyan('triage app install')} is macOS only`)
  if (!CHROME_APPS.some((p) => existsSync(p))) {
    die(`Google Chrome not found — install it, then re-run ${cyan('triage app install')}`)
  }

  const appDir = chooseAppDir()
  rmSync(appDir, { recursive: true, force: true })
  const macos = path.join(appDir, 'Contents', 'MacOS')
  const resources = path.join(appDir, 'Contents', 'Resources')
  mkdirSync(macos, { recursive: true })
  mkdirSync(resources, { recursive: true })

  writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), infoPlist())
  const launcher = path.join(macos, 'triage-launcher')
  writeFileSync(launcher, launcherScript(port))
  chmodSync(launcher, 0o755)

  const master = iconMasterPath()
  if (master) {
    try {
      await buildIcns(master, path.join(resources, 'triage.icns'))
    } catch {
      // The icon is cosmetic — a bad sips/iconutil shouldn't fail the install.
    }
  }
  // Reclaim the dedicated Chrome profile older versions created — the launcher
  // now reuses the default profile, so this directory is dead weight.
  rmSync(path.join(os.homedir(), '.triage', 'app-chrome'), { recursive: true, force: true })
  // Nudge LaunchServices to register the new bundle so the icon appears.
  await execFileP('touch', [appDir]).catch(() => {})

  box([
    `${green('●')} ${bold('Triage.app installed')}`,
    '',
    row('where', tilde(appDir)),
    row('opens', cyan(`http://triage.localhost:${port}`)),
    '',
    `${dim('Open it from Spotlight or Launchpad, then')} ${bold('right-click its Dock icon → Options → Keep in Dock')}`,
    `${dim('Remove it with')} ${cyan('triage app uninstall')}`,
  ])
}

function appUninstall() {
  if (process.platform !== 'darwin') die(`${cyan('triage app')} is macOS only`)
  const targets = [path.join('/Applications', APP_NAME), path.join(os.homedir(), 'Applications', APP_NAME)]
  let removed = false
  for (const t of targets) {
    if (existsSync(t)) {
      rmSync(t, { recursive: true, force: true })
      console.log(`${green('✓')} removed ${tilde(t)}`)
      removed = true
    }
  }
  if (!removed) console.log(`${dim('○')} no ${APP_NAME} is installed`)
}

async function appCmd(sub: string | undefined) {
  const port = explicitPort ?? DEFAULT_PORT
  if (sub === 'install' || sub === undefined) return appInstall(port)
  if (sub === 'uninstall' || sub === 'remove') return appUninstall()
  die(`unknown app command "${sub}" — try ${cyan('triage app install')}`)
}

// --- keep it running (LaunchAgent) ---------------------------------------------

async function install(port: number) {
  if (process.platform !== 'darwin') die(`${cyan('triage install')} is macOS only — run ${cyan('triage serve')} under your own service manager`)
  const script = fileURLToPath(import.meta.url)
  if (script.endsWith('.ts')) {
    die(`install from the published package, not a dev checkout (${tilde(script)}) — ${cyan('npm i -g usetriage')}, then ${cyan('triage install')}`)
  }
  // A background server started by hand would fight the agent for the port.
  const health = await checkHealth(port)
  if (health && health !== 'other' && !(await launchAgentLoaded())) await stop(port)
  await mkdir(TRIAGE_DIR, { recursive: true })
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir() }
  for (const k of ['TRIAGE_HOME', 'TRIAGE_DB', 'CLAUDE_CONFIG_DIR', 'LANG']) if (process.env[k]) env[k] = process.env[k]!
  await installLaunchAgent({ node: process.execPath, script, port, logFile: LOG_FILE, env })
  const deadline = Date.now() + 15_000
  let up: Health | null = null
  while (Date.now() < deadline && !up) {
    await new Promise((r) => setTimeout(r, 250))
    const h = await checkHealth(port)
    if (h && h !== 'other') up = h
  }
  box([
    `${green('●')} ${bold('LaunchAgent installed')}`,
    '',
    row('agent', tilde(launchAgentPlist())),
    row('node', tilde(process.execPath)),
    row('server', up ? green(`up on :${port} (pid ${up.pid})`) : yellow(`not answering yet — check ${cyan('triage logs')}`)),
    '',
    dim('triage now starts at login and restarts if it crashes.'),
    `${dim('Remove it with')} ${cyan('triage uninstall')}`,
  ])
}

async function uninstall() {
  if (process.platform !== 'darwin') die(`${cyan('triage uninstall')} is macOS only`)
  const had = await uninstallLaunchAgent()
  console.log(had ? `${green('✓')} LaunchAgent removed — triage is stopped; ${cyan('triage')} starts it by hand` : `${dim('○')} no LaunchAgent is installed`)
}

async function doctor(port: number) {
  let failures = 0
  const check = (ok: boolean | null, label: string, detail: string, fix?: string) => {
    if (ok === false) failures += 1
    const mark = ok === null ? yellow('!') : ok ? green('✓') : red('✗')
    console.log(`${mark} ${label.padEnd(10)} ${detail}${ok === false && fix ? dim(`  → ${fix}`) : ''}`)
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  check(major > 22 || (major === 22 && minor >= 5), 'node', `${process.versions.node} ${dim(tilde(process.execPath))}`, 'Node 22.5 or newer is required')
  const version = async (bin: string) => (await execFileP(bin, ['--version'])).stdout.trim().split('\n')[0]
  const claude = await version('claude').catch(() => null)
  check(claude !== null, 'claude', claude ?? 'not found on PATH', 'install Claude Code, or fix PATH')
  const gh = await version('gh').catch(() => null)
  check(gh === null ? null : true, 'gh', gh ?? 'not found — GitHub watches and the GitHub source need it')
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  check(existsSync(claudeDir) ? true : null, 'claude dir', tilde(claudeDir))
  if (process.platform === 'darwin') {
    const installed = launchAgentInstalled()
    const loaded = installed ? await launchAgentLoaded() : false
    check(installed ? loaded : null, 'agent', installed ? (loaded ? 'installed and loaded' : 'installed but not loaded') : `not installed — watches stop after a reboot`, `triage start (loads it)`)
    if (!installed) console.log(dim(`             install it with ${cyan('triage install')}`))
  }
  const health = await checkHealth(port)
  if (health === 'other') check(false, 'server', `port ${port} is in use by something else`)
  else if (!health) check(false, 'server', `not answering on :${port}`, 'triage')
  else check(health.version === pkgVersion(), 'server', `up on :${port} · v${health.version}${health.version === pkgVersion() ? '' : ` (this CLI is v${pkgVersion()})`}`, 'triage restart')
  if (failures) process.exitCode = 1
}

// --- dispatch ----------------------------------------------------------------

switch (command) {
  case 'start':
    await start(await resolvePort(true))
    break
  case 'serve':
    // Foreground: hand over to the server module (it listens on import).
    await import('./index.js')
    break
  case 'stop':
    await stop(await resolvePort(false))
    break
  case 'restart': {
    const port = await resolvePort(false)
    if (launchAgentInstalled() && (await launchAgentLoaded())) {
      await kickstartLaunchAgent()
      console.log(`${green('✓')} restarting via the LaunchAgent`)
      await start(port)
      break
    }
    await stop(port)
    await start(port)
    break
  }
  case 'install':
    await install(await resolvePort(true))
    break
  case 'uninstall':
    await uninstall()
    break
  case 'doctor':
    await doctor(await resolvePort(false))
    break
  case 'status':
    await status(await resolvePort(false))
    break
  case 'logs':
    await logs()
    break
  case 'workspace':
  case 'workspaces':
    await workspaceCmd(positional[1], positional[2])
    break
  case 'app':
    await appCmd(positional[1])
    break
  default:
    die(`unknown command "${command}" — try ${cyan('triage --help')}`)
}
