/**
 * Team recipes (Teams v2): a team is a markdown file whose frontmatter fixes
 * the run's shape — steps, who does each, fan-out, gates, fix loops, budget —
 * and whose body is plain-English advice to the lead. The lead only decides the
 * size (how many workers, which slices, what each brief says) inside that shape;
 * triage runs the steps.
 *
 *   ---
 *   label: Review
 *   use-for: [review-requested]
 *   budget: 4
 *   steps:
 *     - id: review
 *       agent: code-reviewer
 *       fan-out: { by: area, max: 4 }
 *       output: findings
 *     - id: merge
 *       agent: lead
 *       output: report
 *   ---
 *   Advice to the lead.
 *
 * Every run starts with the team card — the lead's plan, which you approve — so
 * a planning step is never written in the file. Pure and browser-safe: the team
 * card editor validates with the same code the server runs.
 */

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

/**
 * What a step hands on. `change` edits the checkout (one writer per checkout);
 * the rest are read-only. A `verdict` or a `checks` step can send the work back
 * to the `change` step.
 */
export type StepOutput = 'change' | 'findings' | 'verdict' | 'notes' | 'report'
export const STEP_OUTPUTS: StepOutput[] = ['change', 'findings', 'verdict', 'notes', 'report']

/** The two agents that are not files: the session's own agent, and triage's free typecheck/lint/test. */
export const LEAD = 'lead'
export const CHECKS = 'checks'

export type RecipeStep = {
  id: string
  /** `lead`, `checks`, or an agent file's name */
  agent: string
  /** null only for a `checks` step */
  output: StepOutput | null
  /** what the step's agent is told to do, on top of its own prompt */
  does: string
  /**
   * N copies of the agent in parallel, each on one slice. The lead picks the
   * slices (up to `max`); `by: finding` splits the previous step's findings
   * itself. The same `by` as the step before reuses its slices and sessions.
   */
  fanOut: { by: string; max: number } | null
  /** a failed verdict or failed checks go back to this `change` step, at most `max` times */
  onFail: { backTo: string; max: number } | null
  /** `you`: the run waits for your approval after this step */
  gate: 'you' | null
  /** per-step model override, e.g. a cheap model for fan-out workers */
  model: string | null
  /**
   * `task`: this step is part of the per-task loop — the run's contiguous
   * `for-each: task` steps run once for every task on the plan, in order.
   */
  forEach: 'task' | null
  /**
   * The change step in a task loop: `fresh` (default) starts every task in a
   * clean context — the plan and its notes carry what earlier tasks learned;
   * `carry` keeps one context across tasks.
   */
  context: 'fresh' | 'carry' | null
}

export type TeamRecipe = {
  label: string
  description: string
  /** item kinds this team is suggested for in the dispatch picker */
  useFor: string[]
  /** spend ceiling for one run, USD — reaching it pauses the run */
  budgetUsd: number
  lead: { model: string | null; effort: Effort | null }
  /** when the run counts as finished, in words — shown on the team card and judged in the report */
  done: string
  steps: RecipeStep[]
  /** the file's body: advice to the lead on sizing and briefing */
  advice: string
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const MAX_STEPS = 8
/** Widest fan-out a recipe may ask for. Freeform's failure mode is cost (102 agents, $120, 6 min). */
export const MAX_FAN_OUT = 6
export const MAX_FIX_ROUNDS = 3
export const MAX_BUDGET_USD = 500

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

// ---------------------------------------------------------------------------
// A small YAML subset: maps, lists, flow `[a, b]` / `{ a: 1 }`, quoted or bare
// scalars, `#` comments. Values stay strings; the schema converts them.
// ---------------------------------------------------------------------------

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue }

type Line = { n: number; indent: number; text: string }

export class YamlError extends Error {}

const KEY_RE = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/

