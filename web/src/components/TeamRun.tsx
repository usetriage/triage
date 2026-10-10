import * as Collapsible from '@radix-ui/react-collapsible'
import * as Tabs from '@radix-ui/react-tabs'
import { ChevronRight, PanelRight, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Handoff, ModelOption, SessionSummary, SessionTeamRun, Slice, TeamCard, TeamRun, TeamRunView } from '../../../shared/protocol.js'
import { leadSlices, normalizeRun } from '../../../core/teams/engine.js'
import { findModel } from '../models.js'
import { Select, SelectItem } from '../ui/Select.js'
import { colorOf, loadTeamRun, teamsCall, usd } from '../teams.js'

/**
 * A team run in a session (Teams v2), in three places so none of them is big:
 *
 *   TeamStrip  over the transcript — who's on the team, what each is doing and has spent
 *   TeamDock   above the composer, on the lead — the one thing the run needs from you now
 *   TeamSide   a drawer on the right — every detail, editable in place before you approve
 *
 * All three read one fetch of the run (useTeamRun), refetched whenever its revision moves.
 */

const call = (path: string, body: unknown) => teamsCall<{ ok: true }>('POST', path, body)
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function useTeamRun(link: SessionTeamRun | undefined): TeamRunView | null {
  const [run, setRun] = useState<TeamRunView | null>(null)
  useEffect(() => {
    if (!link) {
      setRun(null)
      return
    }
    let live = true
    loadTeamRun(link.id)
      // A server from before plans and tasks sends runs without them: fill today's empty defaults.
      .then((r) => live && setRun(normalizeRun(r as unknown as TeamRun) as unknown as TeamRunView))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [link?.id, link?.rev, link?.state]) // eslint-disable-line react-hooks/exhaustive-deps
  return run && link && run.id === link.id ? run : null
}

/** The card as the server takes it back (PUT /api/teams/card). */
const wireCard = (c: TeamCard) => ({
  goal: c.goal,
  criteria: c.criteria,
  outOfScope: c.outOfScope,
  tasks: c.tasks,
  decisions: c.decisions,
  budgetUsd: c.budgetUsd,
  note: c.note,
  steps: c.steps.map((s) => ({ id: s.id, model: s.model ?? undefined, slices: s.slices ?? undefined })),
})

/** One step's agent, as the team reads it. */
function who(run: TeamRunView, agent: string): { label: string; color: string } {
  if (agent === 'lead') return { label: 'Lead', color: 'lead' }
  if (agent === 'checks') return { label: 'checks', color: 'checks' }
  const a = run.agents.find((x) => x.name === agent)
  return { label: a?.label ?? agent, color: a?.color ?? 'blue' }
}

function Mark({ color }: { color: string }) {
  if (color === 'lead') return <span className="mgrGlyph" aria-hidden="true" />
  if (color === 'checks') return <span className="swatch sys" aria-hidden="true" />
  return <span className="swatch" style={{ background: colorOf(color) }} aria-hidden="true" />
}

/** How many workers a step has, or will have: "×3", "×≤4", or nothing for one. */
function widthOf(run: TeamRunView, i: number): string {
  const s = run.recipe.steps[i]
  if (!s.fanOut) return ''
  const started = run.workers.filter((w) => w.stepId === s.id).length
  if (started > 1) return `×${started}`
  const planned = run.card.steps.find((c) => c.id === s.id)?.slices?.length
  return planned ? `×${planned}` : `×≤${s.fanOut.max}`
}

// ---------------------------------------------------------------------------
// The strip: one tab per session, then the planned agents, the spend and controls
// ---------------------------------------------------------------------------

export function TeamStrip({
  run,
  sessionId,
  sessions,
  models,
  sideOpen,
  onToggleSide,
  onNavigate,
}: {
  run: TeamRunView
  sessionId: string
  sessions: readonly SessionSummary[]
  models: ModelOption[]
  sideOpen: boolean
  onToggleSide: () => void
  onNavigate: (to: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const modelName = (m: string | null | undefined) => (m ? findModel(models, m)?.name ?? m : undefined)
  // One tab per session: a session that worked two steps (Debug's challenge) is one member.
  const members = useMemo(() => {
    const out = [{ sessionId: run.leadSessionId, label: 'Lead', color: 'lead' }]
    for (const w of run.workers) {
      if (!w.sessionId || w.sessionId === run.leadSessionId) continue
      const at = out.findIndex((m) => m.sessionId === w.sessionId)
      if (at === -1) out.push({ sessionId: w.sessionId, label: w.label, color: w.color })
      else out[at] = { ...out[at], label: w.label }
    }
    return out
  }, [run])
  // Everyone the recipe brings in, from the card on: an agent with no session yet is a dashed chip.
  const planned = useMemo(() => {
    const out: { agent: string; label: string; color: string; model: string | null; width: string; first: string }[] = []
    run.recipe.steps.forEach((s, i) => {
      if (s.agent === 'lead' || s.agent === 'checks') return
      if (run.workers.some((w) => w.agent === s.agent && w.sessionId) || out.some((x) => x.agent === s.agent)) return
      const a = run.agents.find((x) => x.name === s.agent)
      out.push({
        agent: s.agent,
        label: a?.label ?? s.agent,
        color: a?.color ?? 'blue',
        model: run.card.steps.find((c) => c.id === s.id)?.model ?? s.model ?? a?.model ?? null,
        width: widthOf(run, i),
        first: s.id,
      })
    })
    return out
  }, [run])
  const ended = run.state === 'done' || run.state === 'stopped'
  const going = run.state === 'running' || run.state === 'gate'
  const act = (path: 'pause' | 'resume' | 'stop') => {
    setBusy(true)
    call(path, { runId: run.id })
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  const pct = Math.min(100, (run.spentUsd / Math.max(0.01, run.budgetUsd)) * 100)

  return (
    <Tabs.Root value={sessionId} onValueChange={onNavigate} activationMode="manual">
      <Tabs.List id="teamStrip" aria-label="Team members">
        <span className="teamLabel">{run.recipe.label}</span>
        {members.map((m) => {
          const s = sessions.find((x) => x.id === m.sessionId)
          const working = s?.status === 'running' || s?.status === 'starting'
          const needsYou = s?.waiting || (m.sessionId === run.leadSessionId && (run.state === 'proposed' || run.state === 'gate'))
          const state = needsYou ? 'needs you' : working ? 'working' : s?.status === 'error' ? 'error' : 'idle'
          const model = modelName(s?.model)
          const spent = run.spend[m.sessionId] ?? 0
          return (
            <Tabs.Trigger key={m.sessionId} value={m.sessionId} className="teamTab" title={`${m.label} — ${state}${model ? ` · ${model}` : ''} · ${usd(spent)}`}>
              <Mark color={m.color} />
              <span className="role">{m.label}</span>
              {model && <span className="model">{model}</span>}
              {spent > 0 && <span className="spend">{usd(spent)}</span>}
              {(needsYou || working) && (
                <span className="state">
                  <span className={`dot ${needsYou ? 'yellow' : 'live'}`} aria-hidden="true" /> {state}
                </span>
              )}
              {s?.status === 'error' && <span className="dot red" aria-label="error" />}
            </Tabs.Trigger>
          )
        })}
        {planned.map((p) => (
          <span key={p.agent} className="teamTab planned" title={`${p.label}${p.width ? ` ${p.width}` : ''} — ${ended ? "didn't run" : `starts at ${p.first}`}${p.model ? ` · ${p.model}` : ''}`}>
            <Mark color={p.color} />
            <span className="role">{p.label}</span>
            {p.width && <span className="model">{p.width}</span>}
            {p.model && <span className="model">{modelName(p.model)}</span>}
            <span className="state">{ended ? "didn't run" : `at ${p.first}`}</span>
          </span>
        ))}
        <span className={`teamRun ${run.state}`}>
          {run.state !== 'proposed' && (
            <>
              <span className="teamMeter" title={`${usd(run.spentUsd)} of ${usd(run.budgetUsd)} budget`} aria-hidden="true">
                <i style={{ width: `${pct}%` }} />
              </span>
              <span className="teamRunSpend">
                {usd(run.spentUsd)} <span className="of">/ {usd(run.budgetUsd)}</span>
              </span>
            </>
          )}
          {going && (
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act('pause')} title="Stop every worker now; resume later">
              Pause
            </button>
          )}
          {(going || run.state === 'paused') && (
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act('stop')} title="End the run">
              Stop
            </button>
          )}
          <button type="button" className={`btn sm ghost teamSideBtn${sideOpen ? ' on' : ''}`} onClick={onToggleSide} aria-pressed={sideOpen} title="Every detail of the run — and, before you approve, where you change it">
            <PanelRight size={13} aria-hidden="true" /> Details
          </button>
        </span>
      </Tabs.List>
    </Tabs.Root>
  )
}

// ---------------------------------------------------------------------------
// The dock: small, above the composer, on the lead — what the run needs now
// ---------------------------------------------------------------------------

function Flow({ run }: { run: TeamRunView }) {
  const at = run.state === 'done' ? run.recipe.steps.length : run.step
  const live = run.state !== 'proposed'
  return (
    <span className="tdFlow">
      {run.recipe.steps.map((s, i) => {
        const w = who(run, s.agent)
        const state = !live ? '' : i < at ? ' done' : i === at ? ' on' : ''
        const loopStart = s.forEach && !run.recipe.steps[i - 1]?.forEach
        return (
          <span key={s.id} className="tdStepWrap">
            {i > 0 && <span className="tdArrow" aria-hidden="true">→</span>}
            {loopStart && (
              <span className="tdEach" title="These steps run once per task on the plan">
                ↻ per task{run.card.tasks.length ? ` ×${run.card.tasks.length}` : ''}
              </span>
            )}
            <span className={`tdChip${s.agent === 'checks' ? ' sys' : ''}${state}`} title={`${s.id}${s.does ? ` — ${s.does}` : ''}`}>
              {state === ' done' ? <span className="tdTick" aria-hidden="true">✓</span> : <Mark color={w.color} />}
              {w.label}
              {widthOf(run, i) && <span className="m">{widthOf(run, i)}</span>}
            </span>
            {s.onFail && <span className="tdLoop" title={`a failure goes back to ${s.onFail.backTo}, at most ${s.onFail.max}×`}>↺≤{s.onFail.max}</span>}
          </span>
        )
      })}
    </span>
  )
}

export function TeamDock({ run, onDetails, onNavigate }: { run: TeamRunView; onDetails: () => void; onNavigate: (to: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = (path: string, body: unknown) => {
    setBusy(true)
    setError(null)
    call(path, body)
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(false))
  }
  const step = run.recipe.steps[run.step]
  const waiting = run.awaiting.map((id) => run.workers.find((w) => w.id === id)?.label).filter(Boolean)
  const task = run.task !== null && step?.forEach ? run.card.tasks[run.task] : undefined
  const needsYou = run.state === 'proposed' || run.state === 'gate' || run.state === 'paused' || !!run.revision

  let dot = 'live'
  let title: ReactNode = null
  let line: ReactNode = null
  let primary: ReactNode = null
  if (run.state === 'proposed') {
    dot = 'yellow'
    title = 'Run this team?'
    line = run.card.goal
    primary = (
      <button type="button" className="btn primary sm" disabled={busy} onClick={() => go('approve', { runId: run.id })}>
        {busy ? 'Starting…' : 'Approve & run'}
      </button>
    )
  } else if (run.revision) {
    dot = 'yellow'
    title = 'Plan change proposed'
    line = run.revision.why
    primary = (
      <>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={() => go('revision', { runId: run.id, accept: false })}>
          Turn down
        </button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={() => go('revision', { runId: run.id, accept: true })} title="Applies from the next task">
          Accept
        </button>
      </>
    )
  } else if (run.state === 'running') {
    title = task
      ? `Task ${run.task! + 1} of ${run.card.tasks.length} · ${step?.id ?? ''}`
      : `Step ${run.step + 1} of ${run.recipe.steps.length} · ${step?.id ?? ''}`
    line = run.splitting
      ? 'the lead is splitting this step'
      : step?.agent === 'checks'
        ? 'running the project’s checks'
        : waiting.length
          ? `${task ? `${task.title} · ` : ''}${waiting.join(', ')} ${waiting.length === 1 ? 'is' : 'are'} on it`
          : 'moving on'
  } else if (run.state === 'gate') {
    dot = 'yellow'
    title = 'Needs you'
    line = run.reason
    primary = (
      <button type="button" className="btn primary sm" disabled={busy} onClick={() => go('resume', { runId: run.id })}>
        Continue
      </button>
    )
  } else if (run.state === 'paused') {
    dot = 'yellow'
    title = 'Paused'
    line = run.reason
    primary = (
      <button type="button" className="btn sm" disabled={busy} onClick={() => go('resume', { runId: run.id })} title="Carry on — past the budget, it rises by half">
        Resume
      </button>
    )
  } else if (run.state === 'done') {
    dot = run.unresolved ? 'yellow' : 'green'
    title = `Team done · ${usd(run.spentUsd)}`
    line = run.unresolved ? `unresolved: ${run.unresolved}` : run.planArtifactId ? 'the outcome is on the plan' : 'the result is saved on the work item'
    // Runs from before plans saved their result as its own artifact.
    primary =
      !run.planArtifactId && run.resultArtifactId ? (
        <button type="button" className="btn sm" onClick={() => onNavigate(`/artifact/${run.resultArtifactId}`)}>
          Open the result
        </button>
      ) : null
  } else {
    dot = 'stone'
    title = `Team stopped · ${usd(run.spentUsd)}`
  }

  return (
    <div className={`teamDock${needsYou ? ' ask' : ''}`} role="region" aria-label="Team run">
      <div className="tdRow">
        <span className={`dot ${dot}`} aria-hidden="true" />
        <span className="tdTitle">{title}</span>
        {line && <span className="tdLine">{line}</span>}
        <span className="sp" />
        {run.planArtifactId && (
          <button type="button" className="btn sm ghost" onClick={() => onNavigate(`/artifact/${run.planArtifactId}`)} title="The plan — tasks, notes, decisions, progress; the outcome when it's done">
            Open plan
          </button>
        )}
        <button type="button" className="btn sm ghost" onClick={onDetails}>
          Details
        </button>
        {primary}
      </div>
      <div className="tdRow">
        <Flow run={run} />
        <span className="sp" />
        <span className="tdCap mono">{run.state === 'proposed' ? `cap ${usd(run.card.budgetUsd)}` : `${usd(run.spentUsd)} / ${usd(run.budgetUsd)}`}</span>
      </div>
      {error && <div className="tdErr" role="alert">{error}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The side drawer: everything, editable in place while the card is proposed
// ---------------------------------------------------------------------------

/** Reads as text; a click makes it a field; Enter or leaving it saves, Escape drops the change. */
function Editable({
  value,
  onCommit,
  placeholder,
  disabled,
  mono,
  multiline,
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  disabled?: boolean
  mono?: boolean
  multiline?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  const cancelled = useRef(false)
  useEffect(() => {
    if (!editing) setV(value)
  }, [value, editing])
  const cls = `edText${mono ? ' mono' : ''}`
  if (disabled) return <div className={cls}>{value || <span className="muted">{placeholder}</span>}</div>
  if (!editing)
    return (
      <button type="button" className={`${cls} on`} onClick={() => ((cancelled.current = false), setEditing(true))} title="Click to edit">
        {value || <span className="muted">{placeholder}</span>}
      </button>
    )
  return (
    <textarea
      autoFocus
      className={`edInput${mono ? ' mono' : ''}`}
      rows={multiline ? Math.min(6, Math.max(2, Math.ceil(v.length / 38))) : 1}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        setEditing(false)
        if (!cancelled.current && v.trim() !== value) onCommit(v.trim())
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/** A list of one-liners, each editable, with add and remove. */
function EditList({ items, onChange, disabled, add }: { items: string[]; onChange: (xs: string[]) => void; disabled: boolean; add: string }) {
  const [adding, setAdding] = useState(false)
  return (
    <ul className="edList">
      {items.map((x, i) => (
        <li key={`${i}:${x}`}>
          <Editable value={x} disabled={disabled} multiline onCommit={(v) => onChange(v ? items.map((y, n) => (n === i ? v : y)) : items.filter((_, n) => n !== i))} />
          {!disabled && (
            <button type="button" className="iconBtn edDel" aria-label="Remove" onClick={() => onChange(items.filter((_, n) => n !== i))}>
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
      {!disabled &&
        (adding ? (
          <li>
            <Editable value="" placeholder={add} multiline onCommit={(v) => (setAdding(false), v && onChange([...items, v]))} />
          </li>
        ) : (
          <li>
            <button type="button" className="edAdd" onClick={() => setAdding(true)}>
              <Plus size={11} aria-hidden="true" /> {add}
            </button>
          </li>
        ))}
    </ul>
  )
}

export function TeamSide({
  run,
  lead,
  models,
  onClose,
  onNavigate,
}: {
  run: TeamRunView
  /** only the lead's session edits and approves */
  lead: boolean
  models: ModelOption[]
  onClose: () => void
  onNavigate: (to: string) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [saveName, setSaveName] = useState<string | null>(null)
  const [allHandoffs, setAllHandoffs] = useState(false)
  // What you just saved, shown until the server's copy comes back — so an edit never flickers back.
  const [pending, setPending] = useState<TeamCard | null>(null)
  useEffect(() => setPending(null), [run.rev])
  const card = pending ?? run.card
  const editable = lead && run.state === 'proposed'
  // Running, the plan stays yours to steer: tasks not yet started, and the decisions.
  const steerable = lead && run.state !== 'done' && run.state !== 'stopped'
  const savePlan = (patch: { tasks?: TeamCard['tasks']; decisions?: string[] }) => {
    if (editable) return save(patch)
    setPending({ ...card, ...patch })
    setError(null)
    teamsCall('PUT', 'plan', { runId: run.id, ...patch }).catch((err) => {
      setPending(null)
      setError(errText(err))
    })
  }
  const taskEditable = (id: string) => steerable && (run.state === 'proposed' || (run.tasks[id]?.status ?? 'todo') === 'todo')

  const save = (patch: Partial<TeamCard>) => {
    const next = { ...card, ...patch }
    setPending(next)
    setError(null)
    teamsCall('PUT', 'card', { runId: run.id, card: wireCard(next) }).catch((err) => {
      setPending(null)
      setError(errText(err))
    })
  }
  const saveStep = (id: string, patch: Partial<TeamCard['steps'][number]>) => save({ steps: card.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const saveSlice = (id: string, slices: Slice[], n: number, patch: Partial<Slice>) =>
    saveStep(id, { slices: slices.map((x, k) => (k === n ? { ...x, ...patch } : x)).filter((x) => x.title) })
  const act = (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    setError(null)
    fn()
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(null))
  }
  const saveAs = () => saveName?.trim() && act('save', () => call('save-as', { runId: run.id, label: saveName }).then(() => setSaveName(null)))
  const at = run.state === 'done' ? run.recipe.steps.length : run.step
  const handoffs = allHandoffs ? run.outputs : run.outputs.slice(-6)

  return (
    <aside className="teamSide" aria-label="Team run details">
      <header className="tsHead">
        <span className="t">Team · {run.recipe.label}</span>
        <span className="k">{run.team ? `teams/${run.team}.md` : 'drafted for this run'}</span>
        <span className="sp" />
        {run.planArtifactId && (
          <button type="button" className="btn xs ghost" onClick={() => onNavigate(`/artifact/${run.planArtifactId}`)}>
            Open plan
          </button>
        )}
        <button type="button" className="iconBtn" aria-label="Close details" title="Close (the card stays above the composer)" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      <div className="tsBody">
        {card.note && <p className="tsNote">{card.note}</p>}

        <section className="tsSec">
          <div className="tsK">goal</div>
          <Editable value={card.goal} disabled={!editable} multiline onCommit={(v) => v && save({ goal: v })} />
        </section>
        <section className="tsSec">
          <div className="tsK">done when</div>
          <EditList items={card.criteria} disabled={!editable} add="add a check" onChange={(criteria) => criteria.length && save({ criteria })} />
        </section>
        <section className="tsSec">
          <div className="tsK">out of scope</div>
          {card.outOfScope.length || editable ? (
            <EditList items={card.outOfScope} disabled={!editable} add="add" onChange={(outOfScope) => save({ outOfScope })} />
          ) : (
            <div className="edText muted">nothing listed</div>
          )}
        </section>

        {(card.tasks.length > 0 || run.recipe.steps.some((s) => s.forEach)) && (
          <section className="tsSec">
            <div className="tsK">tasks{run.state !== 'proposed' ? ` · ${card.tasks.filter((t) => run.tasks[t.id]?.status === 'done').length} of ${card.tasks.length} done` : ''}</div>
            <ol className="tsTasks">
              {card.tasks.map((t) => {
                const st = run.tasks[t.id] ?? { status: 'todo', round: 0 }
                const can = taskEditable(t.id)
                const set = (patch: Partial<typeof t>) => savePlan({ tasks: card.tasks.map((x) => (x.id === t.id ? { ...x, ...patch } : x)) })
                return (
                  <li key={t.id} className={`tsTask ${st.status}`}>
                    <span className="tsMark" title={st.status}>
                      {st.status === 'done' ? '✓' : st.status === 'unresolved' ? '!' : st.status === 'running' ? '' : ''}
                      {st.status === 'running' && <span className="dot live" aria-hidden="true" />}
                    </span>
                    <div className="tsTaskMain">
                      <div className="tsTaskHead">
                        <span className="tsId mono">{t.id}</span>
                        <Editable value={t.title} disabled={!can} onCommit={(v) => v && set({ title: v })} />
                        {can && card.tasks.length > 1 && (
                          <button type="button" className="iconBtn edDel" aria-label={`Remove ${t.id}`} onClick={() => savePlan({ tasks: card.tasks.filter((x) => x.id !== t.id) })}>
                            <X size={12} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      {(t.criteria.length > 0 || can) && <EditList items={t.criteria} disabled={!can} add="add a check" onChange={(criteria) => set({ criteria })} />}
                      {st.status === 'running' && st.round > 0 && <div className="tsMeta">fix round {st.round}</div>}
                      {st.status === 'unresolved' && st.why && <div className="tsMeta warn">{st.why}</div>}
                    </div>
                  </li>
                )
              })}
            </ol>
            {steerable && card.tasks.length < 8 && (
              <button type="button" className="edAdd" onClick={() => savePlan({ tasks: [...card.tasks, { id: '', title: `New task ${card.tasks.length + 1}`, criteria: [] }] })}>
                <Plus size={11} aria-hidden="true" /> add a task
              </button>
            )}
            {run.state !== 'proposed' && steerable && <div className="tsMeta">Changes land between tasks; a task that has started stays as it is.</div>}
          </section>
        )}

        {run.revision && (
          <section className="tsSec tsRevision">
            <div className="tsK">the lead proposes a change</div>
            <div className="edText">{run.revision.why}</div>
            <ol className="tsTasks">
              {run.revision.tasks.map((t) => (
                <li key={t.id} className="tsTask todo">
                  <span className="tsMark" />
                  <div className="tsTaskMain">
                    <div className="tsTaskHead">
                      <span className="tsId mono">{t.id}</span>
                      <span className="edText">{t.title}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {lead && (
              <div className="tsRevActs">
                <button type="button" className="btn sm ghost" onClick={() => act('revision', () => call('revision', { runId: run.id, accept: false }))}>
                  Turn down
                </button>
                <button type="button" className="btn sm" onClick={() => act('revision', () => call('revision', { runId: run.id, accept: true }))}>
                  Accept
                </button>
              </div>
            )}
          </section>
        )}

        {(card.decisions.length > 0 || steerable) && (
          <section className="tsSec">
            <div className="tsK">decisions · every agent reads these</div>
            <EditList items={card.decisions} disabled={!steerable} add="add a decision" onChange={(decisions) => savePlan({ decisions })} />
          </section>
        )}

        {run.notes.length > 0 && (
          <section className="tsSec">
            <div className="tsK">notes for whoever builds next</div>
            <ul className="tsNotes">
              {run.notes.map((n, i) => (
                <li key={i}>
                  {n.task && <span className="tsId mono">{n.task}</span>} {n.text}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="tsSec">
          <div className="tsK">steps</div>
          <ol className="tsSteps">
            {run.recipe.steps.map((s, i) => {
              const w = who(run, s.agent)
              const c = card.steps.find((x) => x.id === s.id) ?? { id: s.id, model: null, slices: null }
              const state = run.state === 'proposed' ? '' : i < at ? 'done' : i === at ? 'on' : 'todo'
              const own = s.agent === 'lead' || s.agent === 'checks' ? null : run.agents.find((a) => a.name === s.agent)?.model ?? null
              const fallback = s.model ?? own
              const sliceable = leadSlices(run.recipe, i)
              const slices = c.slices ?? []
              const workers = run.workers.filter((x) => x.stepId === s.id)
              return (
                <li key={s.id} className={`tsStep ${state}`}>
                  <span className="tsNode" aria-hidden="true">
                    {state === 'done' ? '✓' : i + 1}
                  </span>
                  <div className="tsStepMain">
                    <div className="tsStepHead">
                      <span className="tsId mono">{s.forEach ? `↻ ${s.id}` : s.id}</span>
                      <Mark color={w.color} />
                      <span className="tsWho">{w.label}</span>
                      {widthOf(run, i) && <span className="tsMeta mono">{widthOf(run, i)}</span>}
                      {s.output && <span className="tsMeta mono">→ {s.output}</span>}
                    </div>
                    {s.does && <div className="tsDoes">{s.does}</div>}
                    {(s.onFail || s.gate) && (
                      <div className="tsMeta">
                        {s.onFail && `a failure goes back to ${s.onFail.backTo}, at most ${s.onFail.max}×`}
                        {s.onFail && s.gate && ' · '}
                        {s.gate && 'waits for you after'}
                      </div>
                    )}
                    {s.agent !== 'checks' &&
                      (editable ? (
                        <Select className="teamSel tsModel" aria-label={`Model for ${s.id}`} value={c.model ?? ''} onValueChange={(v) => saveStep(s.id, { model: v || null })}>
                          <SelectItem value="">{fallback ? `Default · ${findModel(models, fallback)?.name ?? fallback}` : s.agent === 'lead' ? 'Default · the lead’s own' : 'Default'}</SelectItem>
                          {models.map((m) => (
                            <SelectItem key={m.id} value={m.id} description={m.description}>
                              {m.name}
                            </SelectItem>
                          ))}
                        </Select>
                      ) : (
                        <div className="tsMeta mono">{findModel(models, c.model ?? fallback ?? '')?.name ?? c.model ?? fallback ?? 'default model'}</div>
                      ))}
                    {s.fanOut && sliceable && (editable || slices.length > 0) && (
                      <div className="tsSlices">
                        <div className="tsMeta">{slices.length ? `split by ${s.fanOut.by}` : `the lead splits by ${s.fanOut.by} when the step starts`}</div>
                        {slices.map((x, n) => (
                          <div key={n} className="tsSlice">
                            <div className="tsSliceText">
                              <Editable value={x.title} disabled={!editable} placeholder={s.fanOut!.by} onCommit={(v) => saveSlice(s.id, slices, n, { title: v })} />
                              <Editable value={x.brief} disabled={!editable} multiline placeholder="what this worker looks at" onCommit={(v) => saveSlice(s.id, slices, n, { brief: v })} />
                            </div>
                            {editable && (
                              <button type="button" className="iconBtn edDel" aria-label={`Remove ${x.title}`} onClick={() => saveStep(s.id, { slices: slices.length > 1 ? slices.filter((_, k) => k !== n) : null })}>
                                <X size={12} aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        ))}
                        {editable && slices.length < s.fanOut.max && (
                          <button type="button" className="edAdd" onClick={() => saveStep(s.id, { slices: [...slices, { title: `${s.fanOut!.by} ${slices.length + 1}`, brief: '' }] })}>
                            <Plus size={11} aria-hidden="true" /> {s.fanOut.by}
                          </button>
                        )}
                      </div>
                    )}
                    {s.fanOut && !sliceable && <div className="tsMeta">{s.fanOut.by === 'finding' ? 'triage splits the findings' : `same slices as ${run.recipe.steps[i - 1]?.id}`}</div>}
                    {workers.length > 0 && run.state !== 'proposed' && (
                      <div className="tsWorkers">
                        {workers.map((x) => (
                          <button key={x.id} type="button" className="tsWorker" disabled={!x.sessionId} onClick={() => x.sessionId && onNavigate(x.sessionId)}>
                            {run.awaiting.includes(x.id) && <span className="dot live" aria-label="working" />}
                            {x.label}
                            {x.sessionId && run.spend[x.sessionId] ? <span className="mono">{usd(run.spend[x.sessionId])}</span> : null}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </section>

        <section className="tsSec">
          <div className="tsK">budget</div>
          {editable ? (
            <div className="tsBudget">
              <span className="mono">$</span>
              <Editable value={String(card.budgetUsd)} mono onCommit={(v) => Number(v) > 0 && save({ budgetUsd: Number(v) })} />
              <span className="muted">cap · the run pauses there</span>
            </div>
          ) : (
            <div className="edText mono">
              {usd(run.spentUsd)} <span className="muted">of {usd(run.budgetUsd)}</span>
            </div>
          )}
        </section>

        {run.unresolved && <div className="teamUnresolved">Unresolved: {run.unresolved}</div>}

        {run.outputs.length > 0 && (
          <section className="tsSec">
            <div className="tsK">handoffs · {run.outputs.length}</div>
            <ol className="hoList">
              {!allHandoffs && run.outputs.length > handoffs.length && (
                <li>
                  <button type="button" className="btn xs ghost" onClick={() => setAllHandoffs(true)}>
                    Show all {run.outputs.length}
                  </button>
                </li>
              )}
              {handoffs.map((h) => (
                <HandoffRow key={h.id} h={h} />
              ))}
            </ol>
          </section>
        )}
      </div>

      {error && (
        <div className="tdErr tsErr" role="alert">
          {error}
        </div>
      )}
      <footer className="tsFoot">
        {saveName === null ? (
          <button type="button" className="btn sm ghost" onClick={() => setSaveName(`${run.recipe.label} (custom)`)} title="Keep this shape — steps, models, widths, budget — as a new team file">
            Save as team
          </button>
        ) : (
          <span className="teamSaveInline">
            <input
              className="teamInp"
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveAs()
                if (e.key === 'Escape') setSaveName(null)
              }}
              aria-label="New team's name"
            />
            <button type="button" className="btn sm" disabled={!saveName.trim() || !!busy} onClick={saveAs}>
              Save
            </button>
          </span>
        )}
        <span className="sp" />
        {editable && (
          <>
            <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => act('discard', () => call('discard', { runId: run.id }))}>
              Discard
            </button>
            <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => act('approve', () => call('approve', { runId: run.id }))}>
              {busy === 'approve' ? 'Starting…' : 'Approve & run'}
            </button>
          </>
        )}
      </footer>
    </aside>
  )
}

/** One handoff as one line; open it for the full text. */
function HandoffRow({ h }: { h: Handoff }) {
  const [open, setOpen] = useState(false)
  const full = h.body || h.findings?.length || h.files?.length
  return (
    <li className="hoRow">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="hoLine" disabled={!full}>
          <ChevronRight size={12} className={`hoCaret${open ? ' on' : ''}${full ? '' : ' none'}`} aria-hidden="true" />
          <span className="hoStep mono">
            {h.stepId}
            {h.round ? ` · fix ${h.round}` : ''}
          </span>
          <span className="hoWho">{h.label}</span>
          {h.verdict && <span className={`hoVerdict ${h.verdict}`}>{h.verdict}</span>}
          <span className="hoSum">{h.summary}</span>
        </Collapsible.Trigger>
        <Collapsible.Content className="hoBody">
          {h.body && <pre className="hoText">{h.body}</pre>}
          {h.findings?.length ? (
            <ol className="hoFindings">
              {h.findings.map((f, i) => (
                <li key={i}>
                  <span className={`hoSev ${f.severity}`}>{f.severity}</span> <span className="mono">{f.where}</span> — {f.problem}
                  <div className="hoFix">Fix: {f.fix}</div>
                </li>
              ))}
            </ol>
          ) : null}
          {h.files?.length ? <div className="hoFiles mono">{h.files.join(' · ')}</div> : null}
        </Collapsible.Content>
      </Collapsible.Root>
    </li>
  )
}
