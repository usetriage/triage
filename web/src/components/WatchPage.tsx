/**
 * One watch (#/watches/<id>): a health strip that answers "is it working", then
 * Overview (the rule and its settings), Runs (every run is a session — the
 * receipt first, the transcript one click deeper), and Items (what it filed).
 */
import * as Dialog from '@radix-ui/react-dialog'
import * as Switch from '@radix-ui/react-switch'
import { Ellipsis, ExternalLink, Pencil, Play, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActivityResponse, ActivityRun, ItemListResponse, Project, ProjectsResponse, Watch, WatchesResponse } from '../../../shared/protocol.js'
import type { ScoredItem } from '../../../core/work/types.js'
import { describeCron, nextScheduled } from '../../../core/watch/cron.js'
import { itemHash, useEvents } from '../hooks.js'
import { kindIcon, relTime } from '../itemUi.js'
import { store } from '../store.js'
import { Transcript } from './Transcript.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'
import { humanSpan, lookbackMs, parseCatchUp } from '../../../core/watch/schedule.js'
import { TRIGGER_LABEL, grantIcon, grantLabel, runStatusText } from '../watchUi.js'
import { ago, nextRunText, runDotClass } from './WatchesPage.js'

type Tab = 'overview' | 'runs' | 'items'
const WEEK_MS = 7 * 86_400_000
const SHOW_RUNS = 7

const fmtTokens = (n: number) => (n === 0 ? '0' : n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`)
const fmtUsd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)
const fmtDur = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
const fmtWhen = (ms: number) => {
  const d = new Date(ms)
  const today = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `Today ${time}`
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`
}

