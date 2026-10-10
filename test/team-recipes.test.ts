/**
 * Team recipes (core/teams/recipe.ts): the YAML subset, the strict schema, the
 * rules every team obeys, the round trip, and the shipped defaults seeding next
 * to V1/V2 roster files. Files live in a temp dir — never ~/.triage.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isRecipeFile, leadWrites, parseRecipe, parseYaml, recipeAgents, serializeRecipe, type TeamRecipe } from '../core/teams/recipe.js'
import { SHIPPED_RECIPES } from '../server/team-recipes.js'
import { TeamLibrary } from '../server/teams.js'

const file = (yaml: string, body = '') => `---\n${yaml.trim()}\n---\n${body}`
const errorsOf = (yaml: string) => parseRecipe('t', file(yaml)).errors

const STEPS = `steps:
  - id: build
    agent: implementer
    output: change`

test('the YAML subset: nested maps, block and flow lists, flow maps, quotes, comments', () => {
  const v = parseYaml(`label: "Review: big ones"   # a comment
use-for: [a, "b, c"]
lead: { model: opus, effort: high }
empty:
steps:
  - id: x
    fan-out: { by: area, max: 4 }
    does: it's fine # trailing
  - plain
  - [don't, "x, y"]
nested:
  inner:
    - 1
    - '2'`)
  assert.deepEqual(v, {
    label: 'Review: big ones',
    'use-for': ['a', 'b, c'],
    lead: { model: 'opus', effort: 'high' },
    empty: '',
    steps: [{ id: 'x', 'fan-out': { by: 'area', max: '4' }, does: "it's fine" }, 'plain', ["don't", 'x, y']],
    nested: { inner: ['1', '2'] },
  })
})

test('the YAML subset rejects what it does not understand, with a line number', () => {
  assert.throws(() => parseYaml('a: 1\na: 2'), /line 2: "a" appears twice/)
  assert.throws(() => parseYaml('a: [1, 2'), /unclosed/)
  assert.throws(() => parseYaml('a: 1\n   b: 2'), /line 2: unexpected indentation/)
  assert.throws(() => parseYaml('just words'), /expected "key: value"/)
  assert.throws(() => parseYaml('a:\n\t- 1'), /tabs/)
})

test('every shipped recipe parses clean and names agents triage ships', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-recipes-'))
  try {
    const lib = new TeamLibrary(dir)
    await lib.seed()
    const agents = new Set((await lib.agents()).map((a) => a.name))
    for (const [name, text] of Object.entries(SHIPPED_RECIPES)) {
      assert.ok(isRecipeFile(text), name)
      const r = parseRecipe(name, text)
      assert.deepEqual(r.errors, [], name)
      for (const a of recipeAgents(r.recipe!)) assert.ok(agents.has(a), `${name} needs agent ${a}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Solo: the lead builds, checks and a checker can send it back twice', () => {
  const { recipe } = parseRecipe('solo', SHIPPED_RECIPES.solo)
  assert.ok(recipe)
  assert.equal(recipe.label, 'Solo')
  assert.equal(recipe.budgetUsd, 3)
  assert.equal(leadWrites(recipe), true)
  assert.deepEqual(
    recipe.steps.map((s) => [s.id, s.agent, s.output, s.onFail?.backTo ?? null]),
    [
      ['build', 'lead', 'change', null],
      ['checks', 'checks', null, 'build'],
      ['verify', 'reviewer', 'verdict', 'build'],
    ],
  )
  assert.match(recipe.advice, /^Keep the card small/)
})

test('Review fans out by area, then validates by finding on a cheaper model', () => {
  const { recipe } = parseRecipe('review', SHIPPED_RECIPES.review)
  assert.ok(recipe)
  assert.equal(leadWrites(recipe), false)
  assert.deepEqual(recipe.steps[0].fanOut, { by: 'area', max: 4 })
  assert.deepEqual(recipe.steps[1].fanOut, { by: 'finding', max: 4 })
  assert.equal(recipe.steps[1].model, 'sonnet')
  assert.deepEqual(recipe.useFor, ['review-requested'])
})

test('a recipe survives the round trip through its file', () => {
  for (const [name, text] of Object.entries(SHIPPED_RECIPES)) {
    const a = parseRecipe(name, text).recipe!
    const b = parseRecipe(name, serializeRecipe(a, 'local'))
    assert.deepEqual(b.errors, [], name)
    assert.deepEqual(b.recipe, a, name)
  }
  const tricky: TeamRecipe = {
    label: 'Mine: "quoted" # not a comment',
    description: 'ends with a comma,',
    useFor: [],
    budgetUsd: 2.5,
    lead: { model: 'claude-opus-5-5', effort: null },
    done: '',
    steps: [{ id: 'notes', agent: 'researcher', output: 'notes', does: 'a: b', fanOut: null, onFail: null, gate: null, model: null, forEach: null, context: null }],
    advice: '',
  }
  assert.deepEqual(parseRecipe('x', serializeRecipe(tricky, 'local')).recipe, tricky)
})

test('strict: unknown keys and bad values are errors, never ignored', () => {
  assert.match(errorsOf(`budgett: 4\n${STEPS}`).join(), /unknown key "budgett"/)
  assert.match(errorsOf(`steps:\n  - id: a\n    agent: x\n    output: change\n    fanout: 2`).join(), /step "a": unknown key "fanout"/)
  assert.match(errorsOf(`budget: lots\n${STEPS}`).join(), /budget must be/)
  assert.match(errorsOf(`budget: 900\n${STEPS}`).join(), /at most 500/)
  assert.match(errorsOf(`lead: { model: opus, effort: huge }\n${STEPS}`).join(), /lead effort must be/)
  assert.match(errorsOf('label: x').join(), /at least one step/)
  assert.match(errorsOf(`steps:\n  - id: Build\n    agent: x\n    output: change`).join(), /id must be/)
  assert.match(errorsOf(`steps:\n  - id: a\n    agent: x\n    output: code`).join(), /output must be one of/)
  assert.match(errorsOf(`steps:\n  - id: a\n    agent: x`).join(), /needs an output/)
  assert.deepEqual(parseRecipe('t', 'no frontmatter').errors, ['the file needs a --- frontmatter block'])
})

test('one writer per checkout: one change step, never fanned out', () => {
  assert.match(
    errorsOf(`steps:\n  - id: a\n    agent: x\n    output: change\n  - id: b\n    agent: y\n    output: change`).join(),
    /only one step may change files/,
  )
  assert.match(errorsOf(`steps:\n  - id: a\n    agent: x\n    output: change\n    fan-out: { by: file, max: 3 }`).join(), /can't fan out/)
})

test('fan-out is capped and the lead never fans out', () => {
  assert.match(errorsOf(`steps:\n  - id: a\n    agent: x\n    output: findings\n    fan-out: { by: area, max: 20 }`).join(), /max must be a whole number from 2 to 6/)
  assert.match(errorsOf(`steps:\n  - id: a\n    agent: x\n    output: findings\n    fan-out: { max: 2 }`).join(), /needs "by"/)
  assert.match(errorsOf(`steps:\n  - id: a\n    agent: lead\n    output: notes\n    fan-out: { by: q, max: 2 }`).join(), /the lead can't fan out/)
})

test('on-fail goes back to the earlier change step, only from a verdict or checks', () => {
  const base = `steps:\n  - id: build\n    agent: x\n    output: change\n  - id: notes\n    agent: y\n    output: notes`
  assert.match(errorsOf(`${base}\n  - id: v\n    agent: z\n    output: findings\n    on-fail: { back-to: build, max: 1 }`).join(), /only a verdict or checks step/)
  assert.match(errorsOf(`${base}\n  - id: v\n    agent: z\n    output: verdict\n    on-fail: { back-to: notes, max: 1 }`).join(), /the step that changes files/)
  assert.match(errorsOf(`${base}\n  - id: v\n    agent: z\n    output: verdict\n    on-fail: { back-to: later, max: 1 }`).join(), /earlier step/)
  assert.match(errorsOf(`${base}\n  - id: v\n    agent: checks\n    on-fail: { back-to: build, max: 9 }`).join(), /from 1 to 3/)
  assert.deepEqual(errorsOf(`${base}\n  - id: v\n    agent: checks\n    on-fail: { back-to: build, max: 2 }`), [])
})

test('checks steps take no output, model or brief; only the lead reports; no gate on the last step', () => {
  assert.match(errorsOf(`steps:\n  - id: c\n    agent: checks\n    output: verdict`).join(), /a checks step has no output/)
  assert.match(errorsOf(`steps:\n  - id: r\n    agent: writer\n    output: report`).join(), /only the lead writes the report/)
  assert.match(errorsOf(`steps:\n  - id: r\n    agent: lead\n    output: report\n    gate: you`).join(), /last step needs no gate/)
  assert.match(errorsOf(`steps:\n  - id: a\n    agent: x\n    output: notes\n    gate: boss\n  - id: r\n    agent: lead\n    output: report`).join(), /gate can only be "you"/)
})

test('the task loop: contiguous for-each steps, context only on its change step, on-fail never crosses its edge', () => {
  const build = parseRecipe('build', SHIPPED_RECIPES.build).recipe!
  assert.deepEqual(build.steps.map((s) => [s.id, s.forEach]), [['build', 'task'], ['checks', 'task'], ['verify', 'task'], ['final', null], ['report', null]])
  assert.equal(build.steps[0].context, 'fresh')
  const loop = `steps:\n  - id: build\n    agent: x\n    output: change\n    for-each: task`
  assert.match(errorsOf(`${loop}\n  - id: mid\n    agent: y\n    output: notes\n  - id: v\n    agent: z\n    output: verdict\n    for-each: task`).join(), /must sit next to each other/)
  assert.match(errorsOf(`${loop}\n  - id: final\n    agent: z\n    output: verdict\n    on-fail: { back-to: build, max: 1 }`).join(), /can't cross the edge of the task loop/)
  assert.match(errorsOf(`steps:\n  - id: build\n    agent: x\n    output: change\n    context: carry`).join(), /only matters in a for-each/)
  assert.match(errorsOf(`steps:\n  - id: n\n    agent: x\n    output: notes\n    for-each: task\n    context: carry`).join(), /context is for the step that changes files/)
  assert.match(errorsOf(`${loop}\n    context: maybe`).join(), /fresh" or "carry/)
  assert.match(errorsOf(`steps:\n  - id: r\n    agent: lead\n    output: report\n    for-each: task`).join(), /report comes after the task loop/)
  assert.match(errorsOf(`steps:\n  - id: r\n    agent: x\n    output: notes\n    for-each: file`).join(), /for-each can only be "task"/)
})

test('seeding writes the recipes, retires untouched old roster teams, and keeps your edits', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-recipes-'))
  try {
    // A workspace seeded by an older triage: the roster teams and their manifest entries.
    const teams = path.join(dir, 'teams')
    mkdirSync(teams, { recursive: true })
    mkdirSync(path.join(dir, 'agents'), { recursive: true })
    const oldDev = '---\nname: development\nagents: [implementer, reviewer]\n---\nSmall tasks.\n'
    const oldProduct = '---\nname: product\nagents: [researcher]\n---\nEvidence first.\n'
    writeFileSync(path.join(teams, 'development.md'), oldDev)
    writeFileSync(path.join(teams, 'product.md'), oldProduct + 'my edit\n')
    const h = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16)
    writeFileSync(path.join(teams, '.seeded.json'), JSON.stringify({ version: 1, files: { 'teams/development.md': { hash: h(oldDev) }, 'teams/product.md': { hash: h(oldProduct) } } }))

    const lib = new TeamLibrary(dir)
    await lib.seed()
    assert.equal(existsSync(path.join(teams, 'development.md')), false, 'an untouched old team is retired')
    const listed = new Map((await lib.list()).teams.map((r) => [r.name, r]))
    assert.deepEqual([...listed.keys()].sort(), [...Object.keys(SHIPPED_RECIPES), 'product'].sort())
    assert.equal(listed.get('product')!.recipe, null, 'an edited old team stays, held with an error')
    assert.match(listed.get('product')!.errors.join(), /old team format/)
    for (const name of Object.keys(SHIPPED_RECIPES)) {
      const r = listed.get(name)!
      assert.ok(r.recipe && r.status === 'default' && !r.missing.length, name)
    }
    const agents = (await lib.list()).agents
    assert.deepEqual(agents.find((a) => a.name === 'reviewer')!.usedBy.sort(), ['Build', 'Solo'])

    const solo = path.join(teams, 'solo.md')
    writeFileSync(solo, readFileSync(solo, 'utf8').replace('budget: 3', 'budget: 2'))
    writeFileSync(path.join(teams, 'broken.md'), file(`steps:\n  - id: a\n    agent: ghost\n    output: notes\n  - id: b\n    agent: lead\n    output: report\n    gate: nope`))
    writeFileSync(path.join(teams, 'mine.md'), file(`steps:\n  - id: a\n    agent: ghost\n    output: notes`))
    await lib.seed()
    const after = new Map((await lib.list()).teams.map((r) => [r.name, r]))
    assert.equal(after.get('solo')!.recipe!.budgetUsd, 2)
    assert.equal(after.get('solo')!.status, 'edited')
    assert.equal(after.get('broken')!.recipe, null)
    assert.match(after.get('broken')!.errors.join(), /gate can only be "you"/)
    assert.deepEqual(after.get('mine')!.missing, ['ghost'])
    assert.equal(after.get('mine')!.status, 'yours')

    // Save as team writes a new file and never overwrites one.
    await lib.writeRecipe('solo-cheap', { ...after.get('solo')!.recipe!, label: 'Solo cheap' })
    assert.equal((await lib.list()).teams.find((t) => t.name === 'solo-cheap')!.recipe!.label, 'Solo cheap')
    await assert.rejects(lib.writeRecipe('solo', after.get('solo')!.recipe!), /already exists/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
