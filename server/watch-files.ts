/**
 * Watches as files: one markdown file per watch in the workspace folder, like
 * agents and teams.
 *
 *   <workspace>/watches/<slug>.md          frontmatter = what the code enforces,
 *                                          body = the instruction
 *   <workspace>/watches/.seeded.json       what triage wrote, so edits are never clobbered
 *
 * The schema is strict: an unknown key is an error, never ignored, so a typo
 * can't silently drop a limit. A file that doesn't validate never crashes
 * anything — its watch is held with a visible config error. The `id` is the
 * watch's stable identity: SQLite keeps only state (the slot ledger, the
 * failure streak, config errors) on a row with that id.
 *
 * Tools are one entry per grant line: a built-in (`web`, `github`,
 * `files-write`) or `<server>/<tool>` for an MCP tool, the server as Claude
 * Code names it ("claude.ai Slack/slack_search_public").
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isValidCron } from '../core/watch/cron.js'
import { isCatchUpSpec, parseDuration } from '../core/watch/schedule.js'
import {
  BUILTIN_TOOLS,
  RESERVED_SERVER,
  builtinGrant,
  grantKey,
  leafOf,
  mcpToolName,
  serverLabel,
  type BuiltinToolId,
  type ConnectorScope,
  type WatchToolGrant,
} from '../core/watch/tools.js'
import { WATCH_NOTIFY, type WatchNotify, type WatchOutput } from '../core/watch/types.js'
import { parseFrontmatter, serializeFrontmatter, type FrontmatterValue } from './artifacts.js'
import { slugify } from './teams.js'

/** Everything a watch file says. */
export type WatchFileSpec = {
  id: string
  title: string
  schedule: string
  /** project id; '' = none picked yet */
  project: string
  tools: WatchToolGrant[]
  model?: string
  output: WatchOutput
  catchUp?: string
  timeoutMs?: number
  budgetUsd?: number
  dailyBudgetUsd?: number
  notify: WatchNotify
  enabled: boolean
  instruction: string
}

export const WATCH_FILE_KEYS = [
  'id', 'title', 'schedule', 'project', 'tools', 'model', 'output', 'catch_up',
  'timeout', 'budget_usd', 'daily_budget_usd', 'notify', 'enabled',
] as const

const KEYS = new Set<string>(WATCH_FILE_KEYS)
const BUILTINS = Object.keys(BUILTIN_TOOLS) as BuiltinToolId[]
const OUTPUTS: WatchOutput[] = ['items', 'digest']
const MIN_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 3_600_000

export type ParsedWatchFile = {
  /** best effort, defaults filled in — usable even when `errors` is not empty */
  spec: WatchFileSpec
  errors: string[]
  /** false when the file carries no id (a fresh id was minted into `spec.id`) */
  hadId: boolean
}

const titleCase = (slug: string) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
const str = (v: FrontmatterValue | undefined): string => (typeof v === 'string' ? v.trim() : '')

/** Dollars from a string, or an error. */
function dollars(key: string, v: string, max: number, errors: string[]): number | undefined {
  if (!v) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    errors.push(`${key} must be dollars from 0.01 to ${max}`)
    return undefined
  }
  return n
}

/** Tool lines → grants: built-ins by id, MCP tools grouped by server. */
export function grantsFromLines(lines: string[], errors: string[]): WatchToolGrant[] {
  const out: WatchToolGrant[] = []
  const mcp = new Map<string, Set<string>>()
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (BUILTINS.includes(line as BuiltinToolId)) {
      if (!out.some((g) => grantKey(g.source) === `builtin:${line}`)) out.push(builtinGrant(line as BuiltinToolId))
      continue
    }
    const slash = line.lastIndexOf('/')
    if (slash <= 0 || slash === line.length - 1) {
      errors.push(`tools: "${line}" is neither a built-in (${BUILTINS.join(', ')}) nor <server>/<tool>`)
      continue
    }
    const server = line.slice(0, slash).trim()
    if (server === RESERVED_SERVER) {
      errors.push(`tools: "${RESERVED_SERVER}" is the run's own server; its write tool comes with every watch`)
      continue
    }
    if (!mcp.has(server)) mcp.set(server, new Set())
    mcp.get(server)!.add(mcpToolName(server, line.slice(slash + 1).trim()))
  }
  for (const [server, tools] of mcp) out.push({ source: { kind: 'mcp', server, scope: 'unknown' }, tools: [...tools] })
  return out
}

