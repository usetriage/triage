/**
 * The watch form, as a page (#/watches/new, #/watches/<id>/edit), in two
 * steps. Details: a name, the instructions (where to look and what counts),
 * the project folder every run works in, the integrations and tools the run
 * may use (watch-spec.md, items 1–2), output, model, a schedule, and run
 * limits (item 3). Preview: a dry run of exactly that — the transcript streams in as
 * it happens, and at the end the item(s) it would have filed. Nothing is
 * saved by the preview; Create is the only write.
 */
import * as Collapsible from '@radix-ui/react-collapsible'
import * as Checkbox from '@radix-ui/react-checkbox'
import { Check, ChevronDown, ChevronRight, Clock } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  Project,
  ProjectsResponse,
  SettingsResponse,
  Watch,
  WatchNotify,
  WatchOutput,
  WatchToolGrant,
  WatchPreviewResult,
  WatchPreviewStartResponse,
  WatchPreviewStatusResponse,
  WatchesResponse,
} from '../../../shared/protocol.js'
import { describeCron, isValidCron } from '../../../core/watch/cron.js'
import { defaultCatchUp, humanSpan, lookbackMs } from '../../../core/watch/schedule.js'
import { builtinGrant, hasBuiltin } from '../../../core/watch/tools.js'
import { useEvents } from '../hooks.js'
import { relTime } from '../itemUi.js'
import { useModels } from '../models.js'
import { store } from '../store.js'
import { projectColor } from '../tabs.js'
import { Select, SelectItem } from '../ui/Select.js'
import { ProjectIdPicker } from './ProjectPicker.js'
import { Markdown } from './Markdown.js'
import { Transcript } from './Transcript.js'
import { OUTPUTS, PRESETS, cronToPreset, presetToCron, type SchedulePreset } from '../watchUi.js'
import { WatchToolPicker } from './WatchToolPicker.js'

// Inbox thumbs-down → refine: the correction is appended to the instructions
// so the rule stays human-readable. sessionStorage survives the hash change.
export const REFINE_WATCH_KEY = 'triage.watch.refine'

type Form = {
  title: string
  instruction: string
  tools: WatchToolGrant[]
  projectId: string
  /** '' = Claude Code's default */
  model: string
  output: WatchOutput
  preset: SchedulePreset
  time: string
  cron: string
  /** '' = the default for the output */
  catchUp: string
  /** minutes; '' = the workspace default */
  timeoutMin: string
  /** dollars; '' = the workspace default */
  budget: string
  notify: WatchNotify
  /** create only: run once as soon as it's saved */
  runOnceNow: boolean
}

const EMPTY: Form = {
  title: '',
  instruction: '',
  tools: [builtinGrant('web')],
  projectId: '',
  model: '',
  output: 'items',
  preset: 'daily',
  time: '09:00',
  cron: '0 9 * * *',
  catchUp: '',
  timeoutMin: '',
  budget: '',
  notify: 'on_failure',
  runOnceNow: true,
}

const CATCH_UPS: Array<{ id: string; label: string }> = [
  { id: '', label: 'Default' },
  { id: 'unlimited', label: 'Always' },
  { id: '6h', label: 'Within 6h' },
  { id: '1h', label: 'Within 1h' },
  { id: 'never', label: 'Never' },
]
const NOTIFY: Array<{ id: WatchNotify; label: string }> = [
  { id: 'on_failure', label: 'On failure' },
  { id: 'always', label: 'Always' },
  { id: 'never', label: 'Never' },
]

function formFrom(w: Watch): Form {
  const { preset, time } = cronToPreset(w.schedule)
  return {
    title: w.title,
    instruction: w.instruction,
    tools: w.tools,
    projectId: w.projectId ?? '',
    model: w.model ?? '',
    output: w.output,
    preset,
    time,
    cron: w.schedule,
    catchUp: w.catchUpWindow ?? '',
    timeoutMin: w.timeoutMs ? String(Math.round(w.timeoutMs / 60_000)) : '',
    budget: w.maxBudgetUsd != null ? String(w.maxBudgetUsd) : '',
    notify: w.notify,
    runOnceNow: false,
  }
}

