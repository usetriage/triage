// The splash's only door to the main process. CommonJS because sandboxed
// preloads can't be ES modules. The web UI loads in the same window but gets
// nothing: the bridge exists only on the local splash page (file:).
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
