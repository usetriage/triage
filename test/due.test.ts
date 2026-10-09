/**
 * Due dates and day sections (core/work/due.ts). Local time throughout, so
 * every date here is built with the local Date constructor.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueFor, dueOf, parseDue, sectionFor, sectionTitle, startOfDay } from '../core/work/due.js'

const day = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).getTime()
// 2026-10-07 is a Wednesday; 10-09 a Friday.
const WED = day(2026, 10, 7)
const THU = day(2026, 10, 8)
const FRI = day(2026, 10, 9)
const SAT = day(2026, 10, 10)

test('t / m / w resolve to a day; l to none', () => {
  assert.equal(dueFor('today', WED), startOfDay(WED))
  assert.equal(dueFor('next-workday', WED), day(2026, 10, 8, 0))
  assert.equal(dueFor('this-week', WED), day(2026, 10, 9, 0))
  assert.equal(dueFor('later', WED), null)
})

test('next workday skips the weekend', () => {
  assert.equal(dueFor('next-workday', FRI), day(2026, 10, 12, 0))
  assert.equal(dueFor('next-workday', SAT), day(2026, 10, 12, 0))
  assert.equal(sectionTitle('next-workday', FRI), `Due ${new Date(day(2026, 10, 12)).toLocaleDateString(undefined, { weekday: 'long' })}`)
})

test('this week ends on the Friday after the next workday', () => {
  // Thursday: the next workday is Friday, so w means next week's Friday
  assert.equal(dueFor('this-week', THU), day(2026, 10, 16, 0))
  assert.equal(sectionTitle('this-week', THU), 'Next week')
  assert.equal(sectionTitle('this-week', WED), 'This week')
  // the weekend looks at the coming week
  assert.equal(dueFor('this-week', SAT), day(2026, 10, 16, 0))
  assert.equal(sectionTitle('this-week', SAT), 'This week')
})

test('a key sets the section it names', () => {
  for (const now of [WED, THU, FRI, SAT]) {
    for (const s of ['today', 'next-workday', 'this-week'] as const) {
      assert.equal(sectionFor(dueFor(s, now)!, now), s, `${s} on ${new Date(now).toDateString()}`)
    }
  }
})

test('overdue rolls into Today with how late it is', () => {
  const v = dueOf({ label: 'do', dueAt: day(2026, 10, 7, 0), dueSource: 'you' }, FRI)
  assert.equal(v.section, 'today')
  assert.equal(v.late, 2)
})

test('defaults come from the label and are never late', () => {
  assert.deepEqual(dueOf({ label: 'reply' }, FRI), { section: 'today', source: 'default', at: null, late: 0 })
  assert.equal(dueOf({ label: 'do' }, FRI).section, 'this-week')
  assert.equal(dueOf({ label: 'read' }, FRI).section, 'later')
})

test('a Later you chose has no day', () => {
  assert.deepEqual(dueOf({ label: 'reply', dueSource: 'you' }, FRI), { section: 'later', source: 'you', at: null, late: 0 })
})

test('a bare date is that local day, not UTC midnight', () => {
  assert.equal(parseDue('2026-10-12'), day(2026, 10, 12, 0))
  assert.equal(parseDue('2026-10-12T15:00:00'), day(2026, 10, 12, 0))
  assert.equal(parseDue('soon'), null)
  assert.equal(parseDue(undefined), null)
})

test('store: a due you set outlives a rescan; a stated one fills in otherwise', async () => {
  const { openSqliteStore } = await import('../core/store/sqlite.js')
  const store = openSqliteStore(':memory:')
  const base = {
    source: 'slack' as const,
    kind: 'watch-hit' as const,
    title: 't',
    url: 'https://x.slack.com/archives/C1/p1',
    repo: '#eng',
    author: 'drew',
    peopleWaiting: 0,
    createdAt: '2026-10-07T10:00:00Z',
  }
  await store.items.upsert({ ...base, id: 'slack:a', updatedAt: '2026-10-07T10:00:00Z', dueAt: day(2026, 10, 9, 0) })
  assert.equal((await store.items.get('slack:a'))?.dueSource, 'explicit')

  await store.items.setDue('slack:a', { at: day(2026, 10, 12, 0) })
  await store.items.upsert({ ...base, id: 'slack:a', updatedAt: '2026-10-08T10:00:00Z', dueAt: day(2026, 10, 10, 0) })
  const after = await store.items.get('slack:a')
  assert.equal(after?.dueSource, 'you')
  assert.equal(after?.dueAt, day(2026, 10, 12, 0))

  // back to the default
  await store.items.setDue('slack:a', null)
  const reset = await store.items.get('slack:a')
  assert.equal(reset?.dueSource, undefined)
  assert.equal(reset?.dueAt, undefined)
  await store.close()
})