/** Grants → tool lines, the inverse of grantsFromLines. */
export function linesFromGrants(grants: WatchToolGrant[]): string[] {
  return grants.flatMap((g) => (g.source.kind === 'builtin' ? [g.source.id] : g.tools.map((t) => `${(g.source as { server: string }).server}/${leafOf(t)}`)))
}

/** A watch file → its spec, plus every reason it can't run as written. Pure. */
export function parseWatchFile(name: string, text: string): ParsedWatchFile {
  const fm = parseFrontmatter(text)
  const errors: string[] = []
  if (!fm.present) errors.push('no frontmatter — the file must start with a --- block')
  else if (!fm.ok) errors.push('frontmatter has a line that is not "key: value"')
  const d = fm.data
  for (const k of Object.keys(d)) if (!KEYS.has(k)) errors.push(`unknown key "${k}" — allowed: ${WATCH_FILE_KEYS.join(', ')}`)

  const id = str(d.id)
  const schedule = str(d.schedule)
  if (!schedule) errors.push('schedule is required (a cron line, e.g. "0 9 * * 1-5")')
  else if (!isValidCron(schedule)) errors.push(`schedule "${schedule}" is not a valid cron line`)

  const toolLines = Array.isArray(d.tools) ? d.tools : str(d.tools) ? [str(d.tools)] : []
  const tools = grantsFromLines(toolLines, errors)
  if (!tools.length) errors.push('tools must list at least one integration')

  const output = (str(d.output) || 'items') as WatchOutput
  if (!OUTPUTS.includes(output)) errors.push(`output must be one of: ${OUTPUTS.join(', ')}`)

  const catchUp = str(d.catch_up)
  if (catchUp && !isCatchUpSpec(catchUp)) errors.push('catch_up must be "never", "unlimited", or a duration like "6h"')

  const timeout = str(d.timeout)
  const timeoutMs = timeout ? parseDuration(timeout) : null
  if (timeout && (timeoutMs == null || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS)) {
    errors.push('timeout must be minutes from 1m to 60m (or 1h)')
  }

  const budgetUsd = dollars('budget_usd', str(d.budget_usd), 100, errors)
  const dailyBudgetUsd = dollars('daily_budget_usd', str(d.daily_budget_usd), 1000, errors)

  const notify = (str(d.notify) || 'on_failure') as WatchNotify
  if (!WATCH_NOTIFY.includes(notify)) errors.push(`notify must be one of: ${WATCH_NOTIFY.join(', ')}`)

  const enabledRaw = str(d.enabled) || 'true'
  if (enabledRaw !== 'true' && enabledRaw !== 'false') errors.push('enabled must be true or false')

  const instruction = fm.body.trim()
  if (!instruction) errors.push('the instruction (the body under the frontmatter) is empty')

  const spec: WatchFileSpec = {
    id: id || randomUUID(),
    title: str(d.title) || titleCase(name),
    schedule: schedule || '0 9 * * *',
    project: str(d.project),
    tools,
    ...(str(d.model) ? { model: str(d.model) } : {}),
    output: OUTPUTS.includes(output) ? output : 'items',
    ...(catchUp && isCatchUpSpec(catchUp) ? { catchUp } : {}),
    ...(timeoutMs != null && timeoutMs >= MIN_TIMEOUT_MS && timeoutMs <= MAX_TIMEOUT_MS ? { timeoutMs } : {}),
    ...(budgetUsd != null ? { budgetUsd } : {}),
    ...(dailyBudgetUsd != null ? { dailyBudgetUsd } : {}),
    notify: WATCH_NOTIFY.includes(notify) ? notify : 'on_failure',
    enabled: enabledRaw !== 'false',
    instruction,
  }
  return { spec, errors, hadId: Boolean(id) }
}

