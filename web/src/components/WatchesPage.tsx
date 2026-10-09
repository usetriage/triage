/**
 * Watches, as a table: one row per watch — switch, name, the integrations it
 * may use and its project, schedule, last run (with failure streaks, catch-ups
 * and config errors), next run, the last seven outcomes, tokens this week. Active /
 * Paused / All tabs, a filter, and Add watch. Runs live on each watch, not on
 * this page; the dots are the only history shown here.
 */
import * as Switch from '@radix-ui/react-switch'
import { Ellipsis, Pencil, Play, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActivityResponse, ActivityRun, Project, ProjectsResponse, SettingsResponse, Watch, WatchesResponse } from '../../../shared/protocol.js'
import { rowOpen } from '../tabs.js'
import { nextScheduled } from '../../../core/watch/cron.js'
import { relTime } from '../itemUi.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'
import { cronText, fmtUntil, grantIcon, grantLabel, runStatusText } from '../watchUi.js'

/** "5m ago", "3d ago" — or a plain date past two weeks, where "ago" would read wrong. */
export const ago = (at: number): string => {
  const r = relTime(at)
  return /^\d+[mhd]$/.test(r) ? `${r} ago` : r
}

/** The dot colour for one run outcome. */
export const runDotClass = (status: string | undefined): string =>
  !status ? 'blue' : status === 'ok' ? 'green' : status === 'failed' || status === 'timeout' ? 'red' : status === 'interrupted' ? 'yellow' : 'stone'

/** When the watch runs next, as the due rule sees it. */
export function nextRunText(w: Watch, now = Date.now()): string {
  if (!w.enabled) return '—'
  if (w.configError) return 'blocked'
  if (w.lastRunStartedAt == null) return 'now'
  const next = nextScheduled(w.schedule, w.lastRunStartedAt)
  if (next == null) return '—'
  return next <= now ? 'due now' : fmtUntil(next, now)
}

type Tab = 'active' | 'paused' | 'all'
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
  { id: 'all', label: 'All' },
]

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; watches: Watch[] }
  | { phase: 'error'; message: string }

const WEEK_MS = 7 * 86_400_000

