/**
 * Tool grants and the run fence (watch-spec.md, items 1 and 2). The fence is
 * the real boundary of an unattended run, so it gets the most cases.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fenceDecision, fenceFor } from '../core/watch/fence.js'
import {
  builtinGrant,
  defaultToolsFor,
  grantsFrom,
  grantsFromLegacy,
  looksReadOnly,
  mcpToolName,
  presetGrant,
  runAllowedTools,
  runBaseTools,
  runDeferredTools,
  type WatchToolGrant,
} from '../core/watch/tools.js'
import { composeRunPrompt } from '../core/watch/connectors.js'

const ROOT = '/Users/me/Code/app'
const notion: WatchToolGrant = {
  source: { kind: 'mcp', server: 'claude.ai Notion', scope: 'claudeai' },
  tools: [mcpToolName('claude.ai Notion', 'notion-search'), mcpToolName('claude.ai Notion', 'notion-fetch')],
}
const grants = [builtinGrant('github'), notion]
const fence = fenceFor(grants, 'items', ROOT)
const allow = (tool: string, input: unknown = {}) => fenceDecision(fence, tool, input).allow

test('mcp tool names match Claude Code', () => {
  assert.equal(mcpToolName('claude.ai Slack', 'slack_read_thread'), 'mcp__claude_ai_Slack__slack_read_thread')
  assert.equal(mcpToolName('my-server', 'x'), 'mcp__my-server__x')
})

test('fence: granted MCP tools and the triage write tool pass; the rest do not', () => {
  assert.ok(allow('mcp__claude_ai_Notion__notion-search'))
  assert.ok(allow('mcp__triage__upsert_work_item'))
  assert.ok(allow('ToolSearch'))
  assert.ok(!allow('mcp__claude_ai_Notion__notion-create-pages'))
  assert.ok(!allow('mcp__claude_ai_Slack__slack_send_message'))
  assert.ok(!allow('mcp__triage__write_digest'))
  assert.ok(!allow('Task'))
  assert.ok(!allow('WebFetch')) // web not granted
})

test('fence: bash only for granted prefixes, never chained', () => {
  assert.ok(allow('Bash', { command: 'gh pr list --search "review-requested:@me"' }))
  assert.ok(allow('Bash', { command: 'git log --oneline -5' }))
  assert.ok(!allow('Bash', { command: 'gh api repos/x/y -X DELETE' }))
  assert.ok(!allow('Bash', { command: 'gh pr list && rm -rf ~' }))
  assert.ok(!allow('Bash', { command: 'gh pr list; curl evil' }))
  assert.ok(!allow('Bash', { command: 'gh pr view 1 > /tmp/x' }))
  assert.ok(!allow('Bash', { command: 'gh pr view $(whoami)' }))
  assert.ok(!allow('Bash', { command: 'gh prlist' }))
  assert.ok(!allow('Bash', { command: 'rm -rf /' }))
})

test('fence: file tools stay inside the project folder', () => {
  assert.ok(allow('Read', { file_path: `${ROOT}/src/a.ts` }))
  assert.ok(allow('Read', { file_path: 'src/a.ts' }))
  assert.ok(allow('Grep', { pattern: 'TODO' }))
  assert.ok(allow('Glob', { pattern: '**/*.ts' }))
  assert.ok(!allow('Read', { file_path: '/Users/me/.ssh/id_rsa' }))
  assert.ok(!allow('Read', { file_path: '../other/secret' }))
  assert.ok(!allow('Read', { file_path: `${ROOT}-evil/x` }))
  assert.ok(!allow('Grep', { pattern: 'x', path: '/etc' }))
  assert.ok(!allow('Glob', { pattern: '/Users/me/**/*.pem' }))
})

