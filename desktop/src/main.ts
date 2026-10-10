/**
 * Triage.app's main process (ARCHITECTURE.md): windows over the local daemon,
 * a menu, a menu-bar icon. The app attaches, it does not own — quitting it
 * never stops the daemon, so live sessions and watches carry on.
 *
 * One main window, which only hides on close so the app lives on in the Dock;
 * opening a workspace "in a new tab" (the switcher's ⌘-click / external icon)
 * opens a second window on that workspace's URL (`/w/<id>/`), which closes for real.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type Rectangle,
} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PORT, daemonUrl, ensureDaemon, logFile, probe, restartDaemon, type DaemonHealth } from './daemon.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SPLASH = path.join(here, 'splash.html')
const SPLASH_URL = pathToFileURL(SPLASH).href
const DEFAULT_SIZE = { width: 1360, height: 880 }
const MIN_SIZE = { width: 900, height: 600 }

type SplashStatus = { state: 'starting' | 'error'; text: string; detail?: string }

let win: BrowserWindow | null = null // the main window
const extra = new Set<BrowserWindow>() // workspace windows opened from it
// Where each window goes once the daemon answers — and goes back to after a
// reconnect, so a workspace window comes back on its own workspace.
const target = new WeakMap<BrowserWindow, string>()
let tray: Tray | null = null
let quitting = false
// One connect at a time: did-fail-load, the watchdog and Retry all funnel here.
let connecting = false
let lastAutoConnect = 0
let splash: SplashStatus = { state: 'starting', text: 'Looking for triage…' }

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(start)
}

function start() {
  nativeTheme.themeSource = 'dark'
  Menu.setApplicationMenu(buildMenu())
  createTray()
  ipcMain.on('splash:retry', () => void connect())
  ipcMain.on('splash:open-log', () => void openLog())
  // The web UI's ← → buttons. Hash routes are history entries, so the
  // window's own navigation history is the app's history.
  ipcMain.on('nav:back', (e) => goBack(windowOf(e.sender)))
  ipcMain.on('nav:forward', (e) => goForward(windowOf(e.sender)))
  ipcMain.handle('nav:state', (e) => navState(windowOf(e.sender)))
  win = createWindow(daemonUrl())
  void connect()
  setInterval(watchdog, 5000)
}

// ── window ─────────────────────────────────────────────────────────────────

/**
 * A window over the daemon, headed for `url` (the main window: the daemon's
 * root; a workspace window: its `/w/<id>/`). It shows the splash until the
 * daemon answers, then loads its target.
 */
function createWindow(url: string, bounds?: Partial<Rectangle>): BrowserWindow {
  const main = !bounds
  const state = main ? loadWindowState() : { bounds: { ...DEFAULT_SIZE, ...bounds }, maximized: false }
  const w = new BrowserWindow({
    ...state.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'Triage',
    backgroundColor: '#000000',
    // No grey title bar: the traffic lights sit inside triage's own 44px bar
    // (web/src/components/TopBar.tsx, desktop layout), centred vertically.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--triage-version=${app.getVersion()}`],
    },
  })
  target.set(w, url)
  if (state.maximized) w.maximize()
  w.once('ready-to-show', () => w.show())

  if (main) {
    // Closing hides: the app lives on in the Dock and the menu bar until ⌘Q.
    w.on('close', (e) => {
      saveWindowState()
      if (!quitting) {
        e.preventDefault()
        w.hide()
      }
    })
    w.on('closed', () => (win = null))
    let saveTimer: NodeJS.Timeout | undefined
    const saveSoon = () => {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(saveWindowState, 500)
    }
    w.on('resize', saveSoon)
    w.on('move', saveSoon)
    w.on('maximize', saveSoon)
    w.on('unmaximize', saveSoon)
  } else {
    extra.add(w)
    w.on('closed', () => extra.delete(w))
  }
  // Fullscreen hides the traffic lights, so the bar drops their inset.
  w.on('enter-full-screen', () => sendNav(w))
  w.on('leave-full-screen', () => sendNav(w))

  const wc = w.webContents
  wc.on('did-finish-load', () => {
    if (onSplash(w)) wc.send('splash:status', splash)
    else {
      sendNav(w)
      void fitLegacyBar(wc)
    }
  })
  // In-page moves count too: the SPA pins its workspace with replaceState, and a
  // reconnect should land back on the same route.
  wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
    if (isMainFrame && isDaemonUrl(navUrl)) target.set(w, navUrl)
    sendNav(w)
  })
  // A full navigation inside triage (switching workspace) moves the window's target with it.
  wc.on('did-navigate', (_e, navUrl) => {
    if (isDaemonUrl(navUrl)) target.set(w, navUrl)
  })
  // Links out of triage go to the default browser. A same-origin window.open
  // (the workspace switcher's "open in a new tab") opens a workspace window.
  wc.setWindowOpenHandler(({ url: openUrl }) => {
    if (isDaemonUrl(openUrl)) openWorkspaceWindow(openUrl, w)
    else openExternal(openUrl)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, navUrl) => {
    if (isDaemonUrl(navUrl) || navUrl === SPLASH_URL) return
    e.preventDefault()
    openExternal(navUrl)
  })
  // The daemon went away under a load (restart, crash, `triage stop`).
  wc.on('did-fail-load', (_e, code, _desc, failUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: superseded by another load */ || !isDaemonUrl(failUrl)) return
    reconnect()
  })
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') reconnect()
  })
  return w
}

