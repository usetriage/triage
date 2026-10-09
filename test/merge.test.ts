/**
 * Merging duplicates (core/work/link.ts): refs pulled out of an item's own
 * words fold rows about the same thing into one, without guessing across repos.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkByRefs, textRefs } from '../core/work/link.js'
import { rank } from '../core/work/score.js'
import type { WorkItem } from '../core/work/types.js'

const NOW = Date.parse('2026-10-09T12:00:00Z')

function it(id: string, title: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    source: id.startsWith('github:') ? 'github' : 'slack',
    kind: id.startsWith('github:') ? 'review-requested' : 'watch-hit',
    title,
    url: 'https://example.com',
    repo: '#eng',
    author: '',
    peopleWaiting: 0,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...extra,
  }
}

test('textRefs: ticket keys and bare PR numbers, not standards or small numbers', () => {
  assert.deepEqual(textRefs({ title: 'Token/cost fix for PX-239', why: 'see #2745', repo: '#eng' }), ['linear:PX-239', 'num:2745'])
  assert.deepEqual(textRefs({ title: 'ISO-8601 dates, UTF-8, step #2', repo: '#eng' }), [])
  // inside a repo, a bare number is that repo's
  assert.deepEqual(textRefs({ title: 'follow-up to #2745', repo: 'acme/app' }), ['github:acme/app#2745'])
})

test('a Slack thread naming #2745 folds into the PR, with its people', () => {
  const out = linkByRefs(
    rank(
      [
        it('github:acme/app#2745', 'Token/cost fix', { author: 'Niraj' }),
        it('slack:C1/p1', 'Can someone look at #2745?', { author: 'Drew', ask: 'review' }),
        it('slack:C1/p2', 'cost spike again', { author: 'Drew', why: 'mentions PX-239' }),
        it('slack:C2/p3', 'PX-239 is the token/cost ticket', { author: 'Sam', why: 'and #2745' }),
      ],
      NOW,
    ),
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'github:acme/app#2745')
  assert.equal(out[0].linked?.length, 3)
  assert.deepEqual(out[0].linked?.map((l) => l.author).sort(), ['Drew', 'Drew', 'Sam'])
})

test('a bare number two repos share joins neither repo, only other mentions', () => {
  const out = linkByRefs(
    rank(
      [
        it('github:acme/app#3001', 'App PR'),
        it('github:acme/api#3001', 'API PR'),
        it('slack:C1/p1', 'about #3001'),
        it('slack:C1/p2', 'also #3001'),
      ],
      NOW,
    ),
  )
  assert.equal(out.length, 3)
  const slack = out.find((i) => i.id.startsWith('slack:'))
  assert.equal(slack?.linked?.length, 1)
})
