/**
 * The visual viewport, as CSS: `--vvh` is the height actually visible, `--vvt`
 * where it starts, and `html.kbOpen` marks an on-screen keyboard. iOS overlays
 * the keyboard on the page instead of resizing it, so without this a phone's
 * composer sits under the keys; while the keyboard is up, the phone layout
 * (styles.css) sizes the app to the visible area instead of the screen.
 */
export function trackViewport() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement
  const update = () => {
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
    // Where the visible area starts, if iOS has scrolled the page under the keyboard anyway.
    root.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`)
    // A keyboard takes well over 150px; browser chrome sliding in and out does not.
    root.classList.toggle('kbOpen', window.innerHeight - vv.height > 150)
    // iOS scrolls the whole document to reveal a focused field; the app is
    // already sized to the visible area, so put it back.
    if (window.scrollY !== 0) window.scrollTo(0, 0)
  }
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  update()
}