/** `/w/<id>/` of a daemon URL, or '' for a bare one (the cookie decides). */
function workspaceOf(raw: string): string {
  try {
    return /^\/w\/([^/]+)\/?/.exec(new URL(raw).pathname)?.[1] ?? ''
  } catch {
    return ''
  }
}

/**
 * A workspace in its own window: focus the window already on it, else open one
 * cascaded off the window that asked. A window still on the splash loads it
 * once the daemon answers; otherwise it goes straight there.
 */
function openWorkspaceWindow(url: string, from: BrowserWindow) {
  const ws = workspaceOf(url)
  const existing = ws ? allWindows().find((w) => workspaceOf(target.get(w) ?? '') === ws) : undefined
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }
  const b = from.getNormalBounds()
  const w = createWindow(url, { x: b.x + 28, y: b.y + 28, width: b.width, height: b.height })
  if (connecting) void w.loadFile(SPLASH)
  else void loadTarget(w)
}

const allWindows = (): BrowserWindow[] => [...(win ? [win] : []), ...extra].filter((w) => !w.isDestroyed())

const windowOf = (sender: Electron.WebContents): BrowserWindow | null => BrowserWindow.fromWebContents(sender)

/**
 * A daemon older than the desktop title bar (web/src/desktop.ts) serves a UI
 * that doesn't draw one, so its top bar would sit under the traffic lights.
 * Give that bar the lights' inset and make it the drag handle instead.
 */
async function fitLegacyBar(wc: Electron.WebContents) {
  const modern = await wc.executeJavaScript(`document.documentElement.classList.contains('desktop-mac')`).catch(() => true)
  if (modern) return
  await wc.insertCSS(
    '.topbar { padding-left: 84px !important; -webkit-app-region: drag; }' +
      '.topbar button, .topbar [role="button"] { -webkit-app-region: no-drag; }',
  )
}

