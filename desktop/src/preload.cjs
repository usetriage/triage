// The renderer's door to the main process. CommonJS because sandboxed
// preloads can't be ES modules. The splash (file:) gets retry/log/status; the
// web UI gets only what its desktop chrome needs: ← → and their state.
const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'file:') {
  const arg = process.argv.find((a) => a.startsWith('--triage-version='))
  contextBridge.exposeInMainWorld('triageDesktop', {
    platform: 'darwin',
    version: arg ? arg.slice('--triage-version='.length) : '',
    retry: () => ipcRenderer.send('splash:retry'),
    openLog: () => ipcRenderer.send('splash:open-log'),
    // { state: 'starting' | 'error', text, detail? } — the latest is replayed on load
    onStatus: (cb) => ipcRenderer.on('splash:status', (_e, s) => cb(s)),
  })
}

else {
  contextBridge.exposeInMainWorld('triageDesktop', {
    platform: 'darwin',
    chrome: 'mac',
    back: () => ipcRenderer.send('nav:back'),
    forward: () => ipcRenderer.send('nav:forward'),
    navState: () => ipcRenderer.invoke('nav:state'),
    // { canGoBack, canGoForward, fullscreen } after every navigation; returns an unsubscribe
    onNav: (cb) => {
      const fn = (_e, s) => cb(s)
      ipcRenderer.on('nav:state', fn)
      return () => ipcRenderer.removeListener('nav:state', fn)
    },
  })
}
