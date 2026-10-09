/** Shared guards for global hotkeys. */

/** True when the event originates in a text-entry control — letter keys belong to it. */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/**
 * True while any <dialog> or popover menu is open — single-key hotkeys should
 * stay quiet, or "n" typed at an open menu starts a new session behind it.
 */
export function anyDialogOpen(): boolean {
  return (
    document.querySelector(
      'dialog[open], [data-popover-open], [data-radix-popper-content-wrapper], [role="dialog"][data-state="open"]',
    ) !== null
  )
}

/**
 * True for the second key of a `g` sequence (`g t`, `g w`): App handles it as
 * navigation, so a page's own single-key hotkeys must stand aside. Recorded in
 * the capture phase, before any page listener sees the event; the window
 * matches App's prefix timer.
 */
export function isGoSequence(e: KeyboardEvent): boolean {
  return goSeq.has(e)
}
const goSeq = new WeakSet<KeyboardEvent>()
let gAt = -Infinity
document.addEventListener(
  'keydown',
  (e) => {
    if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'g') {
      gAt = e.timeStamp
      return
    }
    if (e.timeStamp - gAt < 1000) goSeq.add(e)
    gAt = -Infinity
  },
  true,
)

export const isMac = navigator.platform.startsWith('Mac')
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl+'

/** Every global key, for the `?` overlay and the Shortcuts settings tab. */
export const SHORTCUTS: ReadonlyArray<[keys: string, what: string]> = [
  [`${MOD_LABEL}K`, 'Search — sessions, items, projects, commands'],
  [`${MOD_LABEL},`, 'Settings'],
  [`${MOD_LABEL}B`, 'Hide / show the side panel'],
  ['n', 'New session (in the inbox: new work item)'],
  ['Shift+Tab', 'Composer: cycle how much the session asks before acting'],
  ['g i', 'Go to Inbox'],
  ['g s', 'Go to Sessions'],
  ['g t', 'Go to Terminals (n opens a new one there)'],
  ['g w', 'Go to Watches'],
  ['g p', 'Projects (in Settings)'],
  ['g c', 'Connectors (in Settings)'],
  ['j / k', 'Inbox: move selection'],
  ['Enter', 'Inbox: open the selected item'],
  ['o', 'Inbox: open the selected item at its source'],
  ['d', 'Inbox: dispatch selected item to a session'],
  ['b', 'Inbox: brief the selected item (or the checked ones)'],
  ['Space', 'Inbox: check / uncheck the selected item'],
  ['e', 'Inbox: mark selected item done'],
  ['z', 'Inbox: snooze selected item until tomorrow'],
  ['t / m / w / l', 'Inbox: due today / next workday / this week / later'],
  ['x', 'Inbox: archive selected item'],
  ['r', 'Inbox: refresh'],
  ['?', 'Keyboard shortcuts'],
  ['Esc', 'Close dialogs'],
]
