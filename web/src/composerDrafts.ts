/**
 * Unsent composer text, per live session. The live-session composer unmounts
 * whenever you leave it for another tab or rail section (the content area is a
 * conditional render on the route), so its draft cannot live in the component's
 * own `useState` or switching away and back would blank it — exactly the trap
 * the new-session draft avoids by living in `draftStore`. It lives here instead:
 * module-level, keyed by session id (a uuid, unique across workspaces),
 * persisted per browser so a reload never costs the text, and cleared the
 * moment the message is sent.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'triage.composerDrafts'

let drafts: Record<string, string> = load()
const listeners = new Set<() => void>()

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts))
  } catch {
    // storage blocked — the draft still survives this page load
  }
}

function notify() {
  for (const fn of listeners) fn()
}

export const composerDrafts = {
  get: (sessionId: string): string => drafts[sessionId] ?? '',

  /** Write the unsent text for a session; an empty string forgets it entirely. */
  set(sessionId: string, text: string) {
    if ((drafts[sessionId] ?? '') === text) return
    if (text) {
      drafts = { ...drafts, [sessionId]: text }
    } else {
      if (!(sessionId in drafts)) return
      const { [sessionId]: _drop, ...rest } = drafts
      drafts = rest
    }
    persist()
    notify()
  },

  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}

/** The unsent text for one session, reactive. */
export function useComposerDraft(sessionId: string): string {
  return useSyncExternalStore(composerDrafts.subscribe, () => composerDrafts.get(sessionId))
}
