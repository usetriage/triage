/**
 * Teams on the client (.docs/teams.md): the library fetch, the draft the team
 * editor holds, and the same roster rules the server enforces — checked here
 * first so Start work can say why it is disabled.
 */
import {
  AGENT_COLORS,
  MAX_TEAM_AGENTS,
  type AgentCan,
  type AgentColor,
  type AgentEntry,
  type DraftAgent,
  type ManagerSpec,
  type SessionSummary,
  type TeamEntry,
  type TeamLibraryResponse,
} from '../../shared/protocol.js'

export type TeamLibrary = { teams: TeamEntry[]; agents: AgentEntry[]; dir: string }

export async function loadTeamLibrary(): Promise<TeamLibrary> {
  const b = (await (await fetch('/api/teams/library')).json()) as TeamLibraryResponse
  if (!b.ok) throw new Error(b.error)
  return { teams: b.teams, agents: b.agents, dir: b.dir }
}

/** POST/PUT/DELETE a /api/teams route; the library comes back on success. */
export async function teamsCall<T = TeamLibraryResponse>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/teams/${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const b = (await res.json()) as { ok: boolean; error?: string }
  if (!b.ok) throw new Error(b.error ?? 'request failed')
  return b as T
}

/** A team session's members in roster order, read off the session list. */
export function teamMembers(sessions: readonly SessionSummary[], teamId: string): SessionSummary[] {
  return sessions.filter((s) => s.team?.id === teamId).sort((a, b) => a.team!.order - b.team!.order)
}

/** Claude Code's agent colours, drawn from the palette's accents where one exists. */
export const AGENT_HEX: Record<AgentColor, string> = {
  red: 'var(--red)',
  blue: 'var(--blue)',
  green: 'var(--green)',
  yellow: 'var(--yellow)',
  purple: '#b48cff',
  orange: 'var(--orange)',
  pink: '#ff7ac8',
  cyan: '#4de1ff',
}

export const CAN_META: Record<AgentCan, { label: string; hint: string; short: string }> = {
  read: { label: 'Read code', hint: 'Read and search the project', short: 'reads code' },
  edit: { label: 'Edit files', hint: 'Change files in the folder', short: 'edits files' },
  run: { label: 'Run commands', hint: 'Tests, builds, scripts — asks first', short: 'runs commands' },
  web: { label: 'Web', hint: 'Search and fetch pages', short: 'web' },
}

export const canSummary = (can: AgentCan[]): string =>
  can.length ? can.map((c) => CAN_META[c].short).join(' · ') : 'only talks to the team'

// ---------------------------------------------------------------------------
// The draft the editor holds
// ---------------------------------------------------------------------------

/** An agent in the editor: a draft plus a stable key and whether its name was touched. */
export type EditorAgent = DraftAgent & { key: string; touched?: boolean }
export type TeamDraft = { manager: ManagerSpec; agents: EditorAgent[] }

let seq = 0
const key = () => `a${++seq}`

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

/** The address a draft agent will have: its library name, else its label's slug. */
export const nameOf = (a: EditorAgent): string => (a.base ? a.name : slugify(a.label))

export function draftFromTeam(team: TeamEntry | null, lib: TeamLibrary): TeamDraft {
  if (!team) return { manager: { model: null, effort: null, instructions: '' }, agents: [] }
  const agents = team.agents
    .map((n) => lib.agents.find((a) => a.name === n))
    .filter((a): a is AgentEntry => !!a)
    .map((a) => fromEntry(a))
  return { manager: { ...team.manager }, agents }
}

export function fromEntry(a: AgentEntry): EditorAgent {
  const { status: _s, path: _p, usedBy: _u, ...spec } = a
  return { ...spec, can: [...spec.can], base: a.name, dirty: false, key: key() }
}

export function blankAgent(used: EditorAgent[]): EditorAgent {
  const taken = new Set(used.map((a) => a.color))
  return {
    name: '',
    label: '',
    description: '',
    model: null,
    effort: null,
    color: AGENT_COLORS.find((c) => !taken.has(c)) ?? 'cyan',
    can: ['read'],
    prompt: '',
    base: null,
    dirty: true,
    key: key(),
  }
}

/** What goes over the wire: the draft minus the editor's own bookkeeping. */
export const wireAgents = (agents: EditorAgent[]): DraftAgent[] =>
  agents.map(({ key: _k, touched: _t, ...a }) => ({ ...a, name: nameOf({ ...a, key: '' }) }))

export type Problem = { key: string; field: 'name' | 'edit'; message: string; quiet?: boolean }

/** The roster rules, mirrored from server/teams.ts checkRoster — first problem is Start work's reason. */
export function problems(agents: EditorAgent[]): Problem[] {
  const out: Problem[] = []
  const names = agents.map((a) => nameOf(a))
  agents.forEach((a, i) => {
    if (!a.label.trim()) out.push({ key: a.key, field: 'name', message: a.touched ? 'needs a name' : 'name the new agent', quiet: !a.touched })
    else if (!names[i] || names[i] === 'manager') out.push({ key: a.key, field: 'name', message: `"${a.label}" can't be used as a name` })
    else if (names.indexOf(names[i]) !== i) out.push({ key: a.key, field: 'name', message: `two agents are named "${a.label}"` })
  })
  const editors = agents.filter((a) => a.can.includes('edit'))
  if (editors.length > 1) {
    out.push({ key: editors[1].key, field: 'edit', message: `${editors.map((e) => e.label || 'a new agent').join(' and ')} can both edit files` })
  }
  if (agents.length > MAX_TEAM_AGENTS) out.push({ key: agents[MAX_TEAM_AGENTS].key, field: 'name', message: `at most ${MAX_TEAM_AGENTS} agents` })
  return out
}
