/**
 * Old FYI fades — pure, time is an argument. Read items (labels.ts) stop
 * earning a row after a few days: they fold into one "N older FYI" line, and
 * the ones you never touched archive themselves after a week. Anything you
 * gave a due, a priority, a note or links to — or that a brief or session
 * hangs off — is yours, and stays.
 */
import { labelOf } from './labels.js'
import type { WorkItem } from './types.js'

export const FOLD_AFTER_DAYS = 3
export const ARCHIVE_AFTER_DAYS = 7

const DAY = 86_400_000

/** Age counts from the later of its last activity and when it reached the inbox. */
function ageDays(item: Pick<WorkItem, 'updatedAt' | 'ingestedAt'>, now: number): number {
  const seen = Math.max(Date.parse(item.updatedAt) || 0, item.ingestedAt ?? 0)
  return (now - seen) / DAY
}

type FadeFields = Pick<WorkItem, 'kind' | 'ask' | 'dueSource' | 'updatedAt' | 'ingestedAt'>

/** A Read item on its default due, past the fold age: one line, not a row. */
export function isOldFyi(item: FadeFields, now: number): boolean {
  return labelOf(item) === 'read' && !item.dueSource && ageDays(item, now) > FOLD_AFTER_DAYS
}

/**
 * An old Read item nobody touched: archive it. `touched` = ids a brief,
 * note or session links to (the store's links table).
 */
export function shouldArchive(
  item: FadeFields & Pick<WorkItem, 'id' | 'priority' | 'description' | 'urls' | 'images' | 'returned'>,
  now: number,
  touched: ReadonlySet<string>,
): boolean {
  if (labelOf(item) !== 'read' || item.dueSource || item.priority) return false
  if (item.description || item.urls?.length || item.images?.length || item.returned) return false
  if (touched.has(item.id)) return false
  return ageDays(item, now) > ARCHIVE_AFTER_DAYS
}
