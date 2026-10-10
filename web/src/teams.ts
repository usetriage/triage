/**
 * Teams v2 on the client (.docs/teams.md): the library fetch, the API calls a
 * run's card and strip make, and the display helpers both share.
 */
import type {
  AgentCan,
  AgentColor,
  AgentEntry,
  RecipeEntry,
  SessionSummary,
  TeamLibraryResponse,
  TeamPickerResponse,
  TeamRunResponse,
  TeamRunView,
} from '../../shared/protocol.js'

export type TeamLibrary = { teams: RecipeEntry[]; agents: AgentEntry[]; dir: string }

export async function loadTeamLibrary(): Promise<TeamLibrary> {
  const b = (await (await fetch('/api/teams/library')).json()) as TeamLibraryResponse
  if (!b.ok) throw new Error(b.error)
  return { teams: b.teams, agents: b.agents, dir: b.dir }
}

/** POST/PUT/DELETE a /api/teams route; the parsed body comes back on success. */
export async function teamsCall<T = TeamLibraryResponse>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/teams/${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const b = (await res.json()) as { ok: boolean; error?: string }
  if (!b.ok) throw new Error(b.error ?? 'request failed')
  return b as T
}

export async function loadTeamPicker(kind: string): Promise<Extract<TeamPickerResponse, { ok: true }>> {
  const b = (await (await fetch(`/api/teams/picker?kind=${encodeURIComponent(kind)}`)).json()) as TeamPickerResponse
  if (!b.ok) throw new Error(b.error)
  return b
}

export async function loadTeamRun(runId: string): Promise<TeamRunView> {
  const b = (await (await fetch(`/api/teams/run?runId=${encodeURIComponent(runId)}`)).json()) as TeamRunResponse
  if (!b.ok) throw new Error(b.error)
  return b.run
}

/** The lead session of a run, read off the session list. */
export const leadOf = (sessions: readonly SessionSummary[], runId: string): SessionSummary | undefined =>
  sessions.find((s) => s.teamRun?.id === runId && s.teamRun.role === 'lead')

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

/** A worker's colour; the lead (and triage's own checks) draw in ink. */
export const colorOf = (c: string): string => AGENT_HEX[c as AgentColor] ?? 'var(--ink)'

export const CAN_META: Record<AgentCan, { label: string; hint: string; short: string }> = {
  read: { label: 'Read code', hint: 'Read and search the project', short: 'reads code' },
  edit: { label: 'Edit files', hint: 'Change files — only on the step that changes files', short: 'edits files' },
  run: { label: 'Run commands', hint: 'Tests, builds, scripts — asks first', short: 'runs commands' },
  web: { label: 'Web', hint: 'Search and fetch pages', short: 'web' },
  browser: { label: 'Browser', hint: 'Your chrome-devtools connector — the only one loaded', short: 'browser' },
}

export const canSummary = (can: AgentCan[]): string => (can.length ? can.map((c) => CAN_META[c].short).join(' · ') : 'reads only what it is sent')

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

export const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

/** A step as one short line: "review ×4 · code-reviewer → findings". */
export function stepLine(s: { id: string; agent: string; output: string | null; fanOut: { by: string; max: number } | null }): string {
  return `${s.id}${s.fanOut ? ` ×${s.fanOut.max}` : ''}`
}
