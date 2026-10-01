import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { initAppearance } from './appearance.js'
import { store } from './store.js'
import { installWorkspaceFetch } from './workspaceUrl.js'
import { trackViewport } from './viewport.js'
import './styles.css'

// This tab's workspace comes from its own URL (`/w/<id>/`), so two tabs can
// hold two workspaces at once. Tag every request before anything can fetch.
installWorkspaceFetch()
// Apply the saved theme/font before the first paint, so there is no
// flash of the default dark theme when a light-theme user loads the page.
initAppearance()
trackViewport()
store.connect()
// Phones suspend background tabs and drop their sockets: reconnect the moment
// the page is looked at again, not on the next retry tick.
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && store.resume())
window.addEventListener('online', () => store.resume())
window.addEventListener('pageshow', (e) => e.persisted && store.resume())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
