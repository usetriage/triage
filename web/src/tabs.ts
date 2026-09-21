/**
 * The tab band: Inbox is pinned; every session opened in this browser gets a
 * closable tab beside it. Per workspace, per browser — a tab is where *you*
 * are, not a property of the session — so it lives in localStorage, not the
 * server.
 */
import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import type { RailSection } from './components/Rail.js'

const key = (workspaceId: string) => `triage.tabs.${workspaceId || 'default'}`

/**
 * What the band holds: tabs you pinned, the one document you are peeking at,
 * and the names of any documents among them. Sessions and shells are always
 * in memory so they never need a remembered name; an artifact or work item
 * does, or a cold load would show a band of "Artifact", "Artifact".
 */
type Band = { tabs: string[]; preview: string | null; titles: Record<string, string> }

const EMPTY: Band = { tabs: [], preview: null, titles: {} }
const isStr = (x: unknown): x is string => typeof x === 'string'
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter(isStr) : [])

function readTitles(x: unknown): Record<string, string> {
  if (!x || typeof x !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) if (isStr(v)) out[k] = v
  return out
}

function read(workspaceId: string): Band {
  try {
    const raw = localStorage.getItem(key(workspaceId))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    // v1 was a bare array of tab keys.
    if (Array.isArray(parsed)) return { ...EMPTY, tabs: strings(parsed) }
    if (!parsed || typeof parsed !== 'object') return EMPTY
    const o = parsed as Record<string, unknown>
    const titles = readTitles(o.titles)
    // v2 carried the title inside the preview; it lives in `titles` now.
    const p = o.preview
    let preview: string | null = null
    if (isStr(p)) preview = p
    else if (p && typeof p === 'object') {
      const pk = (p as Record<string, unknown>).key
      const pt = (p as Record<string, unknown>).title
      if (isStr(pk)) {
        preview = pk
        if (isStr(pt) && pt && !titles[pk]) titles[pk] = pt
      }
    }
    return { tabs: strings(o.tabs), preview, titles }
  } catch {
    return EMPTY
  }
}

/** Forget names for keys the band no longer holds, so storage cannot creep. */
function prune(b: Band): Band {
  const live = new Set([...b.tabs, ...(b.preview ? [b.preview] : [])])
  const kept = Object.keys(b.titles).filter((k) => live.has(k))
  if (kept.length === Object.keys(b.titles).length) return b
  return { ...b, titles: Object.fromEntries(kept.map((k) => [k, b.titles[k]])) }
}

export function useOpenTabs(workspaceId: string) {
  const [band, setBand] = useState<Band>(() => read(workspaceId))
  const { tabs, preview, titles } = band

  // A workspace switch reloads the page, but stay correct if it ever doesn't.
  useEffect(() => {
    setBand(read(workspaceId))
  }, [workspaceId])

  useEffect(() => {
    try {
      localStorage.setItem(key(workspaceId), JSON.stringify(band))
    } catch {
      // storage full or blocked — tabs are a convenience, not state we need
    }
  }, [band, workspaceId])

  /** Pin a tab. Whatever was being peeked at has now been committed to. */
  const open = useCallback((id: string) => {
    setBand((b) => {
      if (b.tabs.includes(id)) return b.preview === id ? { ...b, preview: null } : b
      return { ...b, tabs: [...b.tabs, id], preview: b.preview === id ? null : b.preview }
    })
  }, [])

  /** Closes a pinned tab or the preview — a key only ever lives in one of them. */
  const close = useCallback((id: string) => {
    setBand((b) => prune({ ...b, tabs: b.tabs.filter((t) => t !== id), preview: b.preview === id ? null : b.preview }))
  }, [])

  /** A draft tab becoming a session tab: same slot, new key. */
  const replace = useCallback((from: string, to: string) => {
    setBand((b) => {
      const without = b.tabs.filter((t) => t !== to)
      const i = without.indexOf(from)
      const next = i === -1 ? (without.includes(to) ? without : [...without, to]) : without.with(i, to)
      return prune({ ...b, tabs: next, preview: b.preview === to ? null : b.preview })
    })
  }, [])

  /**
   * Peek at a document. One slot: opening another replaces it, so browsing
   * never leaves tabs behind. Already-pinned keys are left alone.
   */
  const setPreview = useCallback((id: string) => {
    setBand((b) => (b.preview === id || b.tabs.includes(id) ? b : prune({ ...b, preview: id })))
  }, [])

  /** Learn (or improve) the names of document tabs. */
  const remember = useCallback((patch: Record<string, string>) => {
    setBand((b) => {
      const changed = Object.entries(patch).some(([k, v]) => b.titles[k] !== v)
      return changed ? { ...b, titles: { ...b.titles, ...patch } } : b
    })
  }, [])

  return { tabs, preview, titles, open, close, replace, setPreview, remember }
}

/**
 * Browser-style open gestures for a list row. A plain click peeks — the tab
 * is provisional and the next document replaces it. ⌘/ctrl-click and
 * middle-click keep it *without* leaving where you are; double-click opens it
 * and keeps it.
 */
export function rowOpen(open: () => void, pin: () => void) {
  return {
    onClick: (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        pin()
        return
      }
      open()
    },
    onDoubleClick: () => pin(),
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      pin()
    },
  }
}

/**
 * The last route you were on in each rail section. The rail is *section*
 * navigation: leaving Artifacts for a session and coming back should land on
 * the artifact you were reading, not the grid. Per workspace, per browser —
 * where *you* were, so the same reasoning (and storage) as the tabs above.
 */
const routeKey = (workspaceId: string) => `triage.lastRoute.${workspaceId || 'default'}`

export type LastRoutes = Partial<Record<RailSection, string>>

function readRoutes(workspaceId: string): LastRoutes {
  try {
    const raw = localStorage.getItem(routeKey(workspaceId))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: LastRoutes = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k as RailSection] = v
    }
    return out
  } catch {
    return {}
  }
}

export function useLastRoutes(workspaceId: string) {
  const [lastRoutes, setLastRoutes] = useState<LastRoutes>(() => readRoutes(workspaceId))

  useEffect(() => {
    setLastRoutes(readRoutes(workspaceId))
  }, [workspaceId])

  useEffect(() => {
    try {
      localStorage.setItem(routeKey(workspaceId), JSON.stringify(lastRoutes))
    } catch {
      // storage full or blocked — rail memory is a convenience, not state we need
    }
  }, [lastRoutes, workspaceId])

  const record = useCallback((section: RailSection, hash: string) => {
    setLastRoutes((prev) => (prev[section] === hash ? prev : { ...prev, [section]: hash }))
  }, [])

  return { lastRoutes, record }
}

/**
 * A stable colour per project folder — the small dot on a tab that says which
 * codebase it belongs to. Derived from the path so it never needs storing.
 *
 * The hash picks a slot, not a colour: what comes back is `var(--hue-N)`, so
 * the dark theme's neons and the light theme's darker re-picks (styles.css)
 * swap on a theme flip without re-rendering anything.
 */
const HUES = 8

export function projectColor(cwd: string): string {
  let h = 0
  for (let i = 0; i < cwd.length; i++) h = (h * 31 + cwd.charCodeAt(i)) >>> 0
  return `var(--hue-${h % HUES})`
}
