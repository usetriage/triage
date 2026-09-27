import * as Tabs from '@radix-ui/react-tabs'
import { useEffect, useState } from 'react'
import type { SessionSummary, TeamRunDetail, TeamRunResponse, TeamStage, TeamStep } from '../../../shared/protocol.js'
import { AGENT_HEX, teamsCall, usd } from '../teams.js'

type Props = {
  /** the team's member sessions, roster order */
  members: SessionSummary[]
  currentId: string
  modelName: (s: SessionSummary) => string | undefined
  onOpen: (sessionId: string) => void
}

/**
 * The team a session belongs to, as a row of tabs over the transcript. Each tab
 * is a member session — switching opens that member's own transcript and
 * composer. The right end is the run: what it has spent against its budget,
 * and the controls that stop it spending (.docs/teams-cost.md).
 */
export function TeamStrip({ members, currentId, modelName, onOpen }: Props) {
  const run = members[0]?.team?.run
  const teamId = members[0]?.team?.id
  const [busy, setBusy] = useState(false)
  const act = (path: 'pause' | 'resume' | 'stop') => {
    if (!teamId) return
    setBusy(true)
    void teamsCall('POST', path, { teamId })
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  const pct = run ? Math.min(100, (run.spentUsd / Math.max(0.01, run.budgetUsd)) * 100) : 0

  return (
    <>
    <Tabs.Root value={currentId} onValueChange={onOpen} activationMode="manual">
      <Tabs.List id="teamStrip" aria-label="Team members">
        <span className="teamLabel">Team</span>
        {members.map((s) => {
          const t = s.team!
          const busyTab = s.status === 'running' || s.status === 'starting'
          const state = s.waiting ? 'needs you' : busyTab ? 'working' : s.status === 'error' ? 'error' : 'idle'
          const model = modelName(s)
          return (
            <Tabs.Trigger key={s.id} value={s.id} className="teamTab" title={`${t.label} — ${state}${model ? ` · ${model}` : ''} · ${usd(t.spentUsd)}`}>
              {t.color ? (
                <span className="swatch" style={{ background: AGENT_HEX[t.color] }} aria-hidden="true" />
              ) : (
                <span className="mgrGlyph" aria-hidden="true" />
              )}
              <span className="role">{t.label}</span>
              {model && <span className="model">{model}</span>}
              {t.spentUsd > 0 && <span className="spend">{usd(t.spentUsd)}</span>}
              {(s.waiting || busyTab) && (
                <span className="state">
                  <span className={`dot ${s.waiting ? 'yellow' : 'live'}`} aria-hidden="true" /> {state}
                </span>
              )}
              {s.status === 'error' && <span className="dot red" aria-label="error" />}
            </Tabs.Trigger>
          )
        })}
        {run && (
          <span className={`teamRun ${run.state}`}>
            <span className="teamMeter" title={`${usd(run.spentUsd)} of ${usd(run.budgetUsd)} budget`} aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="teamRunSpend">
              {usd(run.spentUsd)} <span className="of">/ {usd(run.budgetUsd)}</span>
            </span>
            {run.state === 'paused' && (
              <span className="teamRunWhy" title={run.reason}>
                paused
              </span>
            )}
            {run.state === 'stopped' && <span className="teamRunWhy">stopped</span>}
            {run.state === 'running' && (
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act('pause')} title="Stop every member now; resume later">
                Pause
              </button>
            )}
            {run.state === 'paused' && (
              <button type="button" className="btn sm" disabled={busy} onClick={() => act('resume')} title="Raise the budget by half and carry on">
                Resume
              </button>
            )}
            {(run.state === 'running' || run.state === 'paused') && (
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act('stop')} title="End the run">
                Stop
              </button>
            )}
          </span>
        )}
      </Tabs.List>
    </Tabs.Root>
    {teamId && run && run.stage && <TeamRunPanel teamId={teamId} members={members} onOpen={onOpen} />}
    </>
  )
}

const STAGES: { stage: TeamStage; label: string }[] = [
  { stage: 'spec', label: 'Spec' },
  { stage: 'approve', label: 'Approve' },
  { stage: 'build', label: 'Build' },
  { stage: 'checks', label: 'Checks' },
  { stage: 'verify', label: 'Verify' },
  { stage: 'report', label: 'Report' },
]
const ORDER: Record<TeamStage, number> = { spec: 0, approve: 1, build: 2, blocked: 2, checks: 3, verify: 4, report: 5, done: 6 }