export function WatchPage({ id, onNavigate }: { id: string; onNavigate: (hash: string) => void }) {
  const [watch, setWatch] = useState<Watch | null | undefined>(undefined)
  const [runs, setRuns] = useState<ActivityRun[]>([])
  const [items, setItems] = useState<ScoredItem[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [tab, setTab] = useState<Tab>('runs')
  const [showAll, setShowAll] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [openRun, setOpenRun] = useState<ActivityRun | null>(null)

  const load = useCallback(async () => {
    try {
      const [wr, ar, ir] = await Promise.all([
        fetch('/api/watches'),
        fetch(`/api/activity?watchId=${encodeURIComponent(id)}`),
        fetch(`/api/watches/items?id=${encodeURIComponent(id)}`),
      ])
      const wb = (await wr.json()) as WatchesResponse
      setWatch(wb.ok ? (wb.watches.find((w) => w.id === id) ?? null) : null)
      const ab = (await ar.json()) as ActivityResponse
      if (ab.ok) setRuns(ab.runs)
      const ib = (await ir.json()) as ItemListResponse
      if (ib.ok) setItems(ib.items)
    } catch (err) {
      setError(String(err))
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => setProjects(b.ok ? b.projects : []))
      .catch(() => setProjects([]))
  }, [])

  // The health strip, all derived: runs this week, what they filed and cost,
  // and how many of the filed items the user kept (anything not archived).
  const health = useMemo(() => {
    const since = Date.now() - WEEK_MS
    const week = runs.filter((r) => r.startedAt >= since)
    const lastOk = runs.find((r) => r.status === 'ok')
    const kept = items.filter((it) => it.status !== 'archived').length
    return {
      lastOk,
      ok: week.filter((r) => r.status === 'ok').length,
      failed: week.filter((r) => r.status === 'failed' || r.status === 'timeout').length,
      skipped: week.filter((r) => r.status === 'skipped' || r.status === 'interrupted').length,
      filed: week.reduce((n, r) => n + (r.newCount ?? r.matches ?? 0), 0),
      tokens: week.reduce((n, r) => n + (r.tokens ?? 0), 0),
      runsWithTokens: week.filter((r) => (r.tokens ?? 0) > 0).length,
      cost: week.reduce((n, r) => n + (r.costUsd ?? 0), 0),
      runsWithCost: week.filter((r) => r.costUsd != null).length,
      kept,
      total: items.length,
    }
  }, [runs, items])

  async function toggle(on: boolean) {
    if (!watch) return
    await fetch(`/api/watches?id=${encodeURIComponent(watch.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: on }),
    })
    void load()
  }

  async function runNow() {
    if (!watch) return
    setRunning(true)
    try {
      const res = await fetch(`/api/watches/run?id=${encodeURIComponent(watch.id)}`, { method: 'POST' })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!body.ok) setError(body.error ?? 'could not start the run')
    } catch (err) {
      setError(String(err))
    }
    for (const ms of [3000, 8000, 15000, 30000]) setTimeout(() => void load(), ms)
    setTimeout(() => setRunning(false), 12000)
  }

  async function remove() {
    if (!watch) return
    if (!confirm(`Delete watch “${watch.title}”? Its open items move to Archived (nothing is deleted).`)) return
    await fetch(`/api/watches?id=${encodeURIComponent(watch.id)}`, { method: 'DELETE' })
    onNavigate('/watches')
  }

  if (watch === undefined) {
    return (
      <div className="page wide">
        <div className="probing">
          <span className="pip" /> Loading…
        </div>
      </div>
    )
  }
  if (watch === null) {
    return (
      <div className="page wide">
        <div className="inner">
          <div className="crumbs">
            <button type="button" className="crumb link" onClick={() => onNavigate('/watches')}>
              Watches
            </button>
          </div>
          <div className="msg error">{error || 'This watch no longer exists.'}</div>
        </div>
      </div>
    )
  }

  const project = watch.projectId ? projects.find((p) => p.id === watch.projectId) : undefined
  const nextDue = watch.enabled && !watch.configError ? nextScheduled(watch.schedule, watch.lastRunStartedAt ?? Date.now()) : null
  const catchUp = parseCatchUp(watch.catchUpWindow, watch.output)
  const catchUpText = catchUp.kind === 'unlimited' ? 'always, once on wake' : catchUp.kind === 'never' ? 'never — on-time slots only' : `within ${humanSpan(catchUp.ms)}`
  const uses = watch.tools.map(grantLabel).join(', ')
  const shownRuns = showAll ? runs : runs.slice(0, SHOW_RUNS)
  const edit = () => onNavigate(`/watches/${encodeURIComponent(watch.id)}/edit`)

  return (
    <div className="page wide">
      <div className="glow orange" aria-hidden="true" />
      <div className="inner">
        <div className="crumbs" style={{ marginBottom: 14 }}>
          <button type="button" className="crumb link" onClick={() => onNavigate('/watches')}>
            Watches
          </button>
          <span className="crumbSep">›</span>
          <span className="crumb now">{watch.title}</span>
        </div>

        <div className="watchPageHead">
          <div style={{ minWidth: 0 }}>
            <h1 className="display">{watch.title}</h1>
            <div className="watchMetaLine">
              <span className="uses">
                {watch.tools.map((g) => {
                  const Icon = grantIcon(g)
                  return (
                    <span key={grantLabel(g)} className="u" title={grantLabel(g)}>
                      <Icon size={11} aria-hidden="true" />
                    </span>
                  )
                })}
              </span>
              <span>{uses}</span>
              {project && (
                <>
                  <span className="sep">·</span>
                  <span className="mono">{project.name}</span>
                </>
              )}
              <span className="sep">·</span>
              <span>{describeCron(watch.schedule)}</span>
              {watch.output === 'digest' && (
                <>
                  <span className="sep">·</span>
                  <span>digest</span>
                </>
              )}
              {watch.model && (
                <>
                  <span className="sep">·</span>
                  <span className="mono">{watch.model}</span>
                </>
              )}
              <span className="sep">·</span>
              <span className="mono">last {runStatusText(watch.lastRunStatus, watch.lastRunTrigger, watch.consecutiveFailures)}</span>
              {nextDue != null && (
                <>
                  <span className="sep">·</span>
                  <span>next {nextDue <= Date.now() ? nextRunText(watch) : fmtWhen(nextDue)}</span>
                </>
              )}
            </div>
            <p className="watchRuleLine" title={watch.instruction}>
              {watch.instruction}
            </p>
          </div>
          <div className="acts">
            <span className="onLbl">
              On
              <Switch.Root className="uiSwitch" checked={watch.enabled} onCheckedChange={(on) => void toggle(on)} aria-label={watch.enabled ? 'Pause watch' : 'Resume watch'}>
                <Switch.Thumb className="uiSwitchThumb" />
              </Switch.Root>
            </span>
            <button type="button" className="btn" disabled={running} onClick={() => void runNow()}>
              <Play size={13} aria-hidden="true" /> {running ? 'Running…' : 'Run now'}
            </button>
            <button type="button" className="btn" onClick={edit}>
              <Pencil size={13} aria-hidden="true" /> Edit
            </button>
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className="btn ghost" aria-label="More actions">
                  <Ellipsis size={13} aria-hidden="true" />
                </button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem onSelect={() => void toggle(!watch.enabled)}>{watch.enabled ? 'Pause' : 'Resume'}</MenuItem>
                <MenuItem className="danger" onSelect={() => void remove()}>
                  Delete…
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>

        {error && <div className="msg error">{error}</div>}
        {watch.configError && (
          <div className="msg error">
            This watch can’t run: {watch.configError}.{' '}
            <button type="button" className="tlink" onClick={edit}>
              Edit the watch
            </button>
          </div>
        )}
        {!watch.configError && watch.consecutiveFailures > 1 && (
          <div className="msg error">
            The last {watch.consecutiveFailures} runs failed{watch.lastRunError ? `: ${watch.lastRunError}` : ''}.
          </div>
        )}

        <div className="statsCard">
        <div className="stats">
          <div className="stat">
            <div className="k">Last success</div>
            <div className="v">
              {health.lastOk ? (
                <>
                  {ago(health.lastOk.startedAt)} <small>{fmtWhen(health.lastOk.startedAt)}</small>
                </>
              ) : (
                <small className="dim">never</small>
              )}
            </div>
          </div>
          <div className="stat">
            <div className="k">Runs · 7d</div>
            <div className={`v${health.failed > 0 && health.ok === 0 ? ' bad' : ''}`}>
              {health.ok + health.failed + health.skipped === 0 ? (
                <small className="dim">none yet</small>
              ) : (
                <>
                  {health.ok} <small>ok</small>
                  {health.failed > 0 && <small style={{ color: 'var(--red)' }}>{health.failed} failed</small>}
                  {health.skipped > 0 && <small className="dim">{health.skipped} skipped</small>}
                </>
              )}
            </div>
          </div>
          <div className="stat">
            <div className="k">Filed · 7d</div>
            <div className="v">
              {health.filed} <small>items</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">Kept</div>
            <div className="v">
              {health.total === 0 ? (
                <small className="dim">nothing filed yet</small>
              ) : (
                <>
                  {health.kept} of {health.total}
                  {health.total - health.kept > 0 && <small className="dim">{health.total - health.kept} archived as noise</small>}
                </>
              )}
            </div>
          </div>
          <div className="stat">
            <div className="k">Cost · 7d</div>
            <div className="v">
              {health.runsWithCost ? fmtUsd(health.cost) : health.tokens ? fmtTokens(health.tokens) : <small className="dim">nothing spent</small>}
              {health.runsWithCost ? (
                <small>
                  {fmtTokens(health.tokens)} tok{health.runsWithCost > 1 ? ` · ~${fmtUsd(health.cost / health.runsWithCost)} per run` : ''}
                </small>
              ) : health.tokens ? (
                <small>tok</small>
              ) : null}
            </div>
          </div>
        </div>
        <CostChart runs={runs} />
        </div>

        <div className="watchTabs" role="tablist">
          {(
            [
              ['overview', 'Overview', null],
              ['runs', 'Runs', runs.length],
              ['items', 'Items', items.length],
            ] as Array<[Tab, string, number | null]>
          ).map(([t, label, n]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`watchTab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {label}
              {n != null && <span className="n">{n}</span>}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className="watchOverview">
            <div className="card watchRule">
              <div className="head">
                <span className="k">Instructions</span>
                <button type="button" className="btn xs ghost" onClick={edit}>
                  <Pencil size={12} aria-hidden="true" /> Edit
                </button>
              </div>
              <div className="text">{watch.instruction}</div>
            </div>
            <div className="card soft watchKv">
              <span className="k">Uses</span>
              <span className="v">
                {watch.tools.map((g) => `${grantLabel(g)} (${g.tools.length} tool${g.tools.length === 1 ? '' : 's'})`).join(', ')}
              </span>
              <span className="k">Project</span>
              <span className="v mono">{project ? `${project.name} · ${project.path}` : 'removed'}</span>
              <span className="k">Output</span>
              <span className="v">{watch.output === 'digest' ? 'one rolling digest with a report' : 'work items'}</span>
              <span className="k">Model</span>
              <span className="v mono">{watch.model ?? 'default'}</span>
              <span className="k">Schedule</span>
              <span className="v">
                {describeCron(watch.schedule)} <span className="mono" style={{ color: 'var(--stone)' }}>{watch.schedule}</span>
              </span>
              <span className="k">Looks back</span>
              <span className="v">about {humanSpan(lookbackMs(watch.schedule, Date.now()))} unless the instructions say otherwise</span>
              <span className="k">Missed slots</span>
              <span className="v">{catchUpText}</span>
              <span className="k">Limits</span>
              <span className="v mono">
                {watch.timeoutMs ? humanSpan(watch.timeoutMs) : 'default timeout'} · {watch.maxBudgetUsd != null ? `$${watch.maxBudgetUsd} cap` : 'default budget'}
              </span>
              <span className="k">Notify</span>
              <span className="v">{watch.notify === 'on_failure' ? 'on failure' : watch.notify}</span>
              <span className="k">Next due</span>
              <span className="v">{watch.configError ? 'blocked' : nextDue != null ? fmtWhen(nextDue) : watch.enabled ? '—' : 'paused'}</span>
              <span className="k">Created</span>
              <span className="v">{new Date(watch.createdAt).toLocaleDateString()}</span>
              {watch.scope && (
                <>
                  <span className="k">Legacy place</span>
                  <span className="v mono">{watch.scope}</span>
                </>
              )}
            </div>
          </div>
        )}

        {tab === 'runs' &&
          (runs.length === 0 ? (
            <div className="watchEmpty">No runs yet. Run now, or wait for the schedule.</div>
          ) : (
            <>
              <table className="rtbl">
                <thead>
                  <tr>
                    <th aria-label="Status" />
                    <th>Started</th>
                    <th className="r">Took</th>
                    <th>Outcome</th>
                    <th className="r">New</th>
                    <th className="r">Tokens</th>
                    <th className="r">Cost</th>
                    <th aria-label="Transcript" />
                  </tr>
                </thead>
                <tbody>
                  {shownRuns.map((r) => {
                    const live = !r.status
                    const dot = live ? 'blue live' : runDotClass(r.status)
                    const why = r.trigger && r.trigger !== 'scheduled' ? ` · ${TRIGGER_LABEL[r.trigger]}` : ''
                    const found =
                      r.newCount != null
                        ? r.matches
                          ? ` · ${r.newCount} new${r.matches - r.newCount > 0 ? `, ${r.matches - r.newCount} already filed` : ''}`
                          : ' · looked, found nothing'
                        : r.matches
                          ? ` · ${r.matches} filed`
                          : ' · looked, found nothing'
                    const outcome = live
                      ? 'running…'
                      : r.status === 'ok'
                        ? `ok${found}${why}`
                        : r.status === 'skipped'
                          ? (r.error ?? 'skipped')
                          : `${r.status} · ${r.error ?? 'unknown error'}${why}`
                    return (
                      <tr key={r.sessionId}>
                        <td className="d">
                          <span className={`dot ${dot}`} />
                        </td>
                        <td className="mono">{fmtWhen(r.startedAt)}</td>
                        <td className="r mono">{live ? '—' : fmtDur(r.finishedAt - r.startedAt)}</td>
                        <td className={`outcome${r.status === 'failed' || r.status === 'timeout' ? ' bad' : r.status === 'skipped' || r.status === 'interrupted' ? ' skip' : ''}`}>{outcome}</td>
                        <td className="r mono">{r.status === 'ok' ? (r.newCount ?? r.matches ?? 0) : '—'}</td>
                        <td className="r mono">{r.tokens ? fmtTokens(r.tokens) : '—'}</td>
                        <td className="r mono">{r.costUsd != null ? fmtUsd(r.costUsd) : '—'}</td>
                        <td className="tr r">
                          <button type="button" className="tlink" onClick={() => setOpenRun(r)}>
                            Transcript <ExternalLink size={11} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="rtblFoot">
                <span>Every run is a session. Runs are stateless: each looks back over its window, and anything found twice lands on the same item.</span>
                {runs.length > SHOW_RUNS && (
                  <button type="button" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? `Show latest ${SHOW_RUNS}` : `Show all ${runs.length}`}
                  </button>
                )}
              </div>
            </>
          ))}

        {tab === 'items' &&
          (items.length === 0 ? (
            <div className="watchEmpty">Nothing filed yet.</div>
          ) : (
            <div className="homeList watchItems">
              {items.map((it) => {
                const Icon = kindIcon(it)
                const why = it.foundBy?.find((p) => p.watchId === watch.id)?.why
                return (
                  <div key={it.id} className="wrow">
                    <span className="glyph">
                      <Icon size={14} aria-hidden="true" />
                    </span>
                    <button type="button" className="t" onClick={() => onNavigate(itemHash(it.id))}>
                      <span className="name">{it.title}</span>
                      {why && <span className="why">{why}</span>}
                    </button>
                    <span className="meta">
                      <span className="c state">{it.status ?? 'open'}</span>
                      <span className="c src">{it.repo || it.source}</span>
                      <span className="c when">{relTime(it.updatedAt)}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
      </div>

      <RunTranscriptModal run={openRun} watchTitle={watch.title} onClose={() => setOpenRun(null)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Spend per day, last 14 days. One series, so one hue; bars are thin with a
// rounded data-end, a 2px gap, and a hover tooltip carrying cost, tokens, runs.
// Days with runs but no recorded cost (runs older than the cost column) show
// as an outline so "nothing spent" and "not recorded" don't read the same.
// ---------------------------------------------------------------------------

const DAYS = 14

function CostChart({ runs }: { runs: ActivityRun[] }) {
  const [hot, setHot] = useState<number | null>(null)
  const days = useMemo(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const out = Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() - (DAYS - 1 - i))
      return { at: d.getTime(), cost: 0, tokens: 0, runs: 0, priced: 0 }
    })
    for (const r of runs) {
      const idx = Math.floor((r.startedAt - days0(out)) / 86_400_000)
      if (idx < 0 || idx >= DAYS) continue
      const day = out[idx]
      day.runs += 1
      day.tokens += r.tokens ?? 0
      if (r.costUsd != null) {
        day.cost += r.costUsd
        day.priced += 1
      }
    }
    return out
  }, [runs])
  const max = Math.max(0.01, ...days.map((d) => d.cost))
  const total = days.reduce((n, d) => n + d.cost, 0)
  const totalRuns = days.reduce((n, d) => n + d.runs, 0)
  if (totalRuns === 0) return null
  const label = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return (
    <div className="costCard">
      <div className="head">
        <span className="t">{fmtUsd(total)}</span>
        <span>spent in the last {DAYS} days</span>
        <span className="mono" style={{ marginLeft: 'auto' }}>
          {totalRuns} runs · {fmtTokens(days.reduce((n, d) => n + d.tokens, 0))} tok
        </span>
      </div>
      <div className="costChart" onMouseLeave={() => setHot(null)}>
        <div className="costBars" style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: '100%', borderBottom: '1px solid var(--hair-strong)' }}>
          {days.map((d, i) => {
            const h = d.cost > 0 ? Math.max(3, Math.round((d.cost / max) * 114)) : d.runs > 0 ? 3 : 0
            const cls = d.cost > 0 ? `bar${hot === i ? ' hot' : ''}` : d.runs > 0 ? 'bar unpriced' : 'bar none'
            return (
              <div key={d.at} style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end', position: 'relative' }} onMouseEnter={() => setHot(i)}>
                <div className={cls} style={{ width: '100%', height: h }} />
                {hot === i && (
                  <div className="costTip" style={{ left: '50%' }}>
                    <div>
                      {label(d.at)} · <span className="k">{d.runs} run{d.runs === 1 ? '' : 's'}</span>
                    </div>
                    <div>
                      {d.priced ? fmtUsd(d.cost) : 'cost not recorded'} <span className="k">· {fmtTokens(d.tokens)} tok</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="costAxis">
        <span>{label(days[0].at)}</span>
        <span>{label(days[Math.floor(DAYS / 2)].at)}</span>
        <span>today</span>
      </div>
    </div>
  )
}

const days0 = (days: Array<{ at: number }>) => days[0].at

// ---------------------------------------------------------------------------
// A run's transcript, in place. The run is a session; this replays its event
// log into the same Transcript the session page uses.
// ---------------------------------------------------------------------------

function RunTranscriptModal({ run, watchTitle, onClose }: { run: ActivityRun | null; watchTitle: string; onClose: () => void }) {
  const sessionId = run?.sessionId ?? null
  const events = useEvents(sessionId)
  useEffect(() => {
    if (sessionId) store.subscribeSession(sessionId)
  }, [sessionId])
  return (
    <Dialog.Root open={run !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="runOverlay" />
        <Dialog.Content className="runModal" aria-describedby={undefined}>
          {run && (
            <>
              <div className="head">
                <Dialog.Title className="title">
                  <span className={`dot ${!run.status ? 'blue live' : run.status === 'ok' ? 'green' : run.status === 'failed' ? 'red' : 'stone'}`} />
                  {watchTitle}
                </Dialog.Title>
                <div className="meta">
                  <span>{fmtWhen(run.startedAt)}</span>
                  <span className="sep">·</span>
                  <span>{run.status ?? 'running'}</span>
                  {run.status && (
                    <>
                      <span className="sep">·</span>
                      <span>{fmtDur(run.finishedAt - run.startedAt)}</span>
                    </>
                  )}
                  {run.tokens ? (
                    <>
                      <span className="sep">·</span>
                      <span>{fmtTokens(run.tokens)} tok</span>
                    </>
                  ) : null}
                  {run.costUsd != null && (
                    <>
                      <span className="sep">·</span>
                      <span>{fmtUsd(run.costUsd)}</span>
                    </>
                  )}
                </div>
                <div className="right">
                  <Dialog.Close asChild>
                    <button type="button" className="iconBtn" aria-label="Close">
                      <X size={14} aria-hidden="true" />
                    </button>
                  </Dialog.Close>
                </div>
              </div>
              <div className="body">
                {events.length === 0 ? <div className="empty">Loading the run’s transcript…</div> : <Transcript sessionId={run.sessionId} events={events} onRespond={() => {}} />}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
