/**
 * Resolving the bare ids an agent drops into chat — an artifact id, a session
 * id, a work-item id — back to the entity's name and the in-app route that
 * opens it. The data is already in the client stores (sessions, the artifacts
 * index, the open inbox), so this is a lookup, not a fetch.
 *
 * Artifacts and sessions share the UUID space, so the only safe way to tell one
 * from the other is to match against the ids we actually know; a `RefIndex` is
 * that set of known ids compiled into one regex plus the id→entity map. An id
 * that resolves to nothing is left as plain text by the caller, never a broken
 * link.
 */
import { useMemo } from 'react'
import type { LinkKind } from '../../shared/protocol.js'
import { useArtifacts } from './artifactStore.js'
import { itemHash, useSessions } from './hooks.js'
import { useInbox } from './inboxStore.js'

export type RefHit = { kind: LinkKind; label: string; hash: string }

export type RefIndex = {
  /** A fresh global regex over every known id, or null when nothing is loaded. */
  pattern: () => RegExp | null
  lookup: (raw: string) => RefHit | null
}

const EMPTY: RefIndex = { pattern: () => null, lookup: () => null }

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The lookup index over everything the client currently knows how to open. Work
 * items come from the open inbox only, so a done/snoozed item falls back to its
 * id — acceptable; artifacts and sessions are the reference types that matter.
 */
export function useRefIndex(): RefIndex {
  const sessions = useSessions()
  const { artifacts } = useArtifacts()
  const { items } = useInbox()
  return useMemo(() => {
    const map = new Map<string, RefHit>()
    for (const a of artifacts) if (a.id && a.title) map.set(a.id, { kind: 'artifact', label: a.title, hash: `/artifact/${a.id}` })
    // A session id and an artifact id can't collide, but set sessions after so a
    // shared id would still point somewhere sensible.
    for (const s of sessions) if (s.id && s.title) map.set(s.id, { kind: 'session', label: s.title, hash: s.id })
    for (const it of items) if (it.id && it.title) map.set(it.id, { kind: 'item', label: it.title, hash: itemHash(it.id) })
    if (map.size === 0) return EMPTY
    // Longest id first, so one id that is a prefix of another still matches whole.
    const ids = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRe)
    // A fresh regex per call: the `g` flag carries lastIndex, so the caller can't
    // share one instance across text nodes.
    const source = `(?<![\\w-])(?:${ids.join('|')})(?![\\w-])`
    return { pattern: () => new RegExp(source, 'g'), lookup: (raw) => map.get(raw) ?? null }
  }, [sessions, artifacts, items])
}