/**
 * The pipeline's own view (.docs/teams-industry.md): where the run is, the one
 * decision that's yours (approve the card, answer a question), and the steps so
 * far. Refetched whenever the run's revision moves.
 */
function TeamRunPanel({ teamId, members, onOpen }: { teamId: string; members: SessionSummary[]; onOpen: (id: string) => void }) {
  const info = members[0]!.team!.run
  const [detail, setDetail] = useState<TeamRunDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void fetch(`/api/teams/run?teamId=${encodeURIComponent(teamId)}`)
      .then((r) => r.json() as Promise<TeamRunResponse>)
      .then((b) => live && b.ok && setDetail(b.run))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [teamId, info.rev, info.state])

  const approve = () => {
    setBusy(true)
    setError(null)
    teamsCall('POST', 'approve', { teamId })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }
  const builderTab = members.find((m) => m.team?.role === 'builder')
  const at = ORDER[info.stage]
  const lastBlocked = [...(detail?.steps ?? [])].reverse().find((x): x is Extract<TeamStep, { kind: 'blocked' }> => x.kind === 'blocked')

  return (
    <div className="teamPanel">
      <div className="teamStages" aria-label="Pipeline">
        {STAGES.map((st) => {
          const n = ORDER[st.stage]
          const state = info.stage === 'done' || n < at ? 'done' : n === at ? 'on' : 'todo'
          return (
            <span key={st.stage} className={`teamStage ${state}`}>
              {state === 'done' ? '✓ ' : ''}
              {st.label}
              {st.stage === 'build' && info.round > 0 ? ` · fix ${info.round}/${info.maxRounds}` : ''}
              {st.stage === 'build' && info.stage === 'blocked' ? ' · waiting on you' : ''}
            </span>
          )
        })}
        {info.stage === 'done' && <span className="teamStage done end">Done</span>}
      </div>

      {info.stage === 'approve' && detail?.card && (
        <div className="teamCard">
          <div className="teamCardHead">
            <span className="t">Task card</span>
            <span className="hint">The builder gets only this; the checker verifies against it. To change it, tell the manager.</span>
          </div>
          <p className="goal">{detail.card.goal}</p>
          <div className="teamCardCols">
            <div>
              <div className="lbl">done means</div>
              <ul>
                {detail.card.criteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
            {detail.card.outOfScope.length > 0 && (
              <div>
                <div className="lbl">out of scope</div>
                <ul>
                  {detail.card.outOfScope.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {detail.card.files.length > 0 && <div className="files mono">{detail.card.files.join(' · ')}</div>}
          {detail.card.notes && <p className="notes">{detail.card.notes}</p>}
          <div className="teamCardActs">
            {error && <span className="why">{error}</span>}
            <button type="button" className="btn primary" disabled={busy || info.state !== 'running'} onClick={approve}>
              {busy ? 'Starting…' : 'Approve & build'}
            </button>
          </div>
        </div>
      )}

      {info.stage === 'blocked' && lastBlocked && (
        <div className="teamCard ask">
          <span className="t">The builder asks</span>
          <p className="goal">{lastBlocked.question}</p>
          {builderTab && (
            <button type="button" className="btn sm" onClick={() => onOpen(builderTab.id)}>
              Answer in {builderTab.team!.label}
            </button>
          )}
        </div>
      )}

      {detail && detail.steps.length > 0 && (
        <details className="teamSteps">
          <summary>
            {stepLine(detail.steps[detail.steps.length - 1]!)} <span className="more">· {detail.steps.length} steps</span>
          </summary>
          <ol>
            {detail.steps.map((st, i) => (
              <li key={i}>{stepLine(st)}</li>
            ))}
          </ol>
          <div className="dir mono" title="The run's files">{detail.dir}</div>
        </details>
      )}
    </div>
  )
}

function stepLine(st: TeamStep): string {
  switch (st.kind) {
    case 'card':
      return `Card: ${st.card.goal}`
    case 'approved':
      return 'Approved by you'
    case 'handoff':
      return `Handoff${st.round ? ` (fix ${st.round})` : ''}: ${st.summary}`
    case 'checks':
      return st.commands.length ? `Checks: ${st.commands.map((c) => `${c.cmd} ${c.ok ? '✓' : '✗'}`).join(' · ')}` : 'Checks: none configured'
    case 'verdict':
      return `${st.checker}: ${st.verdict === 'pass' ? 'PASS' : `FAIL — ${st.findings.length} finding${st.findings.length === 1 ? '' : 's'}`}`
    case 'blocked':
      return `Builder asked: ${st.question}`
    case 'failed':
      return `Stopped: ${st.why}`
  }
}
