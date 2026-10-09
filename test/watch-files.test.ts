/**
 * Watches as files (server/watch-files.ts): the strict schema, the round trip,
 * grants against a probe, ids written into hand-made files, and seeding.
 * Files live in a temp dir — never ~/.triage.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WatchFiles, checkGrants, parseWatchFile, serializeWatchFile, starterWatchFile, withKey, type WatchFileSpec } from '../server/watch-files.js'
import { builtinGrant, mcpToolName } from '../core/watch/tools.js'

const SLACK = 'claude.ai Slack'
const spec: WatchFileSpec = {
  id: 'w-1',
  title: 'Mentions',
  schedule: '0 9 * * 1-5',
  project: 'p-1',
  tools: [builtinGrant('web'), { source: { kind: 'mcp', server: SLACK, scope: 'unknown' }, tools: [mcpToolName(SLACK, 'slack_search_public'), mcpToolName(SLACK, 'slack_read_thread')] }],
  model: 'sonnet',
  output: 'items',
  catchUp: '6h',
  timeoutMs: 240_000,
  budgetUsd: 2,
  dailyBudgetUsd: 5,
  notify: 'on_failure',
  enabled: true,
  instruction: 'Find mentions waiting on me.\n\nFile each one.',
}

test('a spec survives the round trip through its file', () => {
  const text = serializeWatchFile(spec)
  assert.match(text, /^---\nid: w-1\n/)
  assert.match(text, /^tools: \[web, claude\.ai Slack\/slack_search_public, claude\.ai Slack\/slack_read_thread\]$/m)
  assert.match(text, /timeout: 4m/)
  const back = parseWatchFile('mentions', text)
  assert.deepEqual(back.errors, [])
  assert.equal(back.hadId, true)
  assert.deepEqual(back.spec, spec)
})

test('optional keys are left out when unset', () => {
  const { model: _m, catchUp: _c, timeoutMs: _t, budgetUsd: _b, dailyBudgetUsd: _d, ...bare } = spec
  const text = serializeWatchFile(bare)
  for (const k of ['model', 'catch_up', 'timeout', 'budget_usd', 'daily_budget_usd']) assert.doesNotMatch(text, new RegExp(`^${k}:`, 'm'))
  assert.deepEqual(parseWatchFile('m', text).spec, bare)
})

test('an unknown key is an error, never ignored', () => {
  const text = serializeWatchFile(spec).replace('notify: on_failure', 'notify: on_failure\nbudget: 3')
  const { errors } = parseWatchFile('m', text)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /unknown key "budget"/)
})

test('every bad value is reported, and the spec stays usable', () => {
  const text = `---
id: w-2
schedule: every morning
tools: [web, nonsense]
output: report
catch_up: soon
timeout: 2h
budget_usd: 500
daily_budget_usd: -1
notify: loudly
enabled: yes
---
`
  const { spec: s, errors } = parseWatchFile('morning-scan', text)
  const want = [/schedule "every morning"/, /"nonsense" is neither/, /output must be/, /catch_up must be/, /timeout must be/, /budget_usd must be/, /daily_budget_usd must be/, /notify must be/, /enabled must be/, /instruction .* is empty/]
  assert.equal(errors.length, want.length, errors.join('\n'))
  want.forEach((re, i) => assert.match(errors[i], re))
  assert.deepEqual([s.id, s.title, s.output, s.notify, s.enabled], ['w-2', 'Morning scan', 'items', 'on_failure', true])
})

test('no frontmatter, no id: errors, and a fresh id is minted', () => {
  const p = parseWatchFile('x', 'just some text')
  assert.equal(p.hadId, false)
  assert.ok(p.spec.id)
  assert.match(p.errors[0], /no frontmatter/)
})

test('grants are checked against the probe and take its scope', () => {
  const probe = [{ server: SLACK, scope: 'claudeai' as const, tools: [{ fullName: mcpToolName(SLACK, 'slack_search_public') }] }]
  const r = checkGrants(spec.tools, probe)
  assert.deepEqual(r.errors, ['tools: Slack has no tool "slack_read_thread"'])
  assert.equal(r.tools[1].source.kind === 'mcp' && r.tools[1].source.scope, 'claudeai')
  assert.deepEqual(checkGrants(spec.tools, []).errors, [`tools: no connected server named "${SLACK}"`])
  assert.deepEqual(checkGrants(spec.tools, null).errors, [])
  // a disconnected server lists no tools: held by watchReady at run time, not here
  assert.deepEqual(checkGrants(spec.tools, [{ server: SLACK, scope: 'claudeai', tools: [] }]).errors, [])
})

function withDir(fn: (root: string, files: WatchFiles) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'triage-watch-files-'))
  return fn(root, new WatchFiles(root)).finally(() => rmSync(root, { recursive: true, force: true }))
}

test('scan reads *.md only; stampId adds or replaces the id and nothing else', () =>
  withDir(async (root, files) => {
    await files.write('a', spec)
    writeFileSync(path.join(files.dir, 'notes.txt'), 'x')
    writeFileSync(path.join(files.dir, 'b.md'), '---\ntitle: Hand made\nschedule: 0 * * * *\n---\n\nbody\n')
    assert.deepEqual((await files.scan()).map((f) => f.name), ['a', 'b'])
    await files.stampId('b', 'new-id')
    assert.equal(readFileSync(files.pathOf('b'), 'utf8'), '---\nid: new-id\ntitle: Hand made\nschedule: 0 * * * *\n---\n\nbody\n')
    await files.stampId('a', 'copy-id')
    const a = parseWatchFile('a', readFileSync(files.pathOf('a'), 'utf8'))
    assert.deepEqual(a.spec, { ...spec, id: 'copy-id' })
    assert.equal(files.freeName('A'), 'a-2')
    assert.ok(root)
  }))

test('seeding: written once, untouched ones follow upgrades, edits and deletions stick', () =>
  withDir(async (_root, files) => {
    const v1 = { t: { ...spec, id: 'template-t', enabled: false, project: '' } }
    await files.seed(v1)
    assert.equal(parseWatchFile('t', readFileSync(files.pathOf('t'), 'utf8')).spec.id, 'template-t')
    // untouched: follows the new shipped version
    const v2 = { t: { ...v1.t, instruction: 'v2' } }
    await files.seed(v2)
    assert.equal(parseWatchFile('t', readFileSync(files.pathOf('t'), 'utf8')).spec.instruction, 'v2')
    // edited: left alone
    writeFileSync(files.pathOf('t'), readFileSync(files.pathOf('t'), 'utf8').replace('project: ""', 'project: p-9'))
    await files.seed({ t: { ...v1.t, instruction: 'v3' } })
    assert.equal(parseWatchFile('t', readFileSync(files.pathOf('t'), 'utf8')).spec.project, 'p-9')
    // deleted: stays deleted
    unlinkSync(files.pathOf('t'))
    await files.seed(v2)
    await files.seed(v2)
    assert.deepEqual(await files.scan(), [])
  }))

test('the starter file parses clean, comments and all, and names the first project', () => {
  const p = parseWatchFile('new', starterWatchFile([{ id: 'p-1', name: 'Novus' }, { id: 'p-2', name: 'Other' }]))
  assert.deepEqual(p.errors, [])
  assert.equal(p.hadId, false)
  assert.deepEqual([p.spec.title, p.spec.project, p.spec.schedule, p.spec.enabled], ['New watch', 'p-1', '0 9 * * 1-5', true])
  assert.equal(p.spec.timeoutMs, undefined)
})

test('withKey sets one line and leaves comments and layout alone', () => {
  const text = '---\n# mine\ntitle: T\nenabled: true\n# end\n---\n\nbody\n'
  assert.equal(withKey(text, 'enabled', 'false', 'last'), '---\n# mine\ntitle: T\nenabled: false\n# end\n---\n\nbody\n')
  assert.equal(withKey(text, 'id', 'x', 'first'), '---\nid: x\n# mine\ntitle: T\nenabled: true\n# end\n---\n\nbody\n')
  assert.equal(withKey('---\ntitle: T\n---\nb', 'enabled', 'false', 'last'), '---\ntitle: T\nenabled: false\n---\nb')
  assert.equal(withKey('no frontmatter', 'id', 'x', 'first'), '---\nid: x\n---\nno frontmatter')
})
