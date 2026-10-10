/**
 * Dispatch template rendering (server/briefs.ts): dispatchPreviewOp always
 * attaches the item itself as an @item: mention, so it no longer feeds
 * `description` into the template — the rendered body should drop the
 * "Description: ..." line entirely rather than duplicate what the mention's
 * attachment already carries.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DISPATCH_TEMPLATE, renderTemplate } from '../server/briefs.js'

const baseVars = {
  kind: 'github-issue',
  title: 'fix the thing',
  url: undefined,
  reason: undefined,
  note: undefined,
  brief: false,
  source: true,
}

test('omits the Description line when description is not passed', () => {
  const body = renderTemplate(DEFAULT_DISPATCH_TEMPLATE, baseVars)
  assert.ok(!body.includes('Description:'))
})

test('still renders Description when a caller does pass it', () => {
  const body = renderTemplate(DEFAULT_DISPATCH_TEMPLATE, { ...baseVars, description: 'the user\'s own words' })
  assert.ok(body.includes("Description: the user's own words"))
})
