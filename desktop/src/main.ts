/**
 * Triage.app's main process (ARCHITECTURE.md): one window over the local
 * daemon, a menu, a menu-bar icon. The app attaches, it does not own — quitting
 * it never stops the daemon, so live sessions and watches carry on.
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

let win: BrowserWindow | null = null
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
  ipcMain.on('nav:back', (e) => isWin(e.sender) && history()?.canGoBack() && history()?.goBack())
  ipcMain.on('nav:forward', (e) => isWin(e.sender) && history()?.canGoForward() && history()?.goForward())
  ipcMain.handle('nav:state', () => navState())
  createWindow()
  void connect()
  setInterval(watchdog, 5000)
}

// ── window ─────────────────────────────────────────────────────────────────

function createWindow() {
  const state = loadWindowState()
  win = new BrowserWindow({
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
  if (state.maximized) win.maximize()
  win.once('ready-to-show', () => win?.show())

  // Closing hides: the app lives on in the Dock and the menu bar until ⌘Q.
  win.on('close', (e) => {
    saveWindowState()
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => (win = null))
  let saveTimer: NodeJS.Timeout | undefined
  const saveSoon = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveWindowState, 500)
  }
  win.on('resize', saveSoon)
  win.on('move', saveSoon)
  win.on('maximize', saveSoon)
  win.on('unmaximize', saveSoon)
  // Fullscreen hides the traffic lights, so the bar drops their inset.
  win.on('enter-full-screen', sendNav)
  win.on('leave-full-screen', sendNav)

  const wc = win.webContents
  wc.on('did-finish-load', () => {
    if (onSplash()) wc.send('splash:status', splash)
    else {
      sendNav()
      void fitLegacyBar(wc)
    }
  })
  wc.on('did-navigate-in-page', sendNav)
  // Links out of triage go to the default browser; the app never opens a
  // second window. A same-origin window.open (⌘-click a workspace) has one
  // window to land in, so it takes this one.
  wc.setWindowOpenHandler(({ url }) => {
    if (isDaemonUrl(url)) void wc.loadURL(url)
    else openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (isDaemonUrl(url) || url === SPLASH_URL) return
    e.preventDefault()
    openExternal(url)
  })
  // The daemon went away under a load (restart, crash, `triage stop`).
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: superseded by another load */ || !isDaemonUrl(url)) return
    reconnect()
  })
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') reconnect()
  })
}

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
    createWindow()
    void connect()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function onSplash(): boolean {
  return win?.webContents.getURL() === SPLASH_URL
}

// ── connecting ─────────────────────────────────────────────────────────────

function setSplash(s: SplashStatus) {
  splash = s
  if (win && onSplash()) win.webContents.send('splash:status', s)
}

/** Splash → find or start the daemon (or restart it) → load the UI. Errors stay on the splash. */
async function connect(how: 'ensure' | 'restart' = 'ensure') {
  if (connecting || !win) return
  connecting = true
  const w = win
  try {
    setSplash({ state: 'starting', text: how === 'restart' ? 'Restarting triage…' : 'Looking for triage…' })
    if (!onSplash()) await w.loadFile(SPLASH)
    if (how === 'restart') await restartDaemon()
    else await ensureDaemon((text) => setSplash({ state: 'starting', text }))
    await w.loadURL(daemonUrl())
    // Back must never land on the splash: the UI's history starts here.
    w.webContents.navigationHistory.clear()
    sendNav()
  } catch (err) {
    if (w.isDestroyed()) return
    if (!onSplash()) await w.loadFile(SPLASH).catch(() => {})
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
  if (connecting || !win) return
  if (Date.now() - lastAutoConnect < 10_000) {
    void win.loadFile(SPLASH).then(() =>
      setSplash({ state: 'error', text: 'Triage stopped answering', detail: `Nothing at ${daemonUrl()} — Retry to start it again, or check the log.` }),
    )
    return
  }
  lastAutoConnect = Date.now()
  void connect()
}

// A loaded SPA doesn't fail a load when the daemon dies — its socket just
// drops. Two misses in a row (not one: `triage restart` is a short gap) sends
// it back to the splash. And a splash showing an error recovers on its own once
// a daemon appears.
let misses = 0
async function watchdog() {
  if (connecting || !win) return
  const health = await probe()
  if (onSplash()) {
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
  showWindow()
  if (!win) return
  const health = await probe()
  const live = health && health !== 'other' ? health.liveSessions : 0
  const { response } = await dialog.showMessageBox(win, {
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

const history = () => win?.webContents.navigationHistory
const isWin = (sender: Electron.WebContents) => !!win && sender === win.webContents

function navState(): NavState {
  const h = history()
  return { canGoBack: !!h?.canGoBack(), canGoForward: !!h?.canGoForward(), fullscreen: !!win?.isFullScreen() }
}

/** Push ← → availability (and fullscreen) to the web UI after every move. */
function sendNav() {
  if (win && !win.isDestroyed() && !onSplash()) win.webContents.send('nav:state', navState())
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
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => history()?.canGoBack() && history()?.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => history()?.canGoForward() && history()?.goForward() },
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
