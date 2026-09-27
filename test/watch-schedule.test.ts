/**
 * The due rule, one test per row of the scenario table in watch-spec.md
 * (item 3.8, ported from wakecron's §6). Time is always an argument — no test
 * waits on the real clock. Dates are built in local time, as cron is.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, humanSpan, lookbackMs, parseCatchUp, pickToRun, type CatchUpWindow, type Decision } from '../core/watch/schedule.js'

const TICK = 60_000
const DAY = 86_400_000
const at = (d: number, h: number, m = 0, s = 0) => new Date(2026, 8, d, h, m, s).getTime() // Sept 2026, local
const SIX_H: CatchUpWindow = { kind: 'duration', ms: 6 * 3_600_000 }
const UNLIMITED: CatchUpWindow = { kind: 'unlimited' }

type Case = { schedule: string; last: number | undefined; now: number; catchUp?: CatchUpWindow; running?: boolean; ready?: true | string }
const run = (c: Case): Decision =>
  decide({ schedule: c.schedule, lastRunStartedAt: c.last, now: c.now, tickMs: TICK, running: c.running ?? false, ready: c.ready ?? true, catchUp: c.catchUp ?? SIX_H })

/** Tick minute by minute; a run or skip moves the clock to now, as the scheduler does. Returns the actions taken. */
function simulate(schedule: string, last: number, from: number, minutes: number, catchUp: CatchUpWindow = UNLIMITED): Decision[] {
  const out: Decision[] = []
  for (let i = 0; i < minutes; i++) {
    const now = from + i * TICK
    const d = run({ schedule, last, now, catchUp })
    if (d.action !== 'idle') {
      out.push(d)
      last = now
    }
  }
  return out
}

test('1: not due just before the slot', () => {
  assert.equal(run({ schedule: '0 10 * * *', last: at(9, 10, 0, 5), now: at(10, 9, 59, 50) }).action, 'idle')
})

test('2: due at the slot, scheduled', () => {
  const d = run({ schedule: '0 10 * * *', last: at(9, 10, 0, 5), now: at(10, 10, 0, 20) })
  assert.deepEqual([d.action, d.action === 'run' && d.trigger], ['run', 'scheduled'])
})

test('3: slept through the slot, inside the window: catch-up', () => {
  const d = run({ schedule: '0 10 * * *', last: at(9, 10, 0, 5), now: at(10, 14, 0) })
  assert.deepEqual([d.action, d.action === 'run' && d.trigger], ['run', 'catch_up'])
})

test('4: slept past the window: skipped, next slot tomorrow', () => {
  const d = run({ schedule: '0 10 * * *', last: at(9, 10, 0, 5), now: at(10, 17, 30) })
  assert.deepEqual([d.action, d.action === 'skip' && d.reason], ['skip', 'window'])
  // the skip moves the clock to now; the next run is tomorrow's slot
  assert.equal(run({ schedule: '0 10 * * *', last: at(10, 17, 30), now: at(11, 9, 59) }).action, 'idle')
  assert.equal(run({ schedule: '0 10 * * *', last: at(10, 17, 30), now: at(11, 10, 0, 10) }).action, 'run')
})

test('5: three days off, unlimited window: exactly one run', () => {
  const actions = simulate('0 10 * * *', at(7, 10, 0), at(10, 11, 0), 60)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].action, 'run')
})

test('6: every 10 minutes, slept five hours: one run, not 30', () => {
  const actions = simulate('*/10 * * * *', at(10, 10, 0), at(10, 15, 0, 30), 5)
  assert.equal(actions.length, 1)
})

test('7: a manual run spanning the slot: the slot is dropped as overlap, not run twice', () => {
  const d = run({ schedule: '0 10 * * *', last: at(10, 9, 58), now: at(10, 10, 0, 20), running: true })
  assert.deepEqual([d.action, d.action === 'skip' && d.reason], ['skip', 'overlap'])
})

test('7b: a manual run that finished before the slot does not swallow it', () => {
  assert.equal(run({ schedule: '0 10 * * *', last: at(10, 9, 58), now: at(10, 10, 0, 20) }).action, 'run')
})