/** A quote opens a quoted scalar only where a value starts — the apostrophe in `it's` is just text. */
const opensQuote = (s: string, i: number): boolean => i === 0 || /[\s:,[{]/.test(s[i - 1])

/** Drop a trailing ` # comment` that sits outside quotes. */
function stripComment(s: string): string {
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if ((c === '"' || c === "'") && opensQuote(s, i)) quote = c
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd()
  }
  return s
}

export function parseYaml(src: string, firstLine = 1): YamlValue {
  const lines: Line[] = []
  src.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*\t/.test(raw)) throw new YamlError(`line ${i + firstLine}: indent with spaces, not tabs`)
    const text = stripComment(raw.trim())
    if (text) lines.push({ n: i + firstLine, indent: raw.length - raw.trimStart().length, text })
  })
  if (!lines.length) return {}
  const [value, next] = block(lines, 0, lines[0].indent)
  if (next < lines.length) throw new YamlError(`line ${lines[next].n}: unexpected indentation`)
  return value
}

const isItem = (l: Line) => l.text === '-' || l.text.startsWith('- ')

function block(lines: Line[], i: number, indent: number): [YamlValue, number] {
  return isItem(lines[i]) ? list(lines, i, indent) : map(lines, i, indent)
}

function map(lines: Line[], i: number, indent: number): [YamlValue, number] {
  const out: { [key: string]: YamlValue } = {}
  while (i < lines.length && lines[i].indent === indent && !isItem(lines[i])) {
    const l = lines[i]
    const m = KEY_RE.exec(l.text)
    if (!m) throw new YamlError(`line ${l.n}: expected "key: value"`)
    const key = m[1]
    if (key in out) throw new YamlError(`line ${l.n}: "${key}" appears twice`)
    i++
    if (m[2] !== undefined && m[2] !== '') out[key] = inline(m[2], l.n)
    else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isItem(lines[i])))) {
      ;[out[key], i] = block(lines, i, lines[i].indent)
    } else out[key] = ''
  }
  if (i < lines.length && lines[i].indent > indent) throw new YamlError(`line ${lines[i].n}: unexpected indentation`)
  return [out, i]
}

function list(lines: Line[], i: number, indent: number): [YamlValue, number] {
  const out: YamlValue[] = []
  while (i < lines.length && lines[i].indent === indent && isItem(lines[i])) {
    const l = lines[i]
    const content = l.text === '-' ? '' : l.text.slice(2).trimStart()
    if (!content) {
      i++
      if (i < lines.length && lines[i].indent > indent) {
        let v: YamlValue
        ;[v, i] = block(lines, i, lines[i].indent)
        out.push(v)
      } else out.push('')
    } else if (KEY_RE.test(content) && !/^["'[{]/.test(content)) {
      // `- id: build` starts a map whose keys line up with "id".
      const at = indent + (l.text.length - content.length)
      lines[i] = { n: l.n, indent: at, text: content }
      let v: YamlValue
      ;[v, i] = map(lines, i, at)
      out.push(v)
    } else {
      out.push(inline(content, l.n))
      i++
    }
  }
  return [out, i]
}

/** Split a flow collection's inside on top-level commas. */
function splitFlow(inner: string, n: number): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quote) {
      if (c === '\\' && quote === '"') {
        cur += c + (inner[++i] ?? '')
        continue
      }
      if (c === quote) quote = null
    } else if ((c === '"' || c === "'") && opensQuote(inner, i)) quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (quote || depth !== 0) throw new YamlError(`line ${n}: unclosed ${quote ? 'quote' : 'bracket'}`)
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function inline(raw: string, n: number): YamlValue {
  const s = raw.trim()
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError(`line ${n}: unclosed [`)
    return splitFlow(s.slice(1, -1), n).map((p) => inline(p, n))
  }
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new YamlError(`line ${n}: unclosed {`)
    const out: { [key: string]: YamlValue } = {}
    for (const p of splitFlow(s.slice(1, -1), n)) {
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(p)
      if (!m) throw new YamlError(`line ${n}: expected "key: value" in { }`)
      if (m[1] in out) throw new YamlError(`line ${n}: "${m[1]}" appears twice`)
      out[m[1]] = inline(m[2], n)
    }
    return out
  }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n')
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  return s
}

// ---------------------------------------------------------------------------
// File → recipe, strictly: an unknown key or a broken rule is an error, so a
// typo never runs as something else.
// ---------------------------------------------------------------------------

export type ParsedRecipe = { recipe: TeamRecipe; errors: [] } | { recipe: null; errors: string[] }

