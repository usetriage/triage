import * as Tabs from '@radix-ui/react-tabs'
import { useState } from 'react'
import type { SessionSummary } from '../../../shared/protocol.js'
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
  )
}
