/**
 * What a watch run may call (watch-spec.md, items 1 and 2). A watch stores an
 * explicit list of tool grants, resolved to full tool names when the user
 * saves it, so the fence never grows silently. Two kinds of source:
 *
 * - built-ins: Web (Claude Code's own search/fetch), GitHub (read verbs of the
 *   user's `gh`), and an opt-in write grant scoped to the watch's folder;
 * - MCP servers the user has connected anywhere Claude Code looks (claude.ai,
 *   global, local, project, plugins), discovered by the connector probe.
 *
 * Every run also gets its project's read-only code tools, scoped to the
 * project folder by `fenceDecision` (fence.ts) — a PreToolUse check that is
 * the real fence, independent of whatever allow rules the user's settings carry.
 *
 * Pure and browser-safe: shared by server and web.
 */
export type ConnectorScope = 'claudeai' | 'user' | 'local' | 'project' | 'plugin' | 'managed' | 'unknown'

export type BuiltinToolId = 'web' | 'github' | 'files-write'

export type WatchToolSource =
  | { kind: 'builtin'; id: BuiltinToolId }
  | { kind: 'mcp'; server: string; scope: ConnectorScope }

export type WatchToolGrant = {
  source: WatchToolSource
  /** full tool names as the allowlist spells them, resolved at save time */
  tools: string[]
}

/** The in-process server every run gets (its one write tool). A user server by this name is shadowed, so never offered. */
export const RESERVED_SERVER = 'triage'

export const BUILTIN_LABEL: Record<BuiltinToolId, string> = {
  web: 'Web',
  github: 'GitHub',
  'files-write': 'Write files in the project',
}

/** Claude Code's name for an MCP tool: `mcp__<server>__<tool>`, the server name sanitised. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}__${tool}`
}

/** The bare tool name out of a full MCP tool name. */
export function leafOf(fullName: string): string {
  const i = fullName.lastIndexOf('__')
  return i >= 0 ? fullName.slice(i + 2) : fullName
}

/** The display name of a server, without the "claude.ai " prefix the SDK reports. */
export const serverLabel = (server: string): string => server.replace(/^claude\.ai /, '')

// ---------------------------------------------------------------------------
// Built-in grants
// ---------------------------------------------------------------------------

export const WEB_TOOLS = ['WebSearch', 'WebFetch']
export const MAX_WEB_FETCHES = 10

// `gh` read verbs only — no `gh api` (it can mutate), no pr merge/close/comment.
export const GITHUB_TOOLS = [
  'Bash(gh pr list:*)', 'Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr status:*)',
  'Bash(gh issue list:*)', 'Bash(gh issue view:*)', 'Bash(gh issue status:*)',
  'Bash(gh search:*)', 'Bash(gh repo view:*)', 'Bash(gh run list:*)', 'Bash(gh run view:*)',
]

/** Opt-in: the run may write and edit files, inside its project folder only. */
export const FILES_WRITE_TOOLS = ['Write', 'Edit']

/** Every run's read-only code tools. File paths are fenced to the project folder. */
export const PROJECT_TOOLS = [
  'Read', 'Grep', 'Glob',
  'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git blame:*)',
]

export const BUILTIN_TOOLS: Record<BuiltinToolId, string[]> = {
  web: WEB_TOOLS,
  github: GITHUB_TOOLS,
  'files-write': FILES_WRITE_TOOLS,
}

export const builtinGrant = (id: BuiltinToolId): WatchToolGrant => ({ source: { kind: 'builtin', id }, tools: [...BUILTIN_TOOLS[id]] })

// ---------------------------------------------------------------------------
// Curated presets for MCP servers — they win over the server's own read-only
// annotations, because some servers don't annotate.
// ---------------------------------------------------------------------------

const SLACK_READ = [
  'slack_search_public_and_private', 'slack_search_channels', 'slack_read_thread',
  'slack_read_channel', 'slack_read_user_profile', 'slack_search_users',
]
const LINEAR_READ = [
  'list_issues', 'get_issue', 'list_my_issues', 'list_comments',
  'list_teams', 'get_team', 'list_projects', 'get_project', 'list_cycles',
  'list_users', 'get_user', 'list_issue_labels', 'list_issue_statuses', 'get_issue_status',
  'list_documents', 'get_document', 'search_documentation',
]

export const MCP_PRESETS: Record<string, string[]> = {
  'claude.ai Slack': SLACK_READ,
  'claude.ai Linear': LINEAR_READ,
}

export const presetGrant = (server: string): WatchToolGrant | null =>
  MCP_PRESETS[server]
    ? { source: { kind: 'mcp', server, scope: 'claudeai' }, tools: MCP_PRESETS[server].map((t) => mcpToolName(server, t)) }
    : null

/** What a probed server's tool looks like to the picker. */
export type ProbedTool = { name: string; fullName: string; readOnly?: boolean; destructive?: boolean }

const READ_NAME = /(^|[_-])(list|get|search|read|fetch|query|find|view|lookup|describe|show)([_-]|$)/i
const WRITE_NAME = /(^|[_-])(create|update|delete|remove|send|post|add|set|write|upload|move|duplicate|convert|spawn|stop|edit|merge|close|archive|schedule|assign|comment)([_-]|$)/i

/** The name suggests a read (and no write verb). A hint only — never a pre-check. */
export const looksReadOnly = (name: string): boolean => READ_NAME.test(name) && !WRITE_NAME.test(name)

/**
 * The tools pre-checked when a server is selected: its curated preset, else
 * every tool the server marks read-only, else nothing.
 */