/** Does this team file use the recipe format (vs. a V1/V2 roster file)? */
export const isRecipeFile = (text: string): boolean => /^---\r?\n[\s\S]*?^steps:/m.test(text)

function splitFile(text: string): { yaml: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  return m ? { yaml: m[1], body: text.slice(m[0].length) } : null
}

const TOP_KEYS = new Set(['name', 'label', 'description', 'use-for', 'budget', 'lead', 'done', 'steps', 'source'])
const STEP_KEYS = new Set(['id', 'agent', 'output', 'does', 'fan-out', 'on-fail', 'gate', 'model', 'for-each', 'context'])

const isMap = (v: YamlValue | undefined): v is { [key: string]: YamlValue } => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: YamlValue | undefined): string => (typeof v === 'string' ? v.trim() : '')
const titleCase = (slug: string) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())

function int(v: YamlValue | undefined, min: number, max: number, what: string, errors: string[]): number {
  const n = Number(text(v))
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${what} must be a whole number from ${min} to ${max}`)
    return min
  }
  return n
}

export function parseRecipe(name: string, file: string): ParsedRecipe {
  const errors: string[] = []
  const parts = splitFile(file)
  if (!parts) return { recipe: null, errors: ['the file needs a --- frontmatter block'] }
  let data: YamlValue
  try {
    data = parseYaml(parts.yaml, 2)
  } catch (err) {
    return { recipe: null, errors: [err instanceof Error ? err.message : String(err)] }
  }
  if (!isMap(data)) return { recipe: null, errors: ['the frontmatter must be "key: value" lines'] }
  for (const k of Object.keys(data)) if (!TOP_KEYS.has(k)) errors.push(`unknown key "${k}"`)

  const useForRaw = data['use-for']
  const useFor = (Array.isArray(useForRaw) ? useForRaw : useForRaw ? [useForRaw] : []).map((v) => text(v as YamlValue))
  for (const k of useFor) if (!SLUG_RE.test(k)) errors.push(`use-for: "${k}" is not an item kind`)

  let budgetUsd = 5
  if (data.budget !== undefined) {
    const n = Number(text(data.budget).replace(/^\$/, ''))
    if (!Number.isFinite(n) || n <= 0 || n > MAX_BUDGET_USD) errors.push(`budget must be a dollar amount above 0 and at most ${MAX_BUDGET_USD}`)
    else budgetUsd = Math.round(n * 100) / 100
  }

  const lead: TeamRecipe['lead'] = { model: null, effort: null }
  if (data.lead !== undefined) {
    if (!isMap(data.lead)) errors.push('lead must be { model: …, effort: … }')
    else {
      for (const k of Object.keys(data.lead)) if (k !== 'model' && k !== 'effort') errors.push(`lead: unknown key "${k}"`)
      lead.model = text(data.lead.model) || null
      const effort = text(data.lead.effort)
      if (effort && !EFFORTS.includes(effort as Effort)) errors.push(`lead effort must be one of ${EFFORTS.join(', ')}`)
      else lead.effort = (effort as Effort) || null
    }
  }

  const steps: RecipeStep[] = []
  const rawSteps = data.steps
  if (!Array.isArray(rawSteps) || !rawSteps.length) errors.push('steps must list at least one step')
  else if (rawSteps.length > MAX_STEPS) errors.push(`a team has at most ${MAX_STEPS} steps`)
  else rawSteps.forEach((raw, i) => steps.push(parseStep(raw, i, errors)))

  checkSteps(steps, errors)
  if (errors.length) return { recipe: null, errors }
  return {
    recipe: {
      label: text(data.label) || titleCase(name),
      description: text(data.description),
      useFor,
      budgetUsd,
      lead,
      done: text(data.done),
      steps,
      advice: parts.body.trim(),
    },
    errors: [],
  }
}

function parseStep(raw: YamlValue, i: number, errors: string[]): RecipeStep {
  const where = `step ${i + 1}`
  const step: RecipeStep = { id: `step-${i + 1}`, agent: '', output: null, does: '', fanOut: null, onFail: null, gate: null, model: null, forEach: null, context: null }
  if (!isMap(raw)) {
    errors.push(`${where} must be a map of keys (id, agent, output, …)`)
    return step
  }
  const id = text(raw.id)
  if (!SLUG_RE.test(id)) errors.push(`${where}: id must be a short lowercase name like "build"`)
  else step.id = id
  const at = SLUG_RE.test(id) ? `step "${id}"` : where
  for (const k of Object.keys(raw)) if (!STEP_KEYS.has(k)) errors.push(`${at}: unknown key "${k}"`)

  step.agent = text(raw.agent)
  if (!SLUG_RE.test(step.agent)) errors.push(`${at}: agent must be lead, checks, or an agent's file name`)

  const output = text(raw.output)
  if (output) {
    if (!STEP_OUTPUTS.includes(output as StepOutput)) errors.push(`${at}: output must be one of ${STEP_OUTPUTS.join(', ')}`)
    else step.output = output as StepOutput
  }
  step.does = text(raw.does)
  step.model = text(raw.model) || null

  const fan = raw['fan-out']
  if (fan !== undefined) {
    if (!isMap(fan)) errors.push(`${at}: fan-out must be { by: …, max: N }`)
    else {
      for (const k of Object.keys(fan)) if (k !== 'by' && k !== 'max') errors.push(`${at}: fan-out: unknown key "${k}"`)
      const by = text(fan.by)
      if (!SLUG_RE.test(by)) errors.push(`${at}: fan-out needs "by" — what one worker gets, e.g. area, question, finding`)
      step.fanOut = { by, max: int(fan.max, 2, MAX_FAN_OUT, `${at}: fan-out max`, errors) }
    }
  }

  const fail = raw['on-fail']
  if (fail !== undefined) {
    if (!isMap(fail)) errors.push(`${at}: on-fail must be { back-to: <step>, max: N }`)
    else {
      for (const k of Object.keys(fail)) if (k !== 'back-to' && k !== 'max') errors.push(`${at}: on-fail: unknown key "${k}"`)
      step.onFail = { backTo: text(fail['back-to']), max: int(fail.max, 1, MAX_FIX_ROUNDS, `${at}: on-fail max`, errors) }
    }
  }

  const gate = text(raw.gate)
  if (gate) {
    if (gate !== 'you') errors.push(`${at}: gate can only be "you"`)
    else step.gate = 'you'
  }
  const each = text(raw['for-each'])
  if (each) {
    if (each !== 'task') errors.push(`${at}: for-each can only be "task"`)
    else step.forEach = 'task'
  }
  const context = text(raw.context)
  if (context) {
    if (context !== 'fresh' && context !== 'carry') errors.push(`${at}: context must be "fresh" or "carry"`)
    else step.context = context
  }
  return step
}

