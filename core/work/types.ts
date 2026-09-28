/**
 * Work items — ported from hey-triage (src/core/types.ts), trimmed to what
 * the web inbox renders. Kinds for sources not yet ported (slack, linear)
 * are kept: scoring is source-agnostic and the ids/kinds are settled.
 */
export type WorkSource = 'github' | 'slack' | 'linear' | 'web' | 'watch' | 'manual'

export type ItemKind =
  | 'review-requested' // someone asked you to review their PR
  | 'reply-needed' // changes requested on your PR — reviewer is waiting on you
  | 'own-pr-approved' // approved but unmerged — merge it
  | 'own-pr-conflicting' // your PR has merge conflicts
  | 'own-pr-stale' // your PR, no activity for days
  | 'own-pr-open' // your PR, healthy, waiting on review
  | 'mention' // you were mentioned somewhere
  | 'slack-reply-pending'
  | 'slack-mention'
  | 'ticket-assigned'
  | 'watch-hit' // a user-defined watch matched this thread
  | 'digest' // a watch's rolling report: one item per watch, rewritten each run (see .docs/watches.md)
  | 'manual' // a to-do the user added by hand, in the inbox
  | 'fyi'

export type Group = 'blocking' | 'blocked-stale' | 'cycle' | 'fyi'

/**
 * One record of a scan finding (or refinding) an item (.docs/watches-v2.md).
 * Provenance is a list, so a thread matched by two watches keeps both — "found
 * by Mentions (run 41), also matched Onboarding (run 42)" — rather than the
 * inbox doubling up or a later find clobbering the first.
 */
export interface Provenance {
  /** the watch that produced this find; absent = a deterministic source (github) */
  watchId?: string
  /** the run/session that produced it, for linking to the transcript */
  runId?: string
  /** epoch ms of the find */
  at: number
  /** the scanner's one-line match reason for this find */
  why?: string
}

export const GROUP_LABELS: Record<Group, string> = {
  blocking: 'YOU ARE BLOCKING',
  'blocked-stale': 'YOUR WORK — STALE',
  cycle: 'YOUR CYCLE',
  fyi: 'FYI',
}

export interface WorkItem {
  /** stable id, e.g. "github:owner/repo#123" */
  id: string
  source: WorkSource
  kind: ItemKind
  title: string
  url: string
  /** repo, Slack channel, or Linear team — the item's home */
  repo: string
  author: string
  /** humans waiting on *you* for this item */
  peopleWaiting: number
  createdAt: string
  updatedAt: string
  isDraft?: boolean
  ciFailing?: boolean
  /** Linear priority: 1 urgent, 2 high, 3 normal, 4 low (0/absent = none) */
  priority?: number
  /** canonical refs extracted from content, e.g. "github:org/repo#123", "linear:NOV-456" */
  refs?: string[]
  /** which watch produced it (undefined = built-in) */
  watchId?: string
  /** the project this item belongs to (manual items; empty = none) */
  projectId?: string
  /** scanner's one-line match reason (rendered on the item) — the latest find's */
  why?: string
  /** re-armed: was done, the source updated afterwards (reopen rule) */
  returned?: boolean
  /** every scan that found (or refound) this item; the card explains itself */
  foundBy?: Provenance[]
  /** epoch ms this item first entered the store */
  ingestedAt?: number
  /** current lifecycle state; set by the store on projection */
  status?: import('./state.js').ItemStatus
  /**
   * the human's short intent, in their words — on any item, not just manual
   * ones; never overwritten by ingestion or by a brief (.docs/next-version.md)
   */
  description?: string
  /**
   * links the human put on the item — a Slack thread, the PR, a doc. Like
   * `description`, on any item and never touched by ingestion; `url` stays
   * the source's own link.
   */
  urls?: string[]
  /** pre-0.7 name for `description` on manual items; read as a fallback, never written */
  note?: string
  /**
   * screenshots the human attached — refs only; the bytes live in the
   * workspace's `attachments/` folder (see ItemImage) so an inbox sync stays
   * small. Briefs and dispatched sessions get them as real image blocks.
   */
  images?: import('../../shared/protocol.js').ItemImage[]
}

export interface ScoredItem extends WorkItem {
  score: number
  group: Group
  /** one human-readable line: why this ranked where it did */
  reason: string
  /**
   * items sharing a canonical ref, folded into this card (linked, not merged).
   * Carries id and title, not just the URL, so a reader — a person or a model
   * with get_work_item — can actually follow one.
   */
  linked?: { id: string; title: string; source: WorkSource; url: string; repo: string }[]
}