const fmtTokens = (n: number) => (n === 0 ? '0' : n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`)

export function WatchesPage({
  onNavigate,
  onPin,
}: {
  onNavigate: (hash: string) => void
  /** Keep a watch in the band without leaving the list (⌘-click, middle-click). */
  onPin: (id: string, title: string) => void
}) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [runs, setRuns] = useState<ActivityRun[]>([])
  const [tab, setTab] = useState<Tab>('active')
  const [filter, setFilter] = useState('')
  const [running, setRunning] = useState<Set<string>>(new Set())
  // The global switch (Settings → Sources). Off = the scheduler never runs a watch.
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => setProjects(b.ok ? b.projects : []))
      .catch(() => {})
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<SettingsResponse>)
      .then((b) => setEnabled(b.ok ? b.settings.watchesEnabled : null))
      .catch(() => setEnabled(null))
  }, [])

  const load = useCallback(async () => {
    try {
      const [wr, ar] = await Promise.all([fetch('/api/watches'), fetch('/api/activity')])
      const body = (await wr.json()) as WatchesResponse
      if (body.ok) setState({ phase: 'ready', watches: body.watches })
      else setState({ phase: 'error', message: body.error })
      const act = (await ar.json()) as ActivityResponse
      if (act.ok) setRuns(act.runs)
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Per watch: the last seven outcomes (oldest first) and tokens spent this week.
  const history = useMemo(() => {
    const byWatch = new Map<string, { dots: ActivityRun[]; tokens: number }>()
    const since = Date.now() - WEEK_MS
    for (const r of runs) {
      if (!r.watchId) continue
      const h = byWatch.get(r.watchId) ?? { dots: [], tokens: 0 }
      if (h.dots.length < 7) h.dots.push(r)
      if (r.startedAt >= since) h.tokens += r.tokens ?? 0
      byWatch.set(r.watchId, h)
    }
    for (const h of byWatch.values()) h.dots.reverse()
    return byWatch
  }, [runs])

  async function toggle(w: Watch, on: boolean) {
    await fetch(`/api/watches?id=${encodeURIComponent(w.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: on }),
    })
    void load()
  }

  async function remove(w: Watch) {
    if (!confirm(`Delete watch “${w.title}”? Its open items move to Archived (nothing is deleted).`)) return
    await fetch(`/api/watches?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' })
    void load()
  }

  // Force-run one watch now (independent of its cadence). The run is a session;
  // we refresh a few times so the row reflects its outcome when it lands.
  async function run(w: Watch) {
    setRunning((prev) => new Set(prev).add(w.id))
    try {
      const res = await fetch(`/api/watches/run?id=${encodeURIComponent(w.id)}`, { method: 'POST' })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!body.ok) alert(body.error ?? 'could not start the run')
    } catch (err) {
      alert(String(err))
    }
    for (const ms of [5000, 12000, 30000]) setTimeout(() => void load(), ms)
    setTimeout(
      () =>
        setRunning((prev) => {
          const next = new Set(prev)
          next.delete(w.id)
          return next
        }),
      12000,
    )
  }

  const all = state.phase === 'ready' ? state.watches : []
  const counts = { active: all.filter((w) => w.enabled).length, paused: all.filter((w) => !w.enabled).length, all: all.length }
  const q = filter.trim().toLowerCase()
  const rows = all
    .filter((w) => (tab === 'all' ? true : tab === 'active' ? w.enabled : !w.enabled))
    .filter((w) => !q || w.title.toLowerCase().includes(q) || w.instruction.toLowerCase().includes(q))

  const edit = (w: Watch) => onNavigate(`/watches/${encodeURIComponent(w.id)}/edit`)
  const open = (w: Watch) => onNavigate(`/watches/${encodeURIComponent(w.id)}`)

  return (
    <div id="watchesPage" className="page wide">
      <div className="glow yellow" aria-hidden="true" />
      <div className="inner">
        <div className="watchHead">
          <h1 className="display">Watches</h1>
          <div className="seg" role="tablist" aria-label="Show">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`segBtn${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
                <span className="n">{counts[t.id]}</span>
              </button>
            ))}
          </div>
          <input className="filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter watches…" aria-label="Filter watches" />
          <button type="button" className="btn primary" onClick={() => onNavigate('/watches/new')}>
            <Plus size={13} aria-hidden="true" /> Add watch
          </button>
        </div>

        {enabled === false && (
          <div className="notice watchesOff">
            Scheduled runs are <b>off</b> for this workspace. Watches stay editable and “Run now” still works, but nothing runs on its own.{' '}
            <a href="#/settings/sources">Turn watches on in Settings → Sources</a>.
          </div>
        )}

        {state.phase === 'loading' && (
          <div className="probing">
            <span className="pip" /> Loading watches…
          </div>
        )}
        {state.phase === 'error' && <div className="msg error">{state.message}</div>}

        {state.phase === 'ready' && (
          <div className="wtblWrap">
            {rows.length === 0 ? (
              <div className="wtblEmpty">
                {all.length === 0 ? (
                  <>
                    <span>No watches yet. A watch is one paragraph of instructions, the integrations it may use, and a schedule.</span>
                    <button type="button" className="btn" onClick={() => onNavigate('/watches/new')}>
                      <Plus size={13} aria-hidden="true" /> Add your first watch
                    </button>
                  </>
                ) : (
                  <span>Nothing {tab === 'all' ? 'matches' : tab} here.</span>
                )}
              </div>
            ) : (
              <table className="wtbl">
                <thead>
                  <tr>
                    <th aria-label="On" />
                    <th>Watch</th>
                    <th>Uses</th>
                    <th>Schedule</th>
                    <th>Last run</th>
                    <th>Next</th>
                    <th>Last 7</th>
                    <th className="r">Tokens 7d</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => {
                    const h = history.get(w.id)
                    const failed = w.lastRunStatus === 'failed' || w.lastRunStatus === 'timeout' || Boolean(w.configError)
                    const project = projects.find((p) => p.id === w.projectId)
                    return (
                      <tr key={w.id} className={w.enabled ? undefined : 'off'}>
                        <td className="sw">
                          <Switch.Root className="uiSwitch" checked={w.enabled} onCheckedChange={(on) => void toggle(w, on)} aria-label={w.enabled ? `Pause ${w.title}` : `Resume ${w.title}`}>
                            <Switch.Thumb className="uiSwitchThumb" />
                          </Switch.Root>
                        </td>
                        <td className="nm">
                          <button
                            type="button"
                            className="t"
                            title={w.instruction}
                            {...rowOpen(
                              () => open(w),
                              () => onPin(w.id, w.title),
                            )}
                          >
                            {w.title}
                          </button>
                        </td>
                        <td>
                          <span className="uses">
                            {w.tools.map((g) => {
                              const Icon = grantIcon(g)
                              return (
                                <span key={grantLabel(g)} className="u" title={`${grantLabel(g)} · ${g.tools.length} tool${g.tools.length === 1 ? '' : 's'}`}>
                                  <Icon size={11} aria-hidden="true" />
                                </span>
                              )
                            })}
                            {project && (
                              <span className="u proj" title={project.path}>
                                {project.name}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="mono">{cronText(w.schedule)}</td>
                        <td>
                          <span className={`mono${failed ? ' bad' : ''}`} title={w.configError ?? w.lastRunError ?? undefined}>
                            {w.configError
                              ? 'config error'
                              : w.lastRunAt == null
                                ? 'never'
                                : `${ago(w.lastRunAt)} · ${!w.enabled ? 'paused' : running.has(w.id) ? 'running' : runStatusText(w.lastRunStatus, w.lastRunTrigger, w.consecutiveFailures)}`}
                          </span>
                        </td>
                        <td className="mono">{nextRunText(w)}</td>
                        <td>
                          <span className="runDots" aria-label="Last seven runs">
                            {Array.from({ length: 7 }, (_, i) => {
                              const r = h?.dots[i]
                              const cls = !r ? 'none' : runDotClass(r.status)
                              return (
                                <span
                                  key={i}
                                  className={`dot ${cls}`}
                                  title={
                                    r
                                      ? `${ago(r.startedAt)} · ${r.status ?? 'running'}${r.trigger && r.trigger !== 'scheduled' ? ` (${r.trigger.replace('_', '-')})` : ''}${r.newCount != null ? ` · ${r.newCount} new` : r.matches != null ? ` · ${r.matches} filed` : ''}${r.error ? ` · ${r.error}` : ''}`
                                      : undefined
                                  }
                                />
                              )
                            })}
                          </span>
                        </td>
                        <td className="r mono">{fmtTokens(h?.tokens ?? 0)}</td>
                        <td className="acts">
                          <div className="actRow">
                            <button type="button" className="iconBtn sm" title="Run now" disabled={running.has(w.id)} onClick={() => void run(w)}>
                              <Play size={13} aria-hidden="true" />
                            </button>
                            <button type="button" className="iconBtn sm" title="Edit" onClick={() => edit(w)}>
                              <Pencil size={13} aria-hidden="true" />
                            </button>
                            <Menu>
                              <MenuTrigger asChild>
                                <button type="button" className="iconBtn sm" title="More" aria-label={`More actions for ${w.title}`}>
                                  <Ellipsis size={13} aria-hidden="true" />
                                </button>
                              </MenuTrigger>
                              <MenuContent align="end">
                                {w.lastRunSessionId && <MenuItem onSelect={() => onNavigate(`/${w.lastRunSessionId}`)}>Open last run</MenuItem>}
                                <MenuItem onSelect={() => void toggle(w, !w.enabled)}>{w.enabled ? 'Pause' : 'Resume'}</MenuItem>
                                <MenuItem className="danger" onSelect={() => void remove(w)}>
                                  Delete…
                                </MenuItem>
                              </MenuContent>
                            </Menu>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {state.phase === 'ready' && all.length > 0 && (
          <div className="wtblFoot">
            <span className="mono">{enabled === false ? 'scheduler off' : 'scheduler on'}</span>
            <span style={{ marginLeft: 'auto' }}>Open a watch to see its runs and what it filed.</span>
          </div>
        )}
      </div>
    </div>
  )
}
