import type { ReactNode } from 'react'
import { AGENT_CANS, AGENT_COLORS, type AgentCan, type AgentEntry, type AgentSpec, type EffortLevel } from '../../../shared/protocol.js'
import { EFFORT_LABEL, useModels } from '../models.js'
import { AGENT_HEX, CAN_META, slugify } from '../teams.js'
import { Select, SelectItem } from '../ui/Select.js'

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Names a recipe step uses for the two agents that aren't files (core/teams/recipe.ts). */
const RESERVED = new Set(['lead', 'checks'])

/** A model id this machine's list doesn't carry (an alias from a shipped default): readable, not raw. */
const aliasName = (id: string) => id.replace(/^claude-/, '').replace(/^./, (c) => c.toUpperCase())

/** The agent being edited: its spec, with `name` null until the file exists. */
export type AgentDraft = Omit<AgentSpec, 'name'> & { name: string | null; touched?: boolean }

export function draftFromEntry(a: AgentEntry): AgentDraft {
  const { status: _s, path: _p, usedBy: _u, ...spec } = a
  return { ...spec, can: [...spec.can] }
}

export function blankDraft(taken: AgentEntry[]): AgentDraft {
  const used = new Set(taken.map((a) => a.color))
  return {
    name: null,
    label: '',
    description: '',
    model: null,
    effort: null,
    color: AGENT_COLORS.find((c) => !used.has(c)) ?? 'cyan',
    can: ['read'],
    prompt: '',
  }
}

/** What's wrong with the draft, if anything; `quiet` until the name has been typed into. */
export function agentProblem(a: AgentDraft): { message: string; quiet: boolean } | null {
  const label = a.label.trim()
  if (!label) return { message: a.touched ? 'needs a name' : 'name the new agent', quiet: !a.touched }
  // An existing file keeps its name; a new one is named after its label.
  if (a.name) return null
  const slug = slugify(label)
  if (RESERVED.has(slug)) return { message: `"${label}" is reserved — every team already has the lead and the checks step`, quiet: false }
  if (!slug) return { message: `"${label}" can't be used as a name`, quiet: false }
  return null
}

/** The PUT /api/teams/agent body. */
export function agentBody(a: AgentDraft): { name: string | null; agent: Record<string, unknown> } {
  const { touched: _t, name, ...rest } = a
  return { name, agent: name ? { ...rest, name } : rest }
}

function ModelEffort({
  model,
  effort,
  onModel,
  onEffort,
}: {
  model: string | null
  effort: EffortLevel | null
  onModel: (m: string | null) => void
  onEffort: (e: EffortLevel | null) => void
}) {
  const models = useModels().filter((m) => m.id !== 'default')
  const known = !model || models.some((m) => m.id === model)
  return (
    <div>
      <div className="teamPair">
        <Select className="teamSel" aria-label="Model" value={model ?? ''} onValueChange={(v) => onModel(v || null)}>
          <SelectItem value="">Default</SelectItem>
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id} description={m.description}>
              {m.name}
            </SelectItem>
          ))}
          {/* A saved model the probe no longer lists still has to render, or the
              field would silently blank itself. */}
          {!known && model && <SelectItem value={model}>{aliasName(model)}</SelectItem>}
        </Select>
        <span className="teamPairK">Effort</span>
        <Select className="teamSel" aria-label="Effort" value={effort ?? ''} onValueChange={(v) => onEffort((v || null) as EffortLevel | null)}>
          <SelectItem value="">Default</SelectItem>
          {EFFORTS.map((x) => (
            <SelectItem key={x} value={x}>
              {EFFORT_LABEL[x]}
            </SelectItem>
          ))}
        </Select>
      </div>
      {model?.includes('[1m]') && (
        <div className="teamHint warn">1M-context model: in a team every worker compacts at 200K anyway, so the bigger window buys nothing — pick the plain model.</div>
      )}
    </div>
  )
}

/**
 * One agent file's fields (Settings → Teams → Agents). An agent has no role:
 * the recipe step it fills decides what it does, and whether it may write.
 */
export function AgentForm({
  agent,
  usedBy,
  onChange,
}: {
  agent: AgentDraft
  usedBy: string[]
  onChange: (patch: Partial<AgentDraft>) => void
}) {
  const problem = agentProblem(agent)
  const nameErr = problem && !problem.quiet ? problem : null
  const toggle = (c: AgentCan) => onChange({ can: agent.can.includes(c) ? agent.can.filter((x) => x !== c) : [...agent.can, c] })
  return (
    <div className="teamForm">
      <Row label="Name">
        <input
          className={`teamInp${nameErr ? ' bad' : ''}`}
          value={agent.label}
          placeholder="e.g. Reviewer"
          aria-label="Name"
          aria-invalid={!!nameErr}
          autoFocus={!agent.label}
          onChange={(e) => onChange({ label: e.target.value, touched: true })}
        />
        {nameErr && <div className="teamErr">{nameErr.message}</div>}
      </Row>
      <Row label="Description">
        <input
          className="teamInp wide"
          value={agent.description}
          placeholder="What this agent is for — the lead reads it when it briefs the agent"
          aria-label="Description"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Row>
      <Row label="Model">
        <ModelEffort model={agent.model} effort={agent.effort} onModel={(model) => onChange({ model })} onEffort={(effort) => onChange({ effort })} />
      </Row>
      <Row label="Colour">
        <div className="teamPair">
          <span className="teamColors" role="radiogroup" aria-label="Colour">
            {AGENT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={agent.color === c}
                title={c}
                className={agent.color === c ? 'on' : ''}
                onClick={() => onChange({ color: c })}
              >
                <span style={{ background: AGENT_HEX[c] }} />
              </button>
            ))}
          </span>
        </div>
      </Row>
      <Row label="Can">
        <div className="teamCans">
          {AGENT_CANS.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={agent.can.includes(c)}
              className={`teamCan${agent.can.includes(c) ? ' on' : ''}`}
              onClick={() => toggle(c)}
            >
              <span className="box" aria-hidden="true" />
              <span>
                <span className="ct">{CAN_META[c].label}</span>
                <span className="cs">{CAN_META[c].hint}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="teamHint">Edit files is used only on a step that changes files; on every other step the agent is read-only.</div>
      </Row>
      <Row label="Prompt">
        <textarea
          className="teamArea"
          rows={6}
          value={agent.prompt}
          placeholder="Who this agent is, how it works, and what good looks like."
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
        <div className="teamHint">Each step adds what it does and what to hand on — no need to explain the team.</div>
      </Row>
      <div className="teamFormFoot">
        <span className="teamHint">
          {usedBy.length
            ? `Used by ${usedBy.join(', ')} — saving changes it there too.`
            : agent.name
              ? 'No team uses it yet.'
              : 'Saved as a new agent file in agents/.'}
        </span>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="teamRow">
      <span className="teamRowK">{label}</span>
      <div className="teamRowV">{children}</div>
    </div>
  )
}
