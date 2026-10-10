/**
 * Which input moved focus last: the pointer or the keyboard. Radix hands focus
 * back to a menu's trigger (or a dialog's opener) when it closes, and Chromium
 * paints that programmatic focus with :focus-visible — a white ring around a
 * button you just clicked. `html[data-input="pointer"]` lets styles.css drop
 * the ring until a key is pressed again, so keyboard users keep it.
 */
const MODIFIERS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'])

export function trackInputModality() {
  const root = document.documentElement
  const set = (mode: 'pointer' | 'keyboard') => {
    if (root.dataset.input !== mode) root.dataset.input = mode
  }
  addEventListener('pointerdown', () => set('pointer'), { capture: true, passive: true })
  addEventListener('keydown', (e) => !MODIFIERS.has(e.key) && set('keyboard'), { capture: true, passive: true })
}
