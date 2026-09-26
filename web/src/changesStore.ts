/**
 * Every project's uncommitted files as a tiny external store, shared by the
 * Changes panel, the file page and the rail badge. It is a view of the disk,
 * which anything can change — an agent, a terminal, your editor — so it
 * refreshes when a turn ends, when the window regains focus, and on a slow
 * poll while the panel is open. There is no push for "a file changed".
 */
import { useSyncExternalStore } from 'react'
import type { ProjectChanges, WorkingChangesResponse } from '../../shared/protocol.js'
import { store } from './store.js'

export type ChangesSnapshot = {
  projects: readonly ProjectChanges[]
  loaded: boolean
  loading: boolean
  error?: string
}

let snap: ChangesSnapshot = { projects: [], loaded: false, loading: false }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null

function notify() {
  for (const fn of listeners) fn()
}

export const changesStore = {
  get: (): ChangesSnapshot => snap,

  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  refresh(): Promise<void> {
    if (inflight) return inflight
    snap = { ...snap, loading: true }
    notify()
    inflight = fetch('/api/changes')
      .then((r) => r.json() as Promise<WorkingChangesResponse>)
      .then((b) => {
        snap = b.ok ? { projects: b.projects, loaded: true, loading: false } : { ...snap, loading: false, error: b.error }
        notify()
      })
      .catch((err: unknown) => {
        snap = { ...snap, loading: false, error: String(err) }
        notify()
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  },
}

// Once loaded, stay current: a finished turn is the likeliest moment files moved.
store.onSessionChanged(() => {
  if (snap.loaded) void changesStore.refresh()
})
window.addEventListener('focus', () => {
  if (snap.loaded) void changesStore.refresh()
})

export function useChanges(): ChangesSnapshot {
  return useSyncExternalStore(changesStore.subscribe, changesStore.get)
}

/** The route (and tab id) of one changed file: `/change/<projectId>/<path>`. */
export const changeId = (projectId: string, path: string) => `${projectId}/${encodeURIComponent(path)}`