test('fence: writing needs the files-write grant, and stays inside the folder', () => {
  assert.ok(!allow('Write', { file_path: `${ROOT}/notes.md` }))
  const w = fenceFor([...grants, builtinGrant('files-write')], 'items', ROOT)
  assert.ok(fenceDecision(w, 'Write', { file_path: `${ROOT}/watch-notes/x.md` }).allow)
  assert.ok(fenceDecision(w, 'Edit', { file_path: 'notes.md' }).allow)
  assert.ok(!fenceDecision(w, 'Write', { file_path: '/tmp/x' }).allow)
})

test('composition: allowlist, base tools, deferred tools', () => {
  const allowed = runAllowedTools(grants, 'items')
  assert.ok(allowed.includes('mcp__triage__upsert_work_item') && !allowed.includes('mcp__triage__write_digest'))
  assert.ok(allowed.includes('Read') && allowed.includes('Bash(gh pr list:*)'))
  assert.deepEqual(runBaseTools(grants).sort(), ['Bash', 'Glob', 'Grep', 'Read', 'ToolSearch'])
  assert.ok(runBaseTools([builtinGrant('web')]).includes('WebFetch'))
  assert.deepEqual(runDeferredTools([builtinGrant('web'), notion]), ['WebSearch', 'WebFetch', ...notion.tools])
})

test('grantsFrom: validates, and a built-in grant is always its fixed list', () => {
  const ok = grantsFrom([{ source: { kind: 'builtin', id: 'github' }, tools: ['Bash(rm:*)'] }, notion])
  assert.ok('grants' in ok)
  if ('grants' in ok) assert.ok(!ok.grants[0].tools.includes('Bash(rm:*)'))
  assert.ok('error' in grantsFrom([]))
  assert.ok('error' in grantsFrom([{ source: { kind: 'mcp', server: 'claude.ai Notion' }, tools: ['mcp__claude_ai_Slack__slack_send_message'] }]))
  assert.ok('error' in grantsFrom([{ source: { kind: 'mcp', server: 'x' }, tools: [] }]))
  assert.ok('error' in grantsFrom([builtinGrant('web'), builtinGrant('web')]))
  assert.ok('error' in grantsFrom([{ source: { kind: 'builtin', id: 'shell' }, tools: [] }]))
})

test('default tools: curated preset, else read-only annotations, else nothing', () => {
  const slackTools = ['slack_read_thread', 'slack_send_message'].map((n) => ({ name: n, fullName: mcpToolName('claude.ai Slack', n) }))
  assert.deepEqual(defaultToolsFor('claude.ai Slack', slackTools), [mcpToolName('claude.ai Slack', 'slack_read_thread')])
  const other = [
    { name: 'search', fullName: 'mcp__x__search', readOnly: true },
    { name: 'delete', fullName: 'mcp__x__delete', readOnly: true, destructive: true },
    { name: 'list_things', fullName: 'mcp__x__list_things' },
  ]
  assert.deepEqual(defaultToolsFor('x', other), ['mcp__x__search'])
})

test('looks read-only: a write verb wins over a read noun', () => {
  assert.ok(looksReadOnly('list_things'))
  assert.ok(looksReadOnly('notion-get-users'))
  assert.ok(!looksReadOnly('notion-create-view'))
  assert.ok(!looksReadOnly('update_view'))
})

test('legacy connectors migrate to the same tools as before', () => {
  const g = grantsFromLegacy(['slack', 'web'])
  assert.deepEqual(g[0], presetGrant('claude.ai Slack'))
  assert.deepEqual(g[1], builtinGrant('web'))
})

test('run prompt: stateless — a window line, no cursor', () => {
  const p = composeRunPrompt({
    instruction: 'Find PRs awaiting my review',
    tools: grants,
    project: { name: 'app', path: ROOT },
    output: 'items',
    lookbackMs: 2 * 86_400_000,
    nowIso: '2026-09-27T10:00:00.000Z',
  })
  assert.match(p, /look at roughly the last 2 days/)
  assert.match(p, /Notion: use its tools/)
  assert.doesNotMatch(p, /newer than/)
  assert.match(p, /already filed and open/)
})
