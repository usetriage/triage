/**
 * The context panel's width, dragged from its right edge. A per-browser
 * preference, so it lives in localStorage and is applied as the `--panel-w`
 * custom property on the shell — the panel itself never re-renders during a
 * drag, only the variable changes.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export const PANEL_DEFAULT = 280
export const PANEL_MIN = 220
export const PANEL_MAX = 520
const KEY = 'triage.panelWidth'
const COLLAPSED_KEY = 'triage.panelCollapsed'

const clamp = (w: number) => Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, w)))

function read(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    return Number.isFinite(n) && n > 0 ? clamp(n) : PANEL_DEFAULT
  } catch {
    return PANEL_DEFAULT
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function usePanelWidth() {
  const [width, setWidth] = useState(read)
  const [dragging, setDragging] = useState(false)
  const [collapsed, setCollapsedState] = useState(readCollapsed)
  const start = useRef<{ x: number; w: number } | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, String(width))
    } catch {
      // storage blocked — the width still applies for this page load
    }
  }, [width])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // storage blocked — the collapse state still applies for this page load
    }
  }, [collapsed])

  const setCollapsed = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    setCollapsedState(next)
  }, [])

  const toggleCollapsed = useCallback(() => setCollapsedState((v) => !v), [])

  /** Attach to the handle: pointer capture keeps the drag alive off the element. */
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      start.current = { x: e.clientX, w: width }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)
    },
    [width],
  )

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!start.current) return
    setWidth(clamp(start.current.w + (e.clientX - start.current.x)))
  }, [])

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!start.current) return
    start.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // capture already gone
    }
    setDragging(false)
  }, [])

  const reset = useCallback(() => setWidth(PANEL_DEFAULT), [])

  return {
    width,
    dragging,
    collapsed,
    setCollapsed,
    toggleCollapsed,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick: reset,
    },
  }
}
