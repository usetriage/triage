/**
 * Labels — what an item asks of you, in one word. Six, hardcoded: the inbox
 * reads by label ("3 replies · 2 reviews"), not by where an item came from.
 *
 * Scanner kinds map to a label and keep their own BASE weight and group
 * (score.ts); a watch hit carries the label its run picked (`ask`) and takes
 * the label's weight and group, so a watch that finds a real reply ranks with
 * replies instead of sinking into FYI. An `ask` that is no longer a label
 * falls back to Read. `meaning` is the line the watch prompt hands the model.
 */
import type { Group, ItemKind, WorkItem } from './types.js'

export type Label = 'review' | 'reply' | 'decide' | 'do' | 'follow-up' | 'read'

/** When a label is due by default, counted from when the item arrived. */
export type DueDefault = 'today' | 'next-workday' | 'this-week' | 'later'

export interface LabelDef {
  name: string
  /** the header's count noun, one and many: "1 reply", "3 replies" */
  noun: [string, string]
  /** fed to the watch prompt — how the model picks this label */
  meaning: string
  group: Group
  /** BASE weight for a watch hit with this label */
  weight: number
  due: DueDefault
}

export const LABELS: Record<Label, LabelDef> = {
  review: {
    name: 'Review',
    noun: ['review', 'reviews'],
    meaning: 'someone asked you to review their work (a PR, a doc, a design)',
    group: 'blocking',
    weight: 90,
    due: 'today',
  },
  reply: {
    name: 'Reply',
    noun: ['reply', 'replies'],
    meaning: 'someone asked you a question or is waiting on your answer',
    group: 'blocking',
    weight: 85,
    due: 'today',
  },
  decide: {
    name: 'Decide',
    noun: ['decision', 'decisions'],
    meaning: 'a choice is waiting on you: approve, pick an option, say yes or no',
    group: 'blocking',
    weight: 80,
    due: 'today',
  },
  do: {
    name: 'Do',
    noun: ['to-do', 'to-dos'],
    meaning: 'a task is yours to do: assigned to you, or you said you would',
    group: 'cycle',
    weight: 50,
    due: 'this-week',
  },
  'follow-up': {
    name: 'Follow up',
    noun: ['follow-up', 'follow-ups'],
    meaning: 'you are waiting on someone else and may need to nudge them',
    group: 'blocked-stale',
    weight: 40,
    due: 'this-week',
  },
  read: {
    name: 'Read',
    noun: ['to read', 'to read'],
    meaning: 'worth knowing, nothing is asked of you',
    group: 'fyi',
    weight: 25,
    due: 'later',
  },
}

/** Display order: the header counts and the label picker read this way. */
export const LABEL_ORDER: Label[] = ['review', 'reply', 'decide', 'do', 'follow-up', 'read']

export const KIND_TO_LABEL: Record<ItemKind, Label> = {
  'review-requested': 'review',
  'reply-needed': 'reply',
  'slack-reply-pending': 'reply',
  manual: 'do',
  'ticket-assigned': 'do',
  'own-pr-conflicting': 'do',
  'own-pr-approved': 'do',
  'own-pr-stale': 'follow-up',
  'own-pr-open': 'follow-up',
  // a watch hit without an ask (filed before labels, or by an external scanner)
  'watch-hit': 'read',
  digest: 'read',
  mention: 'read',
  'slack-mention': 'read',
  fyi: 'read',
}

export function isLabel(v: unknown): v is Label {
  return typeof v === 'string' && Object.hasOwn(LABELS, v)
}

/** The label an item is filed under: a watch hit's ask, else its kind's. */
export function labelOf(item: Pick<WorkItem, 'kind' | 'ask'>): Label {
  if (item.kind === 'watch-hit') return isLabel(item.ask) ? item.ask : 'read'
  return KIND_TO_LABEL[item.kind] ?? 'read'
}

/** "3 replies" */
export function countOf(label: Label, n: number): string {
  const [one, many] = LABELS[label].noun
  return `${n} ${n === 1 ? one : many}`
}

/** The watch prompt's list of labels, one per line. */
export function labelGuide(): string {
  return LABEL_ORDER.map((l) => `  - ${l}: ${LABELS[l].meaning}`).join('\n')
}