/** The rules every team obeys, whatever its file says. */
function checkSteps(steps: RecipeStep[], errors: string[]): void {
  const seen = new Set<string>()
  const writers = steps.filter((s) => s.output === 'change')
  if (writers.length > 1) errors.push(`only one step may change files — ${writers.map((s) => `"${s.id}"`).join(' and ')} both do`)
  steps.forEach((s, i) => {
    const at = `step "${s.id}"`
    if (seen.has(s.id)) errors.push(`two steps are called "${s.id}"`)
    seen.add(s.id)
    if (s.agent === CHECKS) {
      if (s.output) errors.push(`${at}: a checks step has no output — it runs the project's typecheck, lint and tests`)
      if (s.fanOut) errors.push(`${at}: a checks step can't fan out`)
      if (s.does) errors.push(`${at}: a checks step takes no "does"`)
      if (s.model) errors.push(`${at}: a checks step uses no model`)
    } else if (!s.output) errors.push(`${at}: needs an output (${STEP_OUTPUTS.join(', ')})`)
    if (s.agent === LEAD && s.fanOut) errors.push(`${at}: the lead can't fan out — give the step an agent`)
    if (s.output === 'report' && s.agent !== LEAD) errors.push(`${at}: only the lead writes the report`)
    if (s.output === 'change' && s.fanOut) errors.push(`${at}: one writer per checkout — a change step can't fan out`)
    if (s.onFail) {
      if (s.agent !== CHECKS && s.output !== 'verdict') errors.push(`${at}: only a verdict or checks step can send work back`)
      const target = steps.findIndex((t) => t.id === s.onFail!.backTo)
      if (target === -1 || target >= i) errors.push(`${at}: on-fail must go back to an earlier step`)
      else if (steps[target].output !== 'change') errors.push(`${at}: on-fail must go back to the step that changes files`)
    }
    if (s.gate && i === steps.length - 1) errors.push(`${at}: the last step needs no gate — the run ends there`)
    if (s.context && s.output !== 'change') errors.push(`${at}: context is for the step that changes files`)
    if (s.context && !s.forEach) errors.push(`${at}: context only matters in a for-each: task loop`)
    if (s.forEach) {
      if (s.fanOut) errors.push(`${at}: a step in the task loop can't also fan out`)
      if (s.output === 'report') errors.push(`${at}: the report comes after the task loop, not in it`)
    }
    if (s.onFail) {
      const target = steps.find((t) => t.id === s.onFail!.backTo)
      if (target && !!target.forEach !== !!s.forEach) errors.push(`${at}: on-fail can't cross the edge of the task loop`)
    }
  })
  const loop = steps.map((s, i) => (s.forEach ? i : -1)).filter((i) => i >= 0)
  if (loop.length && loop[loop.length - 1] - loop[0] !== loop.length - 1) errors.push('the for-each: task steps must sit next to each other')
}