function showWindow() {
  if (!app.isReady()) return // a Dock click or second launch racing startup; start() opens the window
  if (!win) {
    win = createWindow(daemonUrl())
    void connect()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

const onSplash = (w: BrowserWindow): boolean => !w.isDestroyed() && w.webContents.getURL() === SPLASH_URL

// ── connecting ─────────────────────────────────────────────────────────────

function setSplash(s: SplashStatus) {
  splash = s
  for (const w of allWindows()) if (onSplash(w)) w.webContents.send('splash:status', s)
}

/** The window's own target, with the splash's history cleared so Back can't land on it. */
async function loadTarget(w: BrowserWindow) {
  await w.loadURL(target.get(w) ?? daemonUrl())
  w.webContents.navigationHistory.clear()
  sendNav(w)
}

/**
 * Every window to the splash → find or start the daemon (or restart it) →
 * each window back to its target. Errors stay on the splash.
 */
async function connect(how: 'ensure' | 'restart' = 'ensure') {
  if (connecting || allWindows().length === 0) return
  connecting = true
  try {
    setSplash({ state: 'starting', text: how === 'restart' ? 'Restarting triage…' : 'Looking for triage…' })
    await Promise.all(allWindows().map((w) => (onSplash(w) ? undefined : w.loadFile(SPLASH))))
    if (how === 'restart') await restartDaemon()
    else await ensureDaemon((text) => setSplash({ state: 'starting', text }))
    await Promise.all(allWindows().map((w) => loadTarget(w)))
  } catch (err) {
    await Promise.all(allWindows().map((w) => (onSplash(w) ? undefined : w.loadFile(SPLASH).catch(() => {}))))
    // daemon.ts errors are "headline\n\ncli output\n\nlog tail".
    const msg = err instanceof Error ? err.message : String(err)
    const cut = msg.indexOf('\n\n')
    const head = cut === -1 ? msg : msg.slice(0, cut)
    setSplash({
      state: 'error',
      text: head.charAt(0).toUpperCase() + head.slice(1),
      detail: cut === -1 ? undefined : msg.slice(cut + 2),
    })
  } finally {
    connecting = false
  }
}

/**
 * An automatic reconnect, at most once per 10s — a daemon that keeps failing
 * to load ends on the splash's error, waiting for Retry, instead of a loop.
 */
function reconnect() {
  if (connecting || allWindows().length === 0) return
  if (Date.now() - lastAutoConnect < 10_000) {
    void Promise.all(allWindows().map((w) => w.loadFile(SPLASH))).then(() =>
      setSplash({ state: 'error', text: 'Triage stopped answering', detail: `Nothing at ${daemonUrl()} — Retry to start it again, or check the log.` }),
    )
    return
  }
  lastAutoConnect = Date.now()
  void connect()
}

// A loaded SPA doesn't fail a load when the daemon dies — its socket just
// drops. Two misses in a row (not one: `triage restart` is a short gap) sends
// every window back to the splash. And a splash showing an error recovers on
// its own once a daemon appears.
let misses = 0
async function watchdog() {
  const windows = allWindows()
  if (connecting || windows.length === 0) return
  const health = await probe()
  if (windows.some(onSplash)) {
    if (splash.state === 'error' && health && health !== 'other') void connect()
    return
  }
  // 'other' includes a busy daemon that missed the 1.5s probe — not gone.
  misses = health === null ? misses + 1 : 0
  if (misses >= 2) {
    misses = 0
    reconnect()
  }
}

async function confirmRestart(message = 'Restart the triage server?') {
  if (connecting) return
  const parent = BrowserWindow.getFocusedWindow() ?? (showWindow(), win)
  if (!parent) return
  const health = await probe()
  const live = health && health !== 'other' ? health.liveSessions : 0
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    message,
    detail:
      (live
        ? `This stops ${live} live session${live === 1 ? '' : 's'} mid-turn. `
        : 'Any live session is stopped. ') +
      'Each one picks up again on its next message. Watches skip a beat; nothing is lost.',
    buttons: ['Restart', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  })
  if (response === 0) void connect('restart')
}

// ── navigation ─────────────────────────────────────────────────────────────

type NavState = { canGoBack: boolean; canGoForward: boolean; fullscreen: boolean }

function navState(w: BrowserWindow | null): NavState {
  const h = w && !w.isDestroyed() ? w.webContents.navigationHistory : null
  return { canGoBack: !!h?.canGoBack(), canGoForward: !!h?.canGoForward(), fullscreen: !!w?.isFullScreen() }
}

function goBack(w: BrowserWindow | null) {
  if (w && navState(w).canGoBack) w.webContents.navigationHistory.goBack()
}

function goForward(w: BrowserWindow | null) {
  if (w && navState(w).canGoForward) w.webContents.navigationHistory.goForward()
}

/** Push ← → availability (and fullscreen) to a window's web UI after every move. */
function sendNav(w: BrowserWindow) {
  if (!w.isDestroyed() && !onSplash(w)) w.webContents.send('nav:state', navState(w))
}

// ── menu + tray ────────────────────────────────────────────────────────────

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Open in Browser', click: () => void shell.openExternal(daemonUrl()) },
        { label: 'Open server log', click: () => void openLog() },
        { label: 'Restart triage server…', click: () => void confirmRestart() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: (_i, w) => goBack(w instanceof BrowserWindow ? w : null) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: (_i, w) => goForward(w instanceof BrowserWindow ? w : null) },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'usetriage.sh', click: () => void shell.openExternal('https://usetriage.sh') },
        { label: 'Triage on GitHub', click: () => void shell.openExternal('https://github.com/usetriage/triage') },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

