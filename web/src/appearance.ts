/**
 * How this browser renders the app: colour theme and base text size. A per-browser, per-device preference — it lives in localStorage and is
 * applied to the document root, not the session store. The Appearance and
 * Themes settings tabs edit it; `initAppearance()` (called before the first
 * paint) applies the saved values and keeps "System" in step with the OS colour scheme.
 *
 * Choosing a theme is two decisions, as in most editors: a *mode* (system,
 * light, dark) and one theme per scheme (the dark theme, the light theme). The
 * mode picks which of the two is showing. JS resolves it to one concrete theme
 * id and writes it to `document.documentElement[data-theme]` — the hand-tuned
 * Triage themes are styled in styles.css, the rest are compiled from their
 * palettes into one injected <style> (see themes.ts).
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_THEME, themeFor, themeStylesheet, type Theme, type ThemeScheme } from './themes.js'

export type ThemeMode = 'system' | ThemeScheme

export type Appearance = {
  mode: ThemeMode
  /** Theme id shown in dark mode. */
  darkTheme: string
  /** Theme id shown in light mode. */
  lightTheme: string
  /** Base reading-text size, in px. */
  fontSize: number
}

// The mode keeps the key it had when it was the whole theme choice, so a saved
// "light" or "dark" carries over unchanged.
const MODE_KEY = 'triage.appearance.theme'
const DARK_KEY = 'triage.appearance.darkTheme'
const LIGHT_KEY = 'triage.appearance.lightTheme'
const FONT_KEY = 'triage.appearance.fontSize'

export const FONT_MIN = 12
export const FONT_MAX = 18
export const FONT_DEFAULT = 13

const MODES: ThemeMode[] = ['system', 'light', 'dark']
export const isThemeMode = (v: unknown): v is ThemeMode =>
  typeof v === 'string' && MODES.includes(v as ThemeMode)

export const APPEARANCE_DEFAULTS: Appearance = {
  // Dark-first: with nothing saved yet (a fresh install), default to dark
  // regardless of the OS scheme. "System" is an explicit opt-in, not the default.
  mode: 'dark',
  darkTheme: DEFAULT_THEME.dark,
  lightTheme: DEFAULT_THEME.light,
  fontSize: FONT_DEFAULT,
}

const clampNum = (n: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : dflt

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage blocked — the value still applies for this page load
  }
}

export function readAppearance(): Appearance {
  const mode = readRaw(MODE_KEY)
  return {
    mode: isThemeMode(mode) ? mode : APPEARANCE_DEFAULTS.mode,
    // themeFor() falls back to the default when a saved id no longer exists
    // (a theme was renamed or removed) or belongs to the other scheme.
    darkTheme: themeFor('dark', readRaw(DARK_KEY)).id,
    lightTheme: themeFor('light', readRaw(LIGHT_KEY)).id,
    fontSize: clampNum(Number(readRaw(FONT_KEY)), FONT_MIN, FONT_MAX, FONT_DEFAULT),
  }
}

const prefersDark = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches

/** The scheme a mode resolves to right now. */
export function resolveScheme(mode: ThemeMode): ThemeScheme {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light'
  return mode
}

/** The theme on screen for these settings. */
export function resolveTheme(a: Appearance): Theme {
  const scheme = resolveScheme(a.mode)
  return themeFor(scheme, scheme === 'dark' ? a.darkTheme : a.lightTheme)
}

function applyToDocument(a: Appearance) {
  const root = document.documentElement
  const theme = resolveTheme(a)
  root.dataset.theme = theme.id
  root.dataset.scheme = theme.scheme
  root.style.setProperty('--app-font-size', `${a.fontSize}px`)
}

function installThemeStyles() {
  const id = 'triage-themes'
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = themeStylesheet()
}

// ---------------------------------------------------------------------------
// External-store plumbing so a settings pane re-renders on every change and on
// OS-scheme flips, while getSnapshot stays referentially stable between them.
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>()
let snapshot: Appearance | null = null

function currentSnapshot(): Appearance {
  if (!snapshot) snapshot = readAppearance()
  return snapshot
}

function refresh() {
  snapshot = readAppearance()
  applyToDocument(snapshot)
  for (const fn of listeners) fn()
}

/** Persist the keys present in `patch`, then re-apply and notify. */
export function writeAppearance(patch: Partial<Appearance>) {
  if (patch.mode !== undefined) writeRaw(MODE_KEY, patch.mode)
  if (patch.darkTheme !== undefined) writeRaw(DARK_KEY, patch.darkTheme)
  if (patch.lightTheme !== undefined) writeRaw(LIGHT_KEY, patch.lightTheme)
  if (patch.fontSize !== undefined) writeRaw(FONT_KEY, String(patch.fontSize))
  refresh()
}

/**
 * Put a theme on screen: it becomes its scheme's pick, and a fixed mode of the
 * other scheme follows it — clicking a light theme while in dark mode should
 * show it. "System" is left alone; the pick applies when the OS gets there.
 */
export function chooseTheme(theme: Theme) {
  const mode = readAppearance().mode
  writeAppearance({
    [theme.scheme === 'dark' ? 'darkTheme' : 'lightTheme']: theme.id,
    ...(mode !== 'system' ? { mode: theme.scheme } : {}),
  })
}

let started = false
/** Apply saved appearance and keep "System" tracking the OS. Call once, early. */
export function initAppearance() {
  if (started) return
  started = true
  installThemeStyles()
  refresh()
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (readAppearance().mode === 'system') refresh()
    })
  }
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    currentSnapshot,
    currentSnapshot,
  )
}

/** The theme on screen, re-rendering on every change (including OS flips under "System"). */
export function useTheme(): Theme {
  return resolveTheme(useAppearance())
}
