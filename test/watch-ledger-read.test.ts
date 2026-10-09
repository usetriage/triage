/**
 * The slot ledger's read side: the slots a catch-up run collapses and the
 * overdue rule. Pure — time is always an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetFor, describeLateness, isOverdue, localMidnight, MISSED_CAP, missedSlots } from '../core/watch/schedule.js'
import { composeRunPrompt } from '../core/watch/connectors.js'

const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime() // Sept 2026, local

test('missed: an hourly catch-up at 08:00 running at 11:30 covers 09:00, 10:00, 11:00', () => {
  assert.deepEqual(missedSlots('0 * * * *', at(10, 8), at(10, 11, 30)), [at(10, 9), at(10, 10), at(10, 11)])
})

test('missed: an every-minute schedule asleep for days stops at the cap', () => {
  const out = missedSlots('* * * * *', at(10, 8), at(13, 8))
  assert.equal(out.length, MISSED_CAP)
  assert.equal(out[0], at(10, 8, 1))
})

test('missed: no gap, no rows', () => {
  assert.deepEqual(missedSlots('0 * * * *', at(10, 8), at(10, 8, 59)), [])
})

// hourly: grace = 2h + 1h
const HOURLY = '0 * * * *'
const hourly = { createdAt: at(1, 0) }

test('overdue: only skipped/failed rows since creation means overdue', () => {
  assert.equal(isOverdue(HOURLY, { ...hourly, lastRunAt: at(10, 11), lastRunStatus: 'skipped' }, undefined, at(10, 11, 30)), true)
  assert.equal(isOverdue(HOURLY, { ...hourly, lastRunAt: at(10, 11), lastRunStatus: 'failed' }, undefined, at(10, 11, 30)), true)
})

test('overdue: an ok row inside grace is not overdue, one outside it is', () => {
  const w = { ...hourly, lastRunAt: at(10, 11), lastRunStatus: 'skipped' as const }
  assert.equal(isOverdue(HOURLY, w, at(10, 9), at(10, 11, 30)), false)
  assert.equal(isOverdue(HOURLY, w, at(10, 8), at(10, 11, 30)), true)
})

test('overdue: with no ok row, falls back to lastRunAt when it was ok, else createdAt', () => {
  assert.equal(isOverdue(HOURLY, { ...hourly, lastRunAt: at(10, 10), lastRunStatus: 'ok' }, undefined, at(10, 11)), false)
  assert.equal(isOverdue(HOURLY, { ...hourly, createdAt: at(10, 10) }, undefined, at(10, 11)), false)
  assert.equal(isOverdue(HOURLY, { ...hourly, createdAt: at(10, 7) }, undefined, at(10, 10, 1)), true)
})

test('lateness: on time with nothing missed says nothing', () => {
  assert.equal(describeLateness(at(10, 8), [], at(10, 8, 1)), null)
})

test('lateness: names the slot, how late, and the missed slots it covers', () => {
  const line = describeLateness(at(9, 20), [at(9, 21), at(10, 7)], at(10, 7, 10))!
  assert.match(line, /scheduled for Wed 20:00 and is starting 11 hours late/)
  assert.match(line, /missed slots Wed 21:00, 07:00\./)
  assert.match(line, /skip anything that is stale/)
})

test('lateness: lists the newest ten missed slots and counts the rest', () => {
  const missed = Array.from({ length: 14 }, (_, i) => at(10, 1 + i))
  const line = describeLateness(at(10, 0), missed, at(10, 15, 30))!
  assert.match(line, /missed slots 05:00, .*, 14:00 and 4 earlier\./)
})

test('the run prompt carries the lateness line when there is one', () => {
  const base = { instruction: 'x', tools: [], project: { name: 'p', path: '/p' }, lookbackMs: 3_600_000, nowIso: '2026-09-10T10:00:00Z' }
  assert.doesNotMatch(composeRunPrompt(base), /late/)
  assert.match(composeRunPrompt({ ...base, lateness: 'This run is 3 hours late.' }), /This run is 3 hours late\./)
})

test('budget: no daily cap passes the per-run cap through', () => {
  assert.deepEqual(budgetFor(2, undefined, 50), { skip: false, maxBudgetUsd: 2 })
  assert.deepEqual(budgetFor(undefined, undefined, 50), { skip: false })
})

test('budget: spent at or over the daily cap skips', () => {
  const d = budgetFor(2, 5, 5)
  assert.equal(d.skip, true)
  assert.match(d.skip ? d.reason : '', /spent \$5\.00 of the \$5\.00 daily budget/)
  assert.equal(budgetFor(undefined, 5, 7.5).skip, true)
})

test('budget: a run may spend the smaller of its own cap and what is left today', () => {
  assert.deepEqual(budgetFor(2, 5, 4), { skip: false, maxBudgetUsd: 1 })
  assert.deepEqual(budgetFor(2, 5, 1), { skip: false, maxBudgetUsd: 2 })
  assert.deepEqual(budgetFor(undefined, 5, 1.5), { skip: false, maxBudgetUsd: 3.5 })
})

test('budget: the day resets at local midnight', () => {
  assert.equal(localMidnight(at(10, 15, 42)), at(10, 0))
  assert.equal(localMidnight(at(10, 0)), at(10, 0))
})
