/**
 * Whether the page is laid out for a phone: narrower than 767px (the design
 * system's "Mobile Large" ceiling) or a touch screen under 500px tall — a
 * phone held sideways. Matches the phone `@media` blocks in styles.css. There
 * the shell is a single column: a top bar with a back button, one page, and
 * the rail as a bottom tab bar.
 */
import { useSyncExternalStore } from 'react'

export const MOBILE_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)'

const mql = typeof matchMedia === 'function' ? matchMedia(MOBILE_QUERY) : null

function subscribe(fn: () => void) {
  mql?.addEventListener('change', fn)
  return () => mql?.removeEventListener('change', fn)
}

export const isMobile = (): boolean => mql?.matches ?? false

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobile)
}
