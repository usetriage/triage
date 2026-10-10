/**
 * Triage.app (desktop/): the Electron preload exposes `window.triageDesktop`
 * on the daemon's pages. Present = the UI draws its own title bar — traffic
 * lights inside the top bar, ← → driving the window's history — instead of
 * the grey one macOS would add. Absent (a browser, a phone) = nothing changes.
 */
import { useEffect, useState } from 'react'

export type DesktopNav = { canGoBack: boolean; canGoForward: boolean; fullscreen: boolean }

type Bridge = {
  chrome: 'mac'
  back: () => void
  forward: () => void
  navState: () => Promise<DesktopNav>
  onNav: (cb: (s: DesktopNav) => void) => () => void
}

const bridge: Bridge | null = (() => {
  const b = (globalThis as { triageDesktop?: Partial<Bridge> }).triageDesktop
  return b?.chrome === 'mac' && typeof b.onNav === 'function' ? (b as Bridge) : null
})()

/** Running inside Triage.app's window. */
export const isDesktop = bridge !== null

if (bridge) document.documentElement.classList.add('desktop-mac')

export const goBack = () => bridge?.back()
export const goForward = () => bridge?.forward()

const IDLE: DesktopNav = { canGoBack: false, canGoForward: false, fullscreen: false }

/** ← → availability and fullscreen, pushed by the main process after every navigation. */
export function useDesktopNav(): DesktopNav {
  const [nav, setNav] = useState(IDLE)
  useEffect(() => {
    if (!bridge) return
    void bridge.navState().then(setNav)
    return bridge.onNav(setNav)
  }, [])
  return nav
}