type Step = 'details' | 'preview'

type Preview =
  | { phase: 'idle' }
  | { phase: 'running'; id: string; sig: string }
  | { phase: 'ready'; id: string; sig: string; result: WatchPreviewResult }
  | { phase: 'failed'; id: string; sig: string; message: string }

export function WatchFormPage({ id, onNavigate }: { id: string | null; onNavigate: (hash: string) => void }) {
  const [form, setForm] = useState<Form>(EMPTY)
  const [loaded, setLoaded] = useState(id === null)
  const [projects, setProjects] = useState<Project[]>([])
  const models = useModels()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState<Step>('details')
  const [preview, setPreview] = useState<Preview>({ phase: 'idle' })
  const [configError, setConfigError] = useState('')
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [defaults, setDefaults] = useState<{ timeoutMs: number; budget: number | null }>({ timeoutMs: 240_000, budget: null })

  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => setProjects(b.ok ? b.projects : []))
      .catch(() => setProjects([]))
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<SettingsResponse>)
      .then((b) => b.ok && setDefaults({ timeoutMs: b.settings.watchTimeoutMs, budget: b.settings.watchBudgetUsd }))
      .catch(() => {})
  }, [id])

  useEffect(() => {
    if (id === null) return
    void fetch('/api/watches')
      .then((r) => r.json() as Promise<WatchesResponse>)
      .then((b) => {
        const w = b.ok ? b.watches.find((x) => x.id === id) : undefined
        if (!w) {
          setError('unknown watch')
          setLoaded(true)
          return
        }
        const f = formFrom(w)
        setConfigError(w.configError ?? '')
        const raw = sessionStorage.getItem(REFINE_WATCH_KEY)
        if (raw) {
          sessionStorage.removeItem(REFINE_WATCH_KEY)
          try {
            const { watchId, note } = JSON.parse(raw) as { watchId: string; note: string }
            if (watchId === id) f.instruction = `${f.instruction}\nNot: things like “${note}”.`
          } catch {
            // stale handoff — ignore
          }
        }
        setForm(f)
        setLoaded(true)
      })
      .catch((err) => {
        setError(String(err))
        setLoaded(true)
      })
  }, [id])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))

  // The schedule the form will save: presets render to cron; custom is typed.
  const cron = useMemo(() => (form.preset === 'custom' ? form.cron.trim() : presetToCron(form.preset, form.time)), [form.preset, form.time, form.cron])
  const cronOk = isValidCron(cron)

  const timeoutMs = form.timeoutMin.trim() ? Math.round(Number(form.timeoutMin) * 60_000) : null
  const budget = form.budget.trim() ? Number(form.budget) : null
  const limitsOk =
    (timeoutMs === null || (Number.isFinite(timeoutMs) && timeoutMs >= 30_000 && timeoutMs <= 3_600_000)) &&
    (budget === null || (Number.isFinite(budget) && budget > 0 && budget <= 100))
  const complete = Boolean(form.title.trim() && form.instruction.trim() && form.tools.length > 0 && form.projectId && cronOk && limitsOk)
  // The instructions talk about the web but the run would have no web tools.
  const wantsWeb = /\b(news|web|google|internet|online|website|blog|article|search the)\b/i.test(form.instruction) && !hasBuiltin(form.tools, 'web')
  const lookback = cronOk ? humanSpan(lookbackMs(cron, Date.now())) : null

  async function save() {
    setSaving(true)
    setError('')
    try {
      const payload = {
        title: form.title.trim(),
        instruction: form.instruction.trim(),
        tools: form.tools,
        projectId: form.projectId,
        model: form.model || null,
        output: form.output,
        schedule: cron,
        catchUpWindow: form.catchUp || null,
        timeoutMs,
        maxBudgetUsd: budget,
        notify: form.notify,
        ...(id ? {} : { runOnceNow: form.runOnceNow }),
      }
      const res = await fetch(id ? `/api/watches?id=${encodeURIComponent(id)}` : '/api/watches', {
        method: id ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as WatchesResponse
      if (!body.ok) throw new Error(body.error)
      onNavigate('/watches')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // The dry run depends on these fields; a change after previewing marks the
  // result stale so the user knows the transcript no longer matches the form.
  const previewSig = JSON.stringify([form.instruction.trim(), form.tools, form.projectId, form.model, form.output, cron])
  const canPreview = Boolean(form.instruction.trim()) && form.tools.length > 0 && Boolean(form.projectId)

  async function startPreview() {
    setError('')
    setStep('preview')
    try {
      const res = await fetch('/api/watches/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instruction: form.instruction.trim(),
          tools: form.tools,
          projectId: form.projectId,
          model: form.model || null,
          output: form.output,
          schedule: cronOk ? cron : undefined,
        }),
      })
      const body = (await res.json()) as WatchPreviewStartResponse
      if (!body.ok) throw new Error(body.error)
      store.subscribeSession(body.previewId)
      setPreview({ phase: 'running', id: body.previewId, sig: previewSig })
    } catch (err) {
      setPreview({ phase: 'failed', id: '', sig: previewSig, message: err instanceof Error ? err.message : String(err) })
    }
  }

  // Poll the outcome while the run streams; the transcript arrives over the socket.
  useEffect(() => {
    if (preview.phase !== 'running') return
    const { id: pid, sig } = preview
    let live = true
    const tick = async () => {
      try {
        const res = await fetch(`/api/watches/preview?id=${encodeURIComponent(pid)}`)
        const body = (await res.json()) as WatchPreviewStatusResponse
        if (!live) return
        if (!body.ok) setPreview({ phase: 'failed', id: pid, sig, message: body.error })
        else if (body.status === 'ready' && body.result) setPreview({ phase: 'ready', id: pid, sig, result: body.result })
        else if (body.status === 'failed') setPreview({ phase: 'failed', id: pid, sig, message: body.error ?? 'the preview failed' })
      } catch {
        // transient — try again next tick
      }
    }
    const t = setInterval(() => void tick(), 1500)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [preview])

  const project = projects.find((p) => p.id === form.projectId)
  const stale = preview.phase !== 'idle' && preview.sig !== previewSig

  return (
    <div className="page">
      <div className="glow blue" aria-hidden="true" />
      <div className={`inner wform${step === 'preview' ? ' wide' : ''}`}>
        <div className="crumbs">
          <button type="button" className="crumb link" onClick={() => onNavigate('/watches')}>
            Watches
          </button>
          <span className="crumbSep">›</span>
          <span className="crumb now">{id ? 'Edit watch' : 'New watch'}</span>
        </div>

        <div className="steps" aria-label="Steps">
          <span className={`step${step === 'details' ? ' now' : ' done'}`}>
            <span className="n">{step === 'details' ? '1' : <Check size={10} aria-hidden="true" />}</span>Details
          </span>
          <span className="sep">›</span>
          <span className={`step${step === 'preview' ? ' now' : ''}`}>
            <span className="n">2</span>Preview
          </span>
        </div>

        {!loaded ? (
          <div className="probing">
            <span className="pip" /> Loading…
          </div>
        ) : step === 'details' ? (
          <>
            <div className="field">
              <label htmlFor="wf-title">Name</label>
              <input id="wf-title" autoFocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Quick wins for PX" />
            </div>

            <div className="field">
              <label htmlFor="wf-instr">
                Instructions <span className="hint">· where to look and what counts. The run finds teams, channels and labels itself.</span>
              </label>
              <textarea
                id="wf-instr"
                value={form.instruction}
                onChange={(e) => set('instruction', e.target.value)}
                placeholder="Look through the PX team’s open Linear issues. I want small bugs or feature requests I could turn into one short PR. Skip epics and anything already assigned."
              />
            </div>

            <div className="field">
              <label htmlFor="wf-project">
                Project <span className="hint">· where the run works. It can read files here and nowhere else.</span>
              </label>
              <ProjectIdPicker projects={projects} value={form.projectId} allowNone={false} onChange={(v) => v && set('projectId', v)}>
                {(current) => (
                  <button type="button" id="wf-project" className="wformSelect" aria-label="Project">
                    {current && (
                      <span className="pdot" style={{ background: projectColor(current.path) }} aria-hidden="true" />
                    )}
                    <span className="val">{current?.name ?? 'Pick a project'}</span>
                    <ChevronDown className="caret" size={14} aria-hidden="true" />
                  </button>
                )}
              </ProjectIdPicker>
              {project && <span className="hint mono">{project.path}</span>}
              {projects.length === 0 && (
                <span className="hint">
                  A watch runs in a project folder. <a href="#/settings/projects">Add a project in Settings → Projects</a> first.
                </span>
              )}
              {configError && <span className="formError">{configError}</span>}
            </div>

            <div className="field">
              <label>
                Integrations <span className="hint">· the run only has these tools</span>
              </label>
              {form.projectId ? (
                <WatchToolPicker projectId={form.projectId} value={form.tools} onChange={(t) => set('tools', t)} />
              ) : (
                <span className="hint">Pick a project first — which MCP servers load depends on its folder.</span>
              )}
              {wantsWeb && <span className="hint">This sounds like a web search. Tick Web, or the run can only look in the integrations above.</span>}
            </div>

            <div className="field">
              <label>
                Output <span className="hint">· what a run produces</span>
              </label>
              <div className="seg" role="radiogroup" aria-label="Output">
                {OUTPUTS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={form.output === o.id}
                    className={`segBtn${form.output === o.id ? ' active' : ''}`}
                    onClick={() => set('output', o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <span className="hint">{OUTPUTS.find((o) => o.id === form.output)?.hint}</span>
            </div>

            <div className="field">
              <label htmlFor="wf-model">
                Model <span className="hint">· the model each run uses</span>
              </label>
              <Select
                id="wf-model"
                className="wformSelect"
                aria-label="Model"
                value={form.model}
                onValueChange={(v) => set('model', v)}
              >
                <SelectItem value="">Default (Claude Code’s choice)</SelectItem>
                {models
                  .filter((m) => m.id !== 'default')
                  .map((m) => (
                    <SelectItem key={m.id} value={m.id} description={m.description}>
                      {m.name}
                    </SelectItem>
                  ))}
                {/* A model saved earlier that the probe no longer lists still has
                    to render, or the field would silently blank itself. */}
                {form.model && !models.some((m) => m.id === form.model) && (
                  <SelectItem value={form.model}>{form.model}</SelectItem>
                )}
              </Select>
            </div>

            <div className="field">
              <label>Schedule</label>
              <div className="card schedCard">
                <div className="line">
                  <Clock size={13} aria-hidden="true" />
                  <span>{cronOk ? describeCron(cron) : 'Not a valid schedule'}</span>
                  <span className="cron">{cron}</span>
                </div>
                <div className="ctl">
                  <div className="seg" role="radiogroup" aria-label="Frequency">
                    {PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={form.preset === p.id}
                        className={`segBtn${form.preset === p.id ? ' active' : ''}`}
                        onClick={() => set('preset', p.id)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {form.preset === 'custom' ? (
                    <input className="cronIn" value={form.cron} onChange={(e) => set('cron', e.target.value)} placeholder="*/30 * * * *" aria-label="Cron expression" />
                  ) : form.preset === 'hourly' ? null : (
                    <>
                      <span className="hint">at</span>
                      <input className="time" type="time" value={form.time} onChange={(e) => set('time', e.target.value)} aria-label="Time" />
                    </>
                  )}
                </div>
                <span className="hint">
                  Each run looks back {lookback ? `about ${lookback}` : 'two schedule periods'} unless your instructions say otherwise. Missed slots run once on wake.
                </span>
              </div>
            </div>

            <Collapsible.Root open={limitsOpen} onOpenChange={setLimitsOpen} className="card limitsCard">
              <Collapsible.Trigger asChild>
                <button type="button" className="limitsHead">
                  <ChevronRight size={13} aria-hidden="true" className={limitsOpen ? 'rot' : undefined} />
                  Catch-up, limits and notifications
                  <span className="m">
                    {form.catchUp || `catch-up ${defaultCatchUp(form.output) === 'unlimited' ? 'always' : 'within 6h'}`} ·{' '}
                    {timeoutMs ? humanSpan(timeoutMs) : humanSpan(defaults.timeoutMs)} · {budget != null ? `$${budget}` : defaults.budget != null ? `$${defaults.budget}` : 'no cap'}
                  </span>
                </button>
              </Collapsible.Trigger>
              <Collapsible.Content className="limitsBody">
                <label>Missed slots</label>
                <div className="ctl">
                  <div className="seg" role="radiogroup" aria-label="Catch-up window">
                    {CATCH_UPS.map((c) => (
                      <button key={c.id} type="button" role="radio" aria-checked={form.catchUp === c.id} className={`segBtn${form.catchUp === c.id ? ' active' : ''}`} onClick={() => set('catchUp', c.id)}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <span className="hint">
                    {form.catchUp === ''
                      ? form.output === 'digest'
                        ? 'Digests skip a slot missed by more than 6h.'
                        : 'Item watches always catch up once on wake.'
                      : form.catchUp === 'never'
                        ? 'Only on-time slots run.'
                        : form.catchUp === 'unlimited'
                          ? 'A missed slot always runs once on wake.'
                          : `A slot missed by more than ${form.catchUp} is skipped.`}
                  </span>
                </div>
                <label htmlFor="wf-timeout">Timeout</label>
                <div className="ctl">
                  <input id="wf-timeout" className="num" inputMode="numeric" value={form.timeoutMin} onChange={(e) => set('timeoutMin', e.target.value)} placeholder={String(Math.round(defaults.timeoutMs / 60_000))} />
                  <span className="hint">minutes · blank = workspace default</span>
                </div>
                <label htmlFor="wf-budget">Budget per run</label>
                <div className="ctl">
                  <input id="wf-budget" className="num" inputMode="decimal" value={form.budget} onChange={(e) => set('budget', e.target.value)} placeholder={defaults.budget != null ? String(defaults.budget) : 'none'} />
                  <span className="hint">dollars · the run stops when it hits the cap</span>
                </div>
                <label>Notify</label>
                <div className="ctl">
                  <div className="seg" role="radiogroup" aria-label="Notify">
                    {NOTIFY.map((n) => (
                      <button key={n.id} type="button" role="radio" aria-checked={form.notify === n.id} className={`segBtn${form.notify === n.id ? ' active' : ''}`} onClick={() => set('notify', n.id)}>
                        {n.label}
                      </button>
                    ))}
                  </div>
                  <span className="hint">a macOS notification</span>
                </div>
                {!limitsOk && <span className="formError" style={{ gridColumn: '1 / -1' }}>Timeout must be 1–60 minutes; budget $0.01–$100.</span>}
              </Collapsible.Content>
            </Collapsible.Root>

            {!id && (
              <label className="checkLine">
                <Checkbox.Root className="cbox" checked={form.runOnceNow} onCheckedChange={(v) => set('runOnceNow', v === true)}>
                  <Checkbox.Indicator>
                    <Check size={10} aria-hidden="true" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                Run once as soon as it’s created
              </label>
            )}

            {error && <div className="formError">{error}</div>}

            <div className="foot">
              <span className="hint">Next runs the watch once as a dry run, so you see what it would file before it exists.</span>
              <button type="button" className="btn outline" onClick={() => onNavigate('/watches')}>
                Cancel
              </button>
              <button type="button" className="btn ghost" disabled={!complete || saving} onClick={() => void save()} title="Skip the dry run">
                {saving ? 'Saving…' : id ? 'Save without preview' : 'Create without preview'}
              </button>
              <button type="button" className="btn primary" disabled={!canPreview} onClick={() => void startPreview()}>
                Next · Preview
              </button>
            </div>
          </>
        ) : (
          <PreviewStep
            preview={preview}
            stale={stale}
            title={form.title.trim() || 'Untitled watch'}
            onBack={() => setStep('details')}
            onAgain={() => void startPreview()}
            onSave={() => void save()}
            saving={saving}
            complete={complete}
            saveLabel={id ? 'Save changes' : 'Create watch'}
            error={error}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — the dry run. Transcript first (it is the proof), the would-be
// item(s) once the run ends (they are the payoff). The transcript is the same
// component the session page uses, fed by the ephemeral session's events.
// ---------------------------------------------------------------------------

function PreviewStep({
  preview,
  stale,
  title,
  onBack,
  onAgain,
  onSave,
  saving,
  complete,
  saveLabel,
  error,
}: {
  preview: Preview
  stale: boolean
  title: string
  onBack: () => void
  onAgain: () => void
  onSave: () => void
  saving: boolean
  complete: boolean
  saveLabel: string
  error: string
}) {
  const sessionId = preview.phase === 'idle' || !preview.id ? null : preview.id
  const events = useEvents(sessionId)
  const running = preview.phase === 'running'
  const result = preview.phase === 'ready' ? preview.result : null

  const status =
    preview.phase === 'running' ? (
      <>
        <span className="dot blue live" /> Dry run of <b>{title}</b> in progress · nothing is saved
      </>
    ) : preview.phase === 'ready' ? (
      <>
        <span className="dot green" /> Dry run finished · nothing was saved
      </>
    ) : preview.phase === 'failed' ? (
      <>
        <span className="dot red" /> Dry run failed · {preview.message}
      </>
    ) : null

  return (
    <>
      <div className="previewStatus">
        {status}
        {stale && <span className="pill yellow">details changed since this run</span>}
        {result && (
          <span className="m">
            {fmtTok(result.tokens)} tok{result.costUsd != null ? ` · ${fmtUsd(result.costUsd)}` : ''} · {Math.round(result.durationMs / 1000)}s
          </span>
        )}
      </div>

      <div className="previewTranscript">
        {sessionId && events.length > 0 ? (
          <Transcript sessionId={sessionId} events={events} onRespond={() => {}} />
        ) : (
          <div className="waiting">{running ? 'Starting the run…' : 'No transcript.'}</div>
        )}
      </div>

      {result && <PreviewCard result={result} />}

      {error && <div className="formError">{error}</div>}

      <div className="foot">
        <span className="hint">{result ? 'Happy with it? Create the watch and its first real run starts from now.' : 'You can create the watch while the dry run is still going.'}</span>
        <button type="button" className="btn outline" onClick={onBack}>
          Back to details
        </button>
        <button type="button" className="btn" disabled={running} onClick={onAgain}>
          Preview again
        </button>
        <button type="button" className="btn primary" disabled={!complete || saving} onClick={onSave}>
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
    </>
  )
}

const fmtTok = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`)
const fmtUsd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)

/** What the run would have produced, rendered the way the inbox or the item page will show it. */
function PreviewCard({ result }: { result: WatchPreviewResult }) {
  return (
    <div className="card previewCard" aria-live="polite">
      <div className="head">
        <span className="t">
          {result.output === 'digest'
            ? result.digest
              ? `Would write: ${result.digest.title}`
              : 'Would write nothing — the run found nothing new'
            : result.rows.length === 0
              ? 'Would file nothing — looked, found no match'
              : `Would file ${result.rows.length} work item${result.rows.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {result.output === 'digest' ? (
        result.digest ? (
          <div className="digest">
            <div className="md">
              <Markdown text={result.digest.body} />
            </div>
          </div>
        ) : (
          <div className="empty">Nothing to show. Widen the instructions or the window if you expected something.</div>
        )
      ) : result.rows.length === 0 ? (
        <div className="empty">Nothing to show. If you expected matches, loosen the instructions and preview again.</div>
      ) : (
        result.rows.map((r) => (
          <div key={r.id} className="previewRow">
            <span className="t">
              <a href={r.url} target="_blank" rel="noreferrer">
                {r.title}
              </a>
              {r.place && <span className="place">{r.place}</span>}
            </span>
            <span className="when">{relTime(r.lastActivity)}</span>
            <span className="why">{r.why}</span>
          </div>
        ))
      )}
      <div className="foot">These were not created. The real run files them once the watch exists.</div>
    </div>
  )
}