/** The task loop's first and last step index, or null when the recipe has none. */
export function taskLoop(r: { steps: RecipeStep[] }): { from: number; to: number } | null {
  const loop = r.steps.map((s, i) => (s.forEach ? i : -1)).filter((i) => i >= 0)
  return loop.length ? { from: loop[0], to: loop[loop.length - 1] } : null
}

// ---------------------------------------------------------------------------
// Recipe → file, in the shipped style (Save as team writes this)
// ---------------------------------------------------------------------------

const BARE_RE = /^[A-Za-z0-9][\w .,/()$+-]*$/
const q = (s: string): string => (BARE_RE.test(s) && !/:\s|\s#|[\s,]$/.test(s) ? s : JSON.stringify(s))

export function serializeRecipe(r: TeamRecipe, source: string): string {
  const out = ['---', `label: ${q(r.label)}`]
  if (r.description) out.push(`description: ${q(r.description)}`)
  if (r.useFor.length) out.push(`use-for: [${r.useFor.join(', ')}]`)
  out.push(`budget: ${r.budgetUsd}`)
  const lead = [r.lead.model && `model: ${q(r.lead.model)}`, r.lead.effort && `effort: ${r.lead.effort}`].filter(Boolean)
  if (lead.length) out.push(`lead: { ${lead.join(', ')} }`)
  if (r.done) out.push(`done: ${q(r.done)}`)
  out.push('steps:')
  for (const s of r.steps) {
    out.push(`  - id: ${s.id}`, `    agent: ${s.agent}`)
    if (s.output) out.push(`    output: ${s.output}`)
    if (s.fanOut) out.push(`    fan-out: { by: ${s.fanOut.by}, max: ${s.fanOut.max} }`)
    if (s.onFail) out.push(`    on-fail: { back-to: ${s.onFail.backTo}, max: ${s.onFail.max} }`)
    if (s.gate) out.push(`    gate: ${s.gate}`)
    if (s.model) out.push(`    model: ${q(s.model)}`)
    if (s.forEach) out.push(`    for-each: ${s.forEach}`)
    if (s.context) out.push(`    context: ${s.context}`)
    if (s.does) out.push(`    does: ${q(s.does)}`)
  }
  out.push(`source: ${source}`, '---', '')
  return out.join('\n') + (r.advice.trim() ? `${r.advice.trim()}\n` : '')
}

/** The agent files a recipe needs, besides `lead` and `checks`. */
export const recipeAgents = (r: TeamRecipe): string[] => [...new Set(r.steps.map((s) => s.agent).filter((a) => a !== LEAD && a !== CHECKS))]

/** Does the lead need edit tools? Only when it owns the change step (Solo). */
export const leadWrites = (r: TeamRecipe): boolean => r.steps.some((s) => s.agent === LEAD && s.output === 'change')
