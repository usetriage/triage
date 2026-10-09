/**
 * Deterministic blocking-impact scoring — ported from hey-triage
 * (src/core/score.ts, decision 007). No LLM, ever (vision principle 3).
 * Blocking impact ranks above recency: base weight by kind, then how many
 * humans are waiting, then how long they've waited.
 */
import { LABELS, labelOf } from './labels.js'
import type { Group, ItemKind, ScoredItem, WorkItem } from './types.js'

export const BASE: Record<ItemKind, number> = {
  'review-requested': 100,
  'reply-needed': 90,
  'slack-reply-pending': 85,
  'own-pr-conflicting': 70,
  'own-pr-approved': 65,
  'ticket-assigned': 50,
  // a to-do the user chose to add — it sits in YOUR CYCLE and leans on priority
  manual: 45,
  'own-pr-stale': 40,
  // deliberately modest: mentions and reviews must outrank topical matches
  'watch-hit': 40,
  // a report to read, not a thread waiting on you
  digest: 15,
  'slack-mention': 35,
  mention: 30,
  'own-pr-open': 15,
  fyi: 5,
}

const GROUP: Record<ItemKind, Group> = {
  'review-requested': 'blocking',
  'reply-needed': 'blocking',
  'slack-reply-pending': 'blocking',
  'own-pr-conflicting': 'blocked-stale',
  'own-pr-approved': 'blocked-stale',
  'own-pr-stale': 'blocked-stale',
  'ticket-assigned': 'cycle',
  manual: 'cycle',
  'watch-hit': 'fyi',
  digest: 'fyi',
  'own-pr-open': 'fyi',
  'slack-mention': 'fyi',
  mention: 'fyi',
  fyi: 'fyi',
}

// Priority (1 urgent … 4 low), source-derived or a user override. Planned work
// jumps within YOUR CYCLE; low priority sinks a little. 0/absent = neutral.
export const PRIORITY_BOOST: Record<number, number> = { 1: 24, 2: 12, 3: 0, 4: -8 }

/** waiting stops accruing after this many days, so ancient items can't run away */
export const WAIT_CAP_DAYS = 14

/**
 * Humans waiting age fast; your own rotting work ages slower, so an old stale PR
 * can never outrank a fresh review request that blocks a person.
 */
export function ageWeightFor(group: Group): number {
  return group === 'blocking' ? 4 : 2
}

/**
 * Weight and group: a scanner kind keeps its own; a watch hit takes its
 * label's, so what the run judged it to be decides where it ranks.
 */
function placeOf(item: WorkItem): { base: number; group: Group } {
  if (item.kind !== 'watch-hit') return { base: BASE[item.kind], group: GROUP[item.kind] }
  const def = LABELS[labelOf(item)]
  return { base: def.weight, group: def.group }
}

export function daysSince(iso: string, now = Date.now()): number {
  return Math.max(0, (now - Date.parse(iso)) / 86_400_000)
}

export function scoreItem(item: WorkItem, now = Date.now()): ScoredItem {
  const waitDays = daysSince(item.updatedAt, now)
  const { base, group } = placeOf(item)
  const ageWeight = ageWeightFor(group)
  let score =
    base + item.peopleWaiting * 15 + Math.min(waitDays, WAIT_CAP_DAYS) * ageWeight
  if (item.ciFailing) score += 10
  score += PRIORITY_BOOST[item.priority ?? 0] ?? 0
  if (item.isDraft) score -= 25
  return {
    ...item,
    score: Math.round(score * 10) / 10,
    group,
    reason: reasonFor(item, waitDays),
    label: labelOf(item),
  }
}

export function rank(items: WorkItem[], now = Date.now()): ScoredItem[] {
  return items
    .map((i) => scoreItem(i, now))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

function age(waitDays: number): string {
  if (waitDays < 1) return 'today'
  return `${Math.floor(waitDays)}d`
}

function reasonFor(item: WorkItem, waitDays: number): string {
  const ci = item.ciFailing ? ' · CI failing' : ''
  switch (item.kind) {
    case 'review-requested':
      return `@${item.author} waiting ${age(waitDays)} for your review${ci}`
    case 'reply-needed':
      return `changes requested — reviewer waiting ${age(waitDays)}${ci}`
    case 'own-pr-approved':
      return `approved, unmerged for ${age(waitDays)} — merge it${ci}`
    case 'own-pr-conflicting':
      return `merge conflicts, untouched ${age(waitDays)}${ci}`
    case 'own-pr-stale':
      return `your PR, quiet for ${age(waitDays)}${ci}`
    case 'own-pr-open':
      return `waiting on review (${age(waitDays)})${ci}`
    case 'mention':
      return `mentioned by @${item.author} (${age(waitDays)})${ci}`
    case 'slack-reply-pending':
      return `@${item.author} waiting ${age(waitDays)} for your reply in ${item.repo}`
    case 'slack-mention':
      return `tagged by @${item.author} in ${item.repo} (${age(waitDays)})`
    case 'ticket-assigned': {
      const pri = item.priority === 1 ? 'urgent · ' : item.priority === 2 ? 'high · ' : ''
      return `${pri}assigned to you, in the current cycle (${age(waitDays)})`
    }
    case 'watch-hit':
      return `matched a watch in ${item.repo} (${age(waitDays)})`
    case 'digest':
      return `digest from ${item.repo} (${age(waitDays)})`
    case 'manual': {
      const pri =
        item.priority === 1 ? 'urgent · ' : item.priority === 2 ? 'high · ' : item.priority === 4 ? 'low · ' : ''
      return `${pri}added by you (${age(waitDays)})`
    }
    case 'fyi':
      return `updated ${age(waitDays)}${ci}`
  }
}
