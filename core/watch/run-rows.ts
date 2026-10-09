/**
 * The watch page's Runs table: one row per slot from the ledger (run, skipped,
 * missed or over budget), joined to the run's session receipt for what only a
 * session knows — tokens and what it filed. Runs from before the ledger have
 * no row there, so they come in from their session alone. Pure.
 */
import type { ActivityRun, WatchRunTrigger, WatchSlotRun, WatchSlotStatus } from '../../shared/protocol.js'

export type RunRow = {
  key: string
  /** the slot the row is for; a run from before the ledger uses its start */
  slot: number
  /** undefined while running */
  status?: WatchSlotStatus
  trigger?: WatchRunTrigger
  reason?: string
  startedAt: number
  endedAt?: number
  costUsd?: number
  /** the session receipt, when the row has a transcript */
  run?: ActivityRun
  /** a missed row: when the catch-up run that covered it started */
  coveredAt?: number
}

const COVERED = /^covered by (.+)$/

export function runRows(ledger: WatchSlotRun[], runs: ActivityRun[]): RunRow[] {
  const bySession = new Map(runs.map((r) => [r.sessionId, r]))
  const byId = new Map(ledger.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const rows: RunRow[] = ledger.map((l) => {
    const run = l.sessionId ? bySession.get(l.sessionId) : undefined
    if (l.sessionId) seen.add(l.sessionId)
    const cover = l.status === 'missed' ? COVERED.exec(l.reason ?? '')?.[1] : undefined
    return {
      key: l.id,
      slot: l.slot,
      status: l.status === 'running' ? undefined : l.status,
      trigger: l.trigger,
      reason: l.reason,
      startedAt: l.startedAt,
      endedAt: l.endedAt,
      costUsd: l.costUsd ?? run?.costUsd,
      run,
      coveredAt: cover ? byId.get(cover)?.startedAt : undefined,
    }
  })
  for (const r of runs) {
    if (seen.has(r.sessionId)) continue
    rows.push({
      key: r.sessionId,
      slot: r.startedAt,
      status: r.status,
      trigger: r.trigger,
      reason: r.error,
      startedAt: r.startedAt,
      endedAt: r.status ? r.finishedAt : undefined,
      costUsd: r.costUsd,
      run: r,
    })
  }
  return rows.sort((a, b) => b.slot - a.slot)
}
