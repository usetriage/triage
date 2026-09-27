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
