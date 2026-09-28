/**
 * An item's links (the item page's Links section): refs back to URLs, a label
 * per URL, and one row per canonical target however many ways it arrived.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeUrl, itemLinks, refUrl } from '../core/work/link.js'

test('refUrl: github and web refs open; lossy refs do not', () => {
  assert.equal(refUrl('github:acme/app#12'), 'https://github.com/acme/app/issues/12')
  assert.equal(refUrl('web:example.com/docs/a'), 'https://example.com/docs/a')
  assert.equal(refUrl('linear:NOV-4'), null)
  assert.equal(refUrl('slack:C123/p456'), null)
})

test('describeUrl: labels by what the link points at', () => {
  assert.deepEqual(describeUrl('https://github.com/acme/app/pull/12/files'), { kind: 'github-pr', label: 'acme/app #12' })
  assert.deepEqual(describeUrl('https://github.com/acme/app/issues/3'), { kind: 'github-issue', label: 'acme/app #3' })
  assert.deepEqual(describeUrl('https://acme.slack.com/archives/C123/p1700000000123456'), { kind: 'slack', label: 'Slack thread' })
  assert.deepEqual(describeUrl('https://linear.app/acme/issue/NOV-4/some-title'), { kind: 'linear', label: 'NOV-4' })
  assert.deepEqual(describeUrl('https://www.Example.com/docs/'), { kind: 'web', label: 'example.com/docs' })
  assert.deepEqual(describeUrl('not a url'), { kind: 'web', label: 'not a url' })
})

test('itemLinks: source first, then yours, then mentioned — each target once', () => {
  const links = itemLinks({
    id: 'slack:C123/p1',
    url: 'https://acme.slack.com/archives/C123/p1',
    // the same PR pasted by the user and seen by the scanner; one row, the user's
    urls: ['https://github.com/acme/app/pull/12', 'https://docs.acme.dev/spec'],
    refs: ['github:acme/app#12', 'github:acme/app#13', 'linear:NOV-4'],
  })
  assert.deepEqual(
    links.map((l) => [l.origin, l.label]),
    [
      ['source', 'Slack thread'],
      ['added', 'acme/app #12'],
      ['added', 'docs.acme.dev/spec'],
      ['mentioned', 'acme/app #13'],
    ],
  )
})

test('itemLinks: a ref to the item itself is not a second row', () => {
  const links = itemLinks({ id: 'github:acme/app#12', url: 'https://github.com/acme/app/pull/12', refs: ['github:acme/app#12'] })
  assert.equal(links.length, 1)
  assert.equal(links[0].origin, 'source')
})

test('itemLinks: a manual item with no url shows only what was added', () => {
  assert.deepEqual(itemLinks({ id: 'manual:x', url: '' }), [])
})
