/**
 * The open inbox, as a tiny external store shared by every surface that shows
 * it: the Queue panel, the rail badge, the inbox page and the item page. The
 * server keeps a snapshot cache, so a refresh is cheap (~30ms) — the page that
 * owns the full lifecycle (InboxPage) publishes here after its own loads and
 * optimistic edits, so the panel never lags the list beside it.
 */
import { useSyncExternalStore } from 'react'
import type { InboxResponse, ScoredItem } from '../../shared/protocol.js'
import { store } from './store.js'

export type InboxSnapshot = {
  items: readonly ScoredItem[]
  syncedAt: number
  notices: readonly string[]
  /** false until the first successful load */
  loaded: boolean
  /** the last refresh's failure, cleared by the next success */
  error?: string
  /** a refresh is in flight */
  loading: boolean
}

let snap: InboxSnapshot = { items: [], syncedAt: 0, notices: [], loaded: false, loading: false }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null

function notify() {
  for (const fn of listeners) fn()
}

export const inboxStore = {
  get: (): InboxSnapshot => snap,

  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  set(items: readonly ScoredItem[], syncedAt: number, notices: readonly string[]) {
    snap = { items, syncedAt, notices, loaded: true, loading: false }
    notify()
  },

  /** Local edit (done / snoozed / priority) — keep the panel in step. */
  patch(fn: (items: readonly ScoredItem[]) => readonly ScoredItem[]) {
    snap = { ...snap, items: fn(snap.items) }
    notify()
  },

  refresh(force = false): Promise<void> {
    if (inflight) return inflight
    snap = { ...snap, loading: true }
    notify()
    inflight = fetch(`/api/inbox${force ? '?refresh=1' : ''}`)
      .then((r) => r.json() as Promise<InboxResponse>)
      .then((b) => {
        if (b.ok) inboxStore.set(b.items, b.syncedAt, b.notices)
        else {
          snap = { ...snap, loading: false, error: b.error }
          notify()
        }
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

// Once loaded, stay current: a chat's create_work_item, a watch run and another
// tab all move items, and the server says so. A burst (a watch filing twenty
// items) coalesces into one refetch, queued behind any load already in flight
// so it can't be answered by a snapshot taken before the change.
let pending: ReturnType<typeof setTimeout> | null = null
store.onInboxChanged(() => {
  if (!snap.loaded || pending) return
  pending = setTimeout(() => {
    pending = null
    void (inflight ?? Promise.resolve()).then(() => inboxStore.refresh())
  }, 150)
})

export function useInbox(): InboxSnapshot {
  return useSyncExternalStore(inboxStore.subscribe, inboxStore.get)
}
