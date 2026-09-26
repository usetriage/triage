import * as Tabs from '@radix-ui/react-tabs'
import type { SessionSummary } from '../../../shared/protocol.js'
import { AGENT_HEX } from '../teams.js'

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
 * composer, so the user can speak to any agent directly.
 */
export function TeamStrip({ members, currentId, modelName, onOpen }: Props) {
  return (
    <Tabs.Root value={currentId} onValueChange={onOpen} activationMode="manual">
      <Tabs.List id="teamStrip" aria-label="Team members">
        <span className="teamLabel">Team</span>
        {members.map((s) => {
          const t = s.team!
          const busy = s.status === 'running' || s.status === 'starting'
          const state = s.waiting ? 'needs you' : busy ? 'working' : s.status === 'error' ? 'error' : 'idle'
          const model = modelName(s)
          return (
            <Tabs.Trigger key={s.id} value={s.id} className="teamTab" title={`${t.label} — ${state}${model ? ` · ${model}` : ''}`}>
              {t.color ? (
                <span className="swatch" style={{ background: AGENT_HEX[t.color] }} aria-hidden="true" />
              ) : (
                <span className="mgrGlyph" aria-hidden="true" />
              )}
              <span className="role">{t.label}</span>
              {model && <span className="model">{model}</span>}
              {(s.waiting || busy) && (
                <span className="state">
                  <span className={`dot ${s.waiting ? 'yellow' : 'live'}`} aria-hidden="true" /> {state}
                </span>
              )}
              {s.status === 'error' && <span className="dot red" aria-label="error" />}
            </Tabs.Trigger>
          )
        })}
      </Tabs.List>
    </Tabs.Root>
  )
}