test('8: re-enabled after a pause: no burst, next slot tomorrow', () => {
  // enabling sets lastRunStartedAt = now
  assert.equal(run({ schedule: '0 10 * * *', last: at(10, 15, 0), now: at(10, 15, 0, 30) }).action, 'idle')
  const d = run({ schedule: '0 10 * * *', last: at(10, 15, 0), now: at(10, 15, 0, 30) })
  assert.equal(d.slot, at(11, 10, 0))
})

test('9: still running when due again: skip (overlap)', () => {
  const d = run({ schedule: '*/10 * * * *', last: at(10, 10, 0), now: at(10, 10, 10), running: true })
  assert.deepEqual([d.action, d.action === 'skip' && d.reason], ['skip', 'overlap'])
})

test('10: capacity 1, two due: oldest slot first, the other keeps its slot', () => {
  const due = [{ id: 'b', slot: at(10, 10, 0) }, { id: 'a', slot: at(10, 9, 0) }]
  assert.deepEqual(pickToRun(due, 1).map((r) => r.id), ['a'])
  assert.deepEqual(pickToRun(due, 0), [])
})

test('11: clock set backwards: nothing due, no double run', () => {
  assert.equal(run({ schedule: '0 10 * * *', last: at(10, 10, 0, 5), now: at(10, 9, 30) }).action, 'idle')
})

test('12: a connector the watch needs is down: skip (connector)', () => {
  const d = run({ schedule: '0 10 * * *', last: at(9, 10, 0, 5), now: at(10, 10, 0, 20), ready: 'Slack needs-auth' })
  assert.deepEqual([d.action, d.action === 'skip' && d.reason, d.action === 'skip' && d.detail], ['skip', 'connector', 'Slack needs-auth'])
})

test('13: connectors fine (e.g. a Web-only watch while Slack is down): runs', () => {
  assert.equal(run({ schedule: '0 10 * * *', last: at(9, 10, 0, 5), now: at(10, 10, 0, 20), ready: true }).action, 'run')
})

test('never run: due right away', () => {
  const d = run({ schedule: '0 10 * * *', last: undefined, now: at(10, 15, 0) })
  assert.deepEqual([d.action, d.action === 'run' && d.trigger], ['run', 'scheduled'])
})

test('catch-up "never": only a same-tick slot runs', () => {
  const never: CatchUpWindow = { kind: 'never' }
  assert.equal(run({ schedule: '0 10 * * *', last: at(9, 10, 0, 5), now: at(10, 10, 0, 30), catchUp: never }).action, 'run')
  assert.equal(run({ schedule: '0 10 * * *', last: at(9, 10, 0, 5), now: at(10, 10, 5), catchUp: never }).action, 'skip')
})

test('catch-up defaults: digests 6h, items unlimited', () => {
  assert.deepEqual(parseCatchUp(undefined, 'digest'), { kind: 'duration', ms: 6 * 3_600_000 })
  assert.deepEqual(parseCatchUp(undefined, 'items'), { kind: 'unlimited' })
  assert.deepEqual(parseCatchUp('2h', 'items'), { kind: 'duration', ms: 2 * 3_600_000 })
  assert.deepEqual(parseCatchUp('bogus', 'digest'), { kind: 'duration', ms: 6 * 3_600_000 })
})

test('look-back window: twice the longest gap, capped at 14 days', () => {
  const from = at(10, 12, 0)
  assert.equal(lookbackMs('0 * * * *', from), 2 * 3_600_000)
  assert.equal(lookbackMs('0 9 * * *', from), 2 * DAY)
  assert.equal(lookbackMs('0 9 * * 1-5', from), 6 * DAY) // Fri → Mon is the longest gap
  assert.equal(lookbackMs('0 9 1 * *', from), 14 * DAY)
  assert.equal(humanSpan(2 * 3_600_000), '2 hours')
  assert.equal(humanSpan(2 * DAY), '2 days')
  assert.equal(humanSpan(30 * 60_000), '30 minutes')
})
