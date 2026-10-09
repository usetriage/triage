/**
 * The due rule (watch-spec.md, item 3). A due-checker, not a cron daemon: on
 * each scheduler tick, `decide` asks one question per watch — has a scheduled
 * slot passed since the last run STARTED? — and layers wakecron's refinements
 * on top: overlap, connector readiness, and the catch-up window. Missed slots
 * coalesce by construction: the next slot after the last start is one slot, no
 * matter how many were slept through.
 *
 * Pure: time is an argument, so every rule is testable with a fake clock
 * (test/watch-schedule.test.ts).
 */
import { cronFromCadence, nextScheduled } from './cron.js'
import type { Watch, WatchOutput } from './types.js'

/** The watch's cron schedule, falling back to the legacy cadence for old rows. */
export function scheduleOf(w: Pick<Watch, 'schedule' | 'cadence' | 'windowStart' | 'windowDay'>): string {
  return w.schedule || cronFromCadence(w.cadence ?? 'daily', w.windowStart, w.windowDay)
}

export type Trigger = 'scheduled' | 'catch_up' | 'manual'
export type SkipReason = 'overlap' | 'window' | 'connector'

export type CatchUpWindow = { kind: 'duration'; ms: number } | { kind: 'never' } | { kind: 'unlimited' }

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/** "30m" / "6h" / "2d" → ms, else null. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*([mhd])$/.exec(s.trim())
  if (!m) return null
  const n = Number(m[1])
  return n > 0 ? n * UNIT_MS[m[2]] : null
}

/** A digest's stale edition is noise; an items watch's late run finds what was missed. */
export const defaultCatchUp = (output: WatchOutput): string => (output === 'digest' ? '6h' : 'unlimited')

/** Is this a catch-up window string the store accepts? */
export const isCatchUpSpec = (s: unknown): s is string =>
  typeof s === 'string' && (s === 'never' || s === 'unlimited' || parseDuration(s) !== null)

export function parseCatchUp(spec: string | undefined, output: WatchOutput): CatchUpWindow {
  const s = spec && isCatchUpSpec(spec) ? spec : defaultCatchUp(output)
  if (s === 'never') return { kind: 'never' }
  if (s === 'unlimited') return { kind: 'unlimited' }
  return { kind: 'duration', ms: parseDuration(s)! }
}

export type Decision =
  | { action: 'idle'; slot: number }
  | { action: 'run'; trigger: Exclude<Trigger, 'manual'>; slot: number }
  | { action: 'skip'; reason: SkipReason; slot: number; detail?: string }

export type DecideParams = {
  schedule: string
  /** epoch ms the last run started; undefined = never run */
  lastRunStartedAt: number | undefined
  now: number
  tickMs: number
  /** a run of this watch is in flight */
  running: boolean
  /** every connector the watch uses is up; else why not */
  ready: true | string
  catchUp: CatchUpWindow
}

const NEVER = 8_640_000_000_000_000

/**
 * The one rule: a watch is due when nextScheduled(lastRunStartedAt) <= now.
 * Returns what the scheduler should do; the caller owns concurrency and
 * persistence (a skip moves lastRunStartedAt to now; a run sets it at start).
 */
export function decide(p: DecideParams): Decision {
  // Never run: due right away (the "run once now" default on create). A watch
  // saved without it starts life with lastRunStartedAt = its creation time.
  if (p.lastRunStartedAt == null) {
    if (p.running) return { action: 'skip', reason: 'overlap', slot: p.now }
    if (p.ready !== true) return { action: 'skip', reason: 'connector', slot: p.now, detail: p.ready }
    return { action: 'run', trigger: 'scheduled', slot: p.now }
  }
  const slot = nextScheduled(p.schedule, p.lastRunStartedAt) ?? NEVER
  // Not due. Also covers the clock moving backwards (NTP, DST fall-back).
  if (slot > p.now) return { action: 'idle', slot }
  // Still running from before: drop the slot, never queue it.
  if (p.running) return { action: 'skip', reason: 'overlap', slot }
  if (p.ready !== true) return { action: 'skip', reason: 'connector', slot, detail: p.ready }

  const age = p.now - slot
  const isCatchUp = age > p.tickMs
  const w = p.catchUp
  if (w.kind === 'unlimited') return { action: 'run', trigger: isCatchUp ? 'catch_up' : 'scheduled', slot }
  if (w.kind === 'never') return isCatchUp ? { action: 'skip', reason: 'window', slot } : { action: 'run', trigger: 'scheduled', slot }
  if (age > w.ms) return { action: 'skip', reason: 'window', slot }
  return { action: 'run', trigger: isCatchUp ? 'catch_up' : 'scheduled', slot }
}

/** Waiting runs start oldest slot first; the rest keep their slot for a later tick. */
export function pickToRun<T extends { slot: number }>(due: T[], capacity: number): T[] {
  return [...due].sort((a, b) => a.slot - b.slot).slice(0, Math.max(0, capacity))
}

/** The most missed slots a catch-up run records — an every-minute watch asleep for a week stops here. */
export const MISSED_CAP = 50

/**
 * The slots a catch-up run collapses: every slot strictly after the one it
 * runs for, up to `now`, oldest first, at most `cap`. Each becomes a `missed`
 * ledger row, so the gap is visible instead of silently coalesced.
 */