export function defaultToolsFor(server: string, tools: ProbedTool[]): string[] {
  const preset = MCP_PRESETS[server]
  if (preset) {
    const have = new Set(tools.map((t) => t.name))
    // A preset lists what we trust; keep only what this server actually offers
    // (when the probe reported tools at all).
    const names = tools.length ? preset.filter((t) => have.has(t)) : preset
    return names.map((t) => mcpToolName(server, t))
  }
  return tools.filter((t) => t.readOnly === true && t.destructive !== true).map((t) => t.fullName)
}

// ---------------------------------------------------------------------------
// Legacy connectors → grants (watches saved before grants existed)
// ---------------------------------------------------------------------------

export type LegacyConnector = 'slack' | 'linear' | 'github' | 'web'

export function grantsFromLegacy(connectors: LegacyConnector[]): WatchToolGrant[] {
  const out: WatchToolGrant[] = []
  for (const c of connectors) {
    if (c === 'web' || c === 'github') out.push(builtinGrant(c))
    else if (c === 'slack') out.push(presetGrant('claude.ai Slack')!)
    else if (c === 'linear') out.push(presetGrant('claude.ai Linear')!)
  }
  return out
}

/** Validate grants off the wire. Rejects, never repairs. */
export function grantsFrom(raw: unknown): { grants: WatchToolGrant[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'tools must be a non-empty list of grants' }
  const out: WatchToolGrant[] = []
  const seen = new Set<string>()
  for (const g of raw) {
    if (typeof g !== 'object' || g === null) return { error: 'each grant must be an object' }
    const r = g as Record<string, unknown>
    const s = r.source as Record<string, unknown> | undefined
    if (!s || typeof s !== 'object') return { error: 'each grant needs a source' }
    if (!Array.isArray(r.tools) || !r.tools.every((t) => typeof t === 'string' && t.length > 0 && t.length < 300)) {
      return { error: 'grant tools must be a list of tool names' }
    }
    let source: WatchToolSource
    if (s.kind === 'builtin') {
      if (s.id !== 'web' && s.id !== 'github' && s.id !== 'files-write') return { error: `unknown built-in "${String(s.id)}"` }
      source = { kind: 'builtin', id: s.id }
      // A built-in grant is exactly its fixed list — never whatever the client sent.
      out.push({ source, tools: [...BUILTIN_TOOLS[s.id]] })
    } else if (s.kind === 'mcp') {
      if (typeof s.server !== 'string' || !s.server.trim()) return { error: 'an MCP grant needs a server name' }
      const server = s.server
      if (server === RESERVED_SERVER) return { error: `"${RESERVED_SERVER}" is the run's own server; its write tool comes with every watch` }
      const prefix = mcpToolName(server, '')
      const tools = [...new Set(r.tools as string[])]
      if (tools.length === 0) return { error: `pick at least one tool from ${serverLabel(server)}` }
      if (!tools.every((t) => t.startsWith(prefix))) return { error: `grant for ${serverLabel(server)} lists a tool from another server` }
      const scope = typeof s.scope === 'string' ? (s.scope as ConnectorScope) : 'unknown'
      source = { kind: 'mcp', server, scope }
      out.push({ source, tools })
    } else {
      return { error: 'grant source kind must be builtin or mcp' }
    }
    const key = grantKey(source)
    if (seen.has(key)) return { error: `duplicate grant for ${key}` }
    seen.add(key)
  }
  return { grants: out }
}

export const grantKey = (s: WatchToolSource): string => (s.kind === 'builtin' ? `builtin:${s.id}` : `mcp:${s.server}`)

export const grantLabel = (g: WatchToolGrant): string =>
  g.source.kind === 'builtin' ? BUILTIN_LABEL[g.source.id] : serverLabel(g.source.server)

export const hasBuiltin = (grants: WatchToolGrant[], id: BuiltinToolId): boolean =>
  grants.some((g) => g.source.kind === 'builtin' && g.source.id === id)

export const mcpGrants = (grants: WatchToolGrant[]) =>
  grants.filter((g): g is WatchToolGrant & { source: Extract<WatchToolSource, { kind: 'mcp' }> } => g.source.kind === 'mcp')

// ---------------------------------------------------------------------------
// Composition: what the SDK is handed
// ---------------------------------------------------------------------------

export type RunOutput = 'items' | 'digest'

export const triageWriteTool = (output: RunOutput): string =>
  output === 'digest' ? 'mcp__triage__write_digest' : 'mcp__triage__upsert_work_item'

/** The exact tools a run may call: its grants, the project's read tools, and its one triage write tool. */
export function runAllowedTools(grants: WatchToolGrant[], output: RunOutput = 'items'): string[] {
  const tools = new Set<string>(['ToolSearch', triageWriteTool(output), ...PROJECT_TOOLS])
  for (const g of grants) for (const t of g.tools) tools.add(t)
  return [...tools]
}

/**
 * The base set of Claude Code built-in tools the run process gets (the SDK's
 * `tools` option). Anything not listed doesn't exist for the run, whatever
 * the user's own allow rules say.
 */
export function runBaseTools(grants: WatchToolGrant[]): string[] {
  const base = new Set(['ToolSearch', 'Read', 'Grep', 'Glob', 'Bash'])
  if (hasBuiltin(grants, 'web')) for (const t of WEB_TOOLS) base.add(t)
  if (hasBuiltin(grants, 'files-write')) for (const t of FILES_WRITE_TOOLS) base.add(t)
  return [...base]
}

/**
 * Tools the run must load with ToolSearch before calling. Connector MCP tools
 * are always deferred; so are Claude Code's own web tools in many setups.
 */
export function runDeferredTools(grants: WatchToolGrant[]): string[] {
  const out: string[] = []
  for (const g of grants) {
    if (g.source.kind === 'mcp') out.push(...g.tools)
    else if (g.source.id === 'web') out.push(...WEB_TOOLS)
  }
  return out
}
