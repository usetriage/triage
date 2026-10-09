/**
 * The watch page's Runs table fold (core/watch/run-rows.ts): ledger rows joined
 * to session receipts, plus pre-ledger runs from their session alone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runRows } from '../core/watch/run-rows.js'
import type { ActivityRun, WatchSlotRun } from '../shared/protocol.js'

const row = (slot: number, extra: Partial<WatchSlotRun> = {}): WatchSlotRun => ({
  id: `r${slot}`, watchId: 'w1', slot, trigger: 'scheduled', status: 'ok', startedAt: slot + 5, endedAt: slot + 50, ...extra,
})
const session = (sessionId: string, startedAt: number, extra: Partial<ActivityRun> = {}): ActivityRun => ({
  sessionId, watchTitle: 'W', status: 'ok', startedAt, finishedAt: startedAt + 40, ...extra,
})

test('ledger rows join their session; pre-ledger sessions come in alone; newest slot first', () => {
  const rows = runRows(
    [row(3000, { sessionId: 's3' }), row(2000, { status: 'skipped', reason: 'overlap: x' })],
    [session('s3', 3005, { tokens: 900, newCount: 2, matches: 3 }), session('s-old', 1000, { costUsd: 0.1 })],
  )
  assert.deepEqual(rows.map((r) => [r.key, r.slot, r.status, r.run?.sessionId]), [
    ['r3000', 3000, 'ok', 's3'],
    ['r2000', 2000, 'skipped', undefined],
    ['s-old', 1000, 'ok', 's-old'],
  ])
  assert.equal(rows[0].run?.tokens, 900)
  assert.equal(rows[2].costUsd, 0.1)
})

test('a missed row knows when its covering run started; running reads as no status', () => {
  const rows = runRows(
    [
      row(4000, { status: 'missed', trigger: 'catch_up', reason: 'covered by r1000', startedAt: 9000 }),
      row(1000, { status: 'running', trigger: 'catch_up', startedAt: 9000, endedAt: undefined, sessionId: 's1' }),
    ],
    [session('s1', 9000, { status: undefined })],
  )
  assert.equal(rows[0].coveredAt, 9000)
  assert.equal(rows[1].status, undefined)
  assert.equal(rows[1].run?.sessionId, 's1')
})