const fmtTimeout = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`)

/** A spec → the file's text. Optional keys are written only when set. */
export function serializeWatchFile(s: WatchFileSpec): string {
  const data: Record<string, FrontmatterValue> = {
    id: s.id,
    title: s.title,
    schedule: s.schedule,
    project: s.project,
    tools: linesFromGrants(s.tools),
  }
  if (s.model) data.model = s.model
  data.output = s.output
  if (s.catchUp) data.catch_up = s.catchUp
  if (s.timeoutMs != null) data.timeout = fmtTimeout(s.timeoutMs)
  if (s.budgetUsd != null) data.budget_usd = String(s.budgetUsd)
  if (s.dailyBudgetUsd != null) data.daily_budget_usd = String(s.dailyBudgetUsd)
  data.notify = s.notify
  data.enabled = String(s.enabled)
  return serializeFrontmatter(data, `\n${s.instruction.trim()}\n`)
}

/**
 * Check a spec's MCP grants against what the connector probes found: every
 * server must be known and every tool one it offers. Fills in each grant's
 * scope from the probe. No probe yet → benefit of the doubt (the run fails
 * loudly if a tool truly isn't there). Pure.
 */
export function checkGrants(
  tools: WatchToolGrant[],
  connectors: { server: string; scope: ConnectorScope; tools: { fullName: string }[] }[] | null,
): { tools: WatchToolGrant[]; errors: string[] } {
  if (!connectors) return { tools, errors: [] }
  const errors: string[] = []
  const out = tools.map((g) => {
    if (g.source.kind !== 'mcp') return g
    const server = g.source.server
    const found = connectors.find((c) => c.server === server)
    if (!found) {
      errors.push(`tools: no connected server named "${server}"`)
      return g
    }
    // a server that isn't connected right now lists no tools; watchReady holds the run instead
    if (found.tools.length) {
      const offered = new Set(found.tools.map((t) => t.fullName))
      for (const t of g.tools) if (!offered.has(t)) errors.push(`tools: ${serverLabel(server)} has no tool "${leafOf(t)}"`)
    }
    return { ...g, source: { ...g.source, scope: found.scope } }
  })
  return { tools: out, errors }
}

/**
 * Set one frontmatter key in a file's text, touching no other line: replace
 * the key's line if there is one, else add it first or last in the block. A
 * text with no frontmatter gets one. Pure.
 */
export function withKey(text: string, key: string, value: string, where: 'first' | 'last'): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return ['---', `${key}: ${value}`, '---', text].join(nl)
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  const re = new RegExp(`^${key}\\s*:`)
  const at = lines.findIndex((l, i) => i > 0 && (end === -1 || i < end) && re.test(l))
  if (at !== -1) lines[at] = `${key}: ${value}`
  else lines.splice(where === 'first' || end === -1 ? 1 : end, 0, `${key}: ${value}`)
  return lines.join(nl)
}

/**
 * The text a new watch starts from in the editor: every key, the optional
 * ones commented out, with the user's own projects to pick from. Pure.
 */
export function starterWatchFile(projects: { id: string; name: string }[]): string {
  const first = projects[0]
  return [
    '---',
    'title: New watch',
    '# cron, local time: minute hour day-of-month month weekday',
    'schedule: 0 9 * * 1-5',
    '# the project folder the run works in — its id, from the list on the right',
    `project: ${first ? first.id : ''}`,
    '# built-ins: web, github, files-write · an MCP tool: <server>/<tool>',
    'tools: [web]',
    '# items (one work item per match) or digest (one report per run)',
    'output: items',
    '# never, on_failure or always — a macOS notification',
    'notify: on_failure',
    'enabled: true',
    '# optional:',
    '# model: sonnet',
    '# catch_up: 6h            (never, unlimited, or a duration like 30m, 6h, 2d)',
    '# timeout: 4m',
    '# budget_usd: 2           (per run)',
    '# daily_budget_usd: 5     (across a day of runs)',
    '---',
    '',
    'What to look for, where, and what counts as a match.',
    '',
  ].join('\n')
}

/** What triage wrote, per file — the difference between "untouched" and "yours". */
type Manifest = { version: 1; files: Record<string, { hash: string | null; removed?: boolean }> }

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export type WatchFile = { name: string; path: string; mtimeMs: number; text: string }

export class WatchFiles {
  readonly dir: string
  private readonly manifestPath: string

  constructor(root: string) {
    this.dir = path.join(root, 'watches')
    this.manifestPath = path.join(this.dir, '.seeded.json')
  }

  /** Every `<slug>.md` in the folder, read whole (they are small). */
  async scan(): Promise<WatchFile[]> {
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const out: WatchFile[] = []
    for (const f of names.sort()) {
      if (!f.endsWith('.md') || f.startsWith('.')) continue
      const file = path.join(this.dir, f)
      try {
        const st = await stat(file)
        if (!st.isFile()) continue
        out.push({ name: f.slice(0, -3), path: file, mtimeMs: st.mtimeMs, text: await readFile(file, 'utf8') })
      } catch {}
    }
    return out
  }

  pathOf(name: string): string {
    return path.join(this.dir, `${name}.md`)
  }

  async write(name: string, spec: WatchFileSpec): Promise<void> {
    await atomicWrite(this.pathOf(name), serializeWatchFile(spec))
  }

  /**
   * Put `id: <id>` into a file's frontmatter, replacing any id it has, and
   * touching nothing else — the file stays the user's.
   */
  async stampId(name: string, id: string): Promise<void> {
    const file = this.pathOf(name)
    await atomicWrite(file, withKey(await readFile(file, 'utf8'), 'id', id, 'first'))
  }

  /** Turn a watch on or off by its `enabled:` line alone — comments and layout stay. */
  async setEnabled(name: string, on: boolean): Promise<void> {
    const file = this.pathOf(name)
    await atomicWrite(file, withKey(await readFile(file, 'utf8'), 'enabled', String(on), 'last'))
  }

  /** Write a file exactly as given (the editor's text, already validated). */
  async writeText(name: string, text: string): Promise<void> {
    await atomicWrite(this.pathOf(name), text.endsWith('\n') ? text : `${text}\n`)
  }

  async remove(name: string): Promise<void> {
    await rm(this.pathOf(name), { force: true })
    const m = await this.manifest()
    const rel = `${name}.md`
    if (m.files[rel]?.hash) {
      m.files[rel].removed = true
      await this.saveManifest(m)
    }
  }

  /** A file name for a new watch: the title's slug, suffixed until nothing holds it. */
  freeName(title: string): string {
    const base = slugify(title) || 'watch'
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base.slice(0, 44)}-${n}`
      if (!existsSync(this.pathOf(name))) return name
    }
  }

  private async manifest(): Promise<Manifest> {
    try {
      const m = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest
      if (m && m.version === 1 && m.files) return m
    } catch {}
    return { version: 1, files: {} }
  }

  private async saveManifest(m: Manifest): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8')
  }

  /**
   * Bring the shipped templates in, as the teams library does: one not yet
   * seen is written; one the user never touched follows a newer shipped
   * version; an edited one is left alone; a deleted one stays deleted; a
   * user's own file of the same name wins.
   */
  async seed(templates: Record<string, WatchFileSpec>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const m = await this.manifest()
    let changed = false
    for (const [name, spec] of Object.entries(templates)) {
      const rel = `${name}.md`
      const file = this.pathOf(name)
      const content = serializeWatchFile(spec)
      const entry = m.files[rel]
      const exists = existsSync(file)
      if (!entry) {
        if (exists) m.files[rel] = { hash: null }
        else {
          await atomicWrite(file, content)
          m.files[rel] = { hash: hash(content) }
        }
        changed = true
        continue
      }
      if (entry.hash === null || entry.removed) continue
      if (!exists) {
        entry.removed = true
        changed = true
        continue
      }
      const cur = hash(await readFile(file, 'utf8'))
      if (cur === entry.hash && cur !== hash(content)) {
        await atomicWrite(file, content)
        entry.hash = hash(content)
        changed = true
      }
    }
    if (changed) await this.saveManifest(m)
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}
