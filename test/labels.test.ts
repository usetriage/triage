/**
 * Labels (core/work/labels.ts): scanner kinds keep their weights, a watch hit
 * ranks by the label its run picked, and an unknown ask reads as Read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KIND_TO_LABEL, LABELS, labelOf } from '../core/work/labels.js'
import { BASE, scoreItem } from '../core/work/score.js'
import type { ItemKind, WorkItem } from '../core/work/types.js'

const NOW = Date.parse('2026-10-09T12:00:00Z')

function item(kind: ItemKind, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `slack:${kind}`,
    source: 'slack',
    kind,
    title: kind,
    url: 'https://example.slack.com/archives/C1/p1',
    repo: '#eng',
    author: 'niraj',
    peopleWaiting: 0,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...extra,
  }
}

test('every kind maps to a label', () => {
  for (const kind of Object.keys(BASE) as ItemKind[]) assert.ok(LABELS[KIND_TO_LABEL[kind]], kind)
})

test('scanner kinds keep their base weight and group', () => {
  const s = scoreItem(item('review-requested'), NOW)
  assert.equal(s.label, 'review')
  assert.equal(s.score, BASE['review-requested'])
  assert.equal(s.group, 'blocking')
  assert.equal(scoreItem(item('own-pr-open'), NOW).label, 'follow-up')
  assert.equal(scoreItem(item('own-pr-open'), NOW).group, 'fyi')
})

test('a watch hit takes its label weight and group', () => {
  const reply = scoreItem(item('watch-hit', { ask: 'reply' }), NOW)
  assert.equal(reply.label, 'reply')
  assert.equal(reply.group, 'blocking')
  assert.equal(reply.score, LABELS.reply.weight)
  // a watch-found reply outranks a plain mention
  assert.ok(reply.score > scoreItem(item('slack-mention'), NOW).score)
})

test('a watch hit with no ask, or one that is no longer a label, is Read', () => {
  assert.equal(labelOf(item('watch-hit')), 'read')
  assert.equal(labelOf(item('watch-hit', { ask: 'escalate' })), 'read')
  assert.equal(scoreItem(item('watch-hit', { ask: 'escalate' }), NOW).group, 'fyi')
})

test('ask only moves watch hits; a scanner kind ignores it', () => {
  assert.equal(labelOf(item('mention', { ask: 'decide' })), 'read')
})
