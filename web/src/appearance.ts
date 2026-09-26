/**
 * How this browser renders the app: colour theme and base text size. A per-browser, per-device preference — it lives in localStorage and is
 * applied to the document root, not the session store. The Appearance settings
 * tab edits it; `initAppearance()` (called before the first paint) applies the
 * saved values and keeps "System" in step with the OS colour scheme.
 *
 * The theme is resolved to a concrete `light`/`dark` in JS and written to
 * `document.documentElement[data-theme]`, so the stylesheet only needs a single
 * `[data-theme="light"]` override block — dark stays the `:root` default.
 */
import { useSyncExternalStore } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

export type Appearance = {
  theme: ThemeMode
  /** Base reading-text size, in px. */
  fontSize: number
}

const THEME_KEY = 'triage.appearance.theme'
const FONT_KEY = 'triage.appearance.fontSize'

export const FONT_MIN = 12
export const FONT_MAX = 18
export const FONT_DEFAULT = 13

const THEMES: ThemeMode[] = ['system', 'light', 'dark']
export const isThemeMode = (v: unknown): v is ThemeMode =>
  typeof v === 'string' && THEMES.includes(v as ThemeMode)

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
  const theme = readRaw(THEME_KEY)
  return {
    // Dark-first: with nothing saved yet (a fresh install), default to dark
    // regardless of the OS scheme. "System" is an explicit opt-in, not the default.
    theme: isThemeMode(theme) ? theme : 'dark',
    fontSize: clampNum(Number(readRaw(FONT_KEY)), FONT_MIN, FONT_MAX, FONT_DEFAULT),
  }
}

const prefersDark = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches

/** The concrete theme "system" resolves to right now. */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light'
  return mode
}

function applyToDocument(a: Appearance) {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(a.theme)
  root.style.setProperty('--app-font-size', `${a.fontSize}px`)
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
  if (patch.theme !== undefined) writeRaw(THEME_KEY, patch.theme)
  if (patch.fontSize !== undefined) writeRaw(FONT_KEY, String(patch.fontSize))
  refresh()
}

let started = false
/** Apply saved appearance and keep "System" tracking the OS. Call once, early. */
export function initAppearance() {
  if (started) return
  started = true
  refresh()
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (readAppearance().theme === 'system') refresh()
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