export function missedSlots(schedule: string, slot: number, now: number, cap = MISSED_CAP): number[] {
  const out: number[] = []
  let next = nextScheduled(schedule, slot)
  while (next != null && next <= now && out.length < cap) {
    out.push(next)
    next = nextScheduled(schedule, next)
  }
  return out
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "08:00" today, "Wed 21:00" any other day — local, as cron is. */
function slotTime(ms: number, now: number): string {
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date(now).toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`
}

/** A catch-up run this close to its slot is on time — the prompt says nothing. */
const ON_TIME_MS = 2 * 60_000

/**
 * What a catch-up run is told about its own lateness: the slot it is for, how
 * late it started, and the slots it collapsed (the ledger's `missed` rows), so
 * it can cover the gap and skip what has gone stale. Null when on time with
 * nothing missed. Lists the newest ten missed slots.
 */
export function describeLateness(slot: number, missed: number[], now: number): string | null {
  const late = now - slot
  if (late <= ON_TIME_MS && !missed.length) return null
  const parts = [`This run was scheduled for ${slotTime(slot, now)} and is starting ${humanSpan(late)} late (the Mac was asleep or triage was off)`]
  if (missed.length) {
    const listed = missed.slice(-10).map((m) => slotTime(m, now)).join(', ')
    const more = missed.length > 10 ? ` and ${missed.length - 10} earlier` : ''
    parts.push(`It also stands in for the missed slots ${listed}${more}`)
  }
  parts.push('Cover the whole gap since the scheduled slot in one pass, and skip anything that is stale by now.')
  return parts.join('. ')
}

/** Local midnight at the start of `now`'s day — when a daily budget resets. */
export function localMidnight(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export type BudgetDecision = { skip: true; reason: string } | { skip: false; maxBudgetUsd?: number }

/**
 * The daily budget gate. Spent at or over the day's cap: skip, no run.
 * Otherwise the run's own cap is the smaller of the per-run cap and what is
 * left of the day, so one run can't overshoot it. No daily cap: the per-run
 * cap alone.
 */
export function budgetFor(perRunUsd: number | undefined, dailyUsd: number | undefined, spentTodayUsd: number): BudgetDecision {
  if (dailyUsd == null) return perRunUsd != null ? { skip: false, maxBudgetUsd: perRunUsd } : { skip: false }
  const left = dailyUsd - spentTodayUsd
  if (left <= 0) return { skip: true, reason: `spent $${spentTodayUsd.toFixed(2)} of the $${dailyUsd.toFixed(2)} daily budget` }
  return { skip: false, maxBudgetUsd: perRunUsd != null ? Math.min(perRunUsd, left) : left }
}

/**
 * A watch is overdue when no run has ended `ok` within a grace window of two
 * schedule intervals plus an hour. Skips and failures never count — they used
 * to, by moving lastRunAt. `lastOkAt` is the ledger's latest ok row; without
 * one, a watch whose last receipt was ok counts from it, else from creation.
 */
export function isOverdue(
  schedule: string,
  w: Pick<Watch, 'createdAt' | 'lastRunAt' | 'lastRunStatus'>,
  lastOkAt: number | undefined,
  now: number,
): boolean {
  const grace = 2 * (intervalOf(schedule, now) ?? 86_400_000) + 3_600_000
  const since = lastOkAt ?? (w.lastRunStatus === 'ok' && w.lastRunAt != null ? w.lastRunAt : w.createdAt)
  return now - since > grace
}

// ---------------------------------------------------------------------------
// The default look-back window (item 4): runs are stateless, so a run whose
// instructions name no window is told to look back about two schedule periods.
// Computed from the schedule, never stored. Twice the interval means one failed
// or skipped run leaves no gap; link-based identity merges what is found twice.
// ---------------------------------------------------------------------------

const MAX_WINDOW_MS = 14 * 86_400_000

/** The longest gap between consecutive slots over the next ~two weeks. */
export function intervalOf(schedule: string, from: number): number | null {
  let prev = nextScheduled(schedule, from)
  if (prev == null) return null
  let longest = 0
  const horizon = prev + 15 * 86_400_000
  for (let i = 0; i < 400; i++) {
    const next = nextScheduled(schedule, prev)
    if (next == null) break
    // the first gap always counts, however long (a monthly schedule)
    if (next > horizon && longest > 0) break
    longest = Math.max(longest, next - prev)
    if (next > horizon) break
    prev = next
  }
  return longest || null
}

export function lookbackMs(schedule: string, from: number): number {
  const interval = intervalOf(schedule, from) ?? 86_400_000
  return Math.min(2 * interval, MAX_WINDOW_MS)
}

/** "2 hours", "3 days", "30 minutes". */
export function humanSpan(ms: number): string {
  const plural = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'}`
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return plural(ms / 86_400_000, 'day')
  if (ms >= 2 * 86_400_000) return plural(Math.round(ms / 86_400_000), 'day')
  if (ms >= 3_600_000) return plural(Math.round(ms / 3_600_000), 'hour')
  return plural(Math.max(1, Math.round(ms / 60_000)), 'minute')
}
