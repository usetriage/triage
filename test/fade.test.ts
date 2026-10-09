/**
 * Old FYI fades (core/work/fade.ts): Read items fold after 3 days and archive
 * after 7 — unless you touched them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOldFyi, shouldArchive } from '../core/work/fade.js'
import type { WorkItem } from '../core/work/types.js'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

function fyi(age: number, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'slack:C1/p1',
    source: 'slack',
    kind: 'watch-hit',
    ask: 'read',
    title: 'a thing to know',
    url: 'https://x.slack.com/archives/C1/p1',
    repo: '#eng',
    author: '',
    peopleWaiting: 0,
    createdAt: daysAgo(age),
    updatedAt: daysAgo(age),
    ingestedAt: NOW - age * 86_400_000,
    ...extra,
  }
}

const none = new Set<string>()

test('Read folds after 3 days; an ask never folds', () => {
  assert.equal(isOldFyi(fyi(2), NOW), false)
  assert.equal(isOldFyi(fyi(4), NOW), true)
  assert.equal(isOldFyi(fyi(4, { ask: 'reply' }), NOW), false)
  // a Read you gave a due is yours
  assert.equal(isOldFyi(fyi(4, { dueSource: 'you' }), NOW), false)
})

test('age counts from when it reached the inbox, if later', () => {
  assert.equal(isOldFyi(fyi(10, { ingestedAt: NOW - 3_600_000 }), NOW), false)
  assert.equal(shouldArchive(fyi(10, { ingestedAt: NOW - 3_600_000 }), NOW, none), false)
})

test('untouched Read archives after 7 days', () => {
  assert.equal(shouldArchive(fyi(6), NOW, none), false)
  assert.equal(shouldArchive(fyi(8), NOW, none), true)
})

test('anything you touched stays', () => {
  assert.equal(shouldArchive(fyi(8, { priority: 2 }), NOW, none), false)
  assert.equal(shouldArchive(fyi(8, { description: 'keep' }), NOW, none), false)
  assert.equal(shouldArchive(fyi(8, { dueSource: 'you' }), NOW, none), false)
  assert.equal(shouldArchive(fyi(8), NOW, new Set(['slack:C1/p1'])), false)
  assert.equal(shouldArchive(fyi(8, { kind: 'review-requested', ask: undefined }), NOW, none), false)
})