function createTray() {
  // The "Template" suffix makes macOS tint it for light and dark menu bars;
  // trayTemplate@2x.png is picked up beside it.
  const icon = nativeImage.createFromPath(path.join(here, 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Triage')
  // Built on each open so the status line is current.
  const open = async () => tray?.popUpContextMenu(await trayMenu())
  tray.on('click', open)
  tray.on('right-click', open)
}

async function trayMenu(): Promise<Menu> {
  // Don't let a hung port hold the menu up.
  const health = await Promise.race([probe(), new Promise<undefined>((r) => setTimeout(r, 600))])
  return Menu.buildFromTemplate([
    { label: 'Open Triage', click: showWindow },
    { label: statusLine(health), enabled: false },
    // Never restarted for you: it would stop live sessions.
    ...(isStale(health)
      ? [{ label: 'Restart to update server…', click: () => void confirmRestart(`Restart triage to update its server to v${app.getVersion()}?`) }]
      : []),
    { type: 'separator' },
    { label: 'Open in Browser', click: () => void shell.openExternal(daemonUrl()) },
    { label: 'Restart server…', click: () => void confirmRestart() },
    { type: 'separator' },
    { label: 'Quit Triage', click: () => app.quit() },
  ])
}

function statusLine(health: DaemonHealth | 'other' | null | undefined): string {
  if (health === undefined) return 'triage · not answering'
  if (health === null) return 'triage · not running'
  if (health === 'other') return `port ${PORT} · not triage`
  if (isStale(health)) return `triage v${health.version} running · app v${app.getVersion()}`
  const n = health.liveSessions
  return `triage v${health.version} · ${n} live session${n === 1 ? '' : 's'}`
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * After an app upgrade the running daemon can still be the old one — it keeps
 * running across app quits. Unpackaged, the app's version says nothing about
 * the server's (dev runs the repo build), so only a packaged app compares.
 */
function isStale(health: DaemonHealth | 'other' | null | undefined): boolean {
  return app.isPackaged && !!health && health !== 'other' && health.version !== app.getVersion()
}

/** The daemon's origin: any loopback name (prod is triage.localhost) at PORT. */
function isDaemonUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    const host = u.hostname
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
    return (u.protocol === 'http:' || u.protocol === 'ws:') && loopback && Number(u.port || 80) === PORT
  } catch {
    return false
  }
}

// Only schemes a browser or mail client should handle — never file: or app handlers.
function openExternal(url: string) {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
}

async function openLog() {
  const err = await shell.openPath(logFile())
  if (err) dialog.showErrorBox('No server log yet', `${logFile()}\n\n${err}`)
}

type WindowState = { bounds: Partial<Rectangle> & { width: number; height: number }; maximized: boolean }

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')

function loadWindowState(): WindowState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as { bounds?: Rectangle; maximized?: boolean }
    const b = s.bounds
    if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite)) {
      // Clamp to the display it was on — or the nearest, if that one is gone.
      const area = screen.getDisplayMatching(b).workArea
      const width = Math.min(Math.max(b.width, MIN_SIZE.width), area.width)
      const height = Math.min(Math.max(b.height, MIN_SIZE.height), area.height)
      const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width)
      const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height)
      return { bounds: { x, y, width, height }, maximized: !!s.maximized }
    }
  } catch {
    // first launch, or an unreadable file: defaults
  }
  return { bounds: { ...DEFAULT_SIZE }, maximized: false }
}

function saveWindowState() {
  if (!win || win.isDestroyed() || win.isFullScreen()) return
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }))
  } catch {
    // losing the window position is not worth an error dialog
  }
}

app.on('before-quit', () => {
  quitting = true
})
app.on('activate', showWindow)
// Never quit on the last window closing: the window only hides, and the tray stays.
app.on('window-all-closed', () => {})
