import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { AGENT_CANS, AGENT_COLORS, AGENT_ROLES, MAX_TEAM_AGENTS, type AgentCan, type AgentEntry, type EffortLevel, type ManagerSpec } from '../../../shared/protocol.js'
import { EFFORT_LABEL, useModels } from '../models.js'
import { AGENT_HEX, CAN_META, ROLE_META, blankAgent, canSummary, fromEntry, problems, type EditorAgent, type Problem, type TeamDraft } from '../teams.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'
import { Select, SelectItem } from '../ui/Select.js'

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** A model id this machine's list doesn't carry (an alias from a shipped default): readable, not raw. */
const aliasName = (id: string) => id.replace(/^claude-/, '').replace(/^./, (c) => c.toUpperCase())

type Props = {
  draft: TeamDraft
  onChange: (next: TeamDraft) => void
  /** 'manager' or an agent's key */
  selected: string
  onSelect: (sel: string) => void
  /** the library's agents, for "add from library" */
  library: AgentEntry[]
  /** 'run': edits apply to this run (the dialog). 'library': edits save to the files (Settings). */
  mode: 'run' | 'library'
}

/**
 * The team as a tree — manager on top, agents under it — with the selected
 * node's form beside it. Shared by the Start-a-team dialog and Settings, so a
 * team looks and edits the same in both. "+ Add agent" adds a blank agent and
 * selects it: the form *is* the add-agent screen, no dialog on a dialog.
 */
export function TeamEditor({ draft, onChange, selected, onSelect, library, mode }: Props) {
  const probs = problems(draft.agents)
  const flagged = new Set(probs.filter((p) => !p.quiet).map((p) => p.key))
  const agent = draft.agents.find((a) => a.key === selected)
  const full = draft.agents.length >= MAX_TEAM_AGENTS
  const inTeam = new Set(draft.agents.map((a) => a.base).filter(Boolean))
  const addable = library.filter((a) => !inTeam.has(a.name))

  const add = (a: EditorAgent) => {
    onChange({ ...draft, agents: [...draft.agents, a] })
    onSelect(a.key)
  }
  const patchAgent = (key: string, patch: Partial<EditorAgent>) =>
    onChange({ ...draft, agents: draft.agents.map((a) => (a.key === key ? { ...a, ...patch, dirty: true } : a)) })
  const remove = (key: string) => {
    const i = draft.agents.findIndex((a) => a.key === key)
    const agents = draft.agents.filter((a) => a.key !== key)
    onChange({ ...draft, agents })
    onSelect(agents[i]?.key ?? agents[i - 1]?.key ?? 'manager')
  }

  return (
    <div className="teamEd">
      <div className="teamTree" role="tree" aria-label="Team">
        <div className="teamTreeLbl">team · {draft.agents.length + 1} agents</div>
        <button type="button" role="treeitem" aria-selected={selected === 'manager'} className={`teamNode${selected === 'manager' ? ' on' : ''}`} onClick={() => onSelect('manager')}>
          <span className="branch" />
          <span className="mgrGlyph" aria-hidden="true" />
          <span className="nn">Manager</span>
          <span className="nm">{draft.manager.model ?? 'default'}</span>
        </button>
        {draft.agents.map((a) => (
          <button
            key={a.key}
            type="button"
            role="treeitem"
            aria-selected={selected === a.key}
            className={`teamNode${selected === a.key ? ' on' : ''}`}
            onClick={() => onSelect(a.key)}
          >
            <span className="branch" aria-hidden="true">├</span>
            <span className="swatch" style={{ background: AGENT_HEX[a.color] }} aria-hidden="true" />
            <span className={`nn${a.label.trim() ? '' : ' empty'}`}>
              {a.label.trim() || 'New agent'}
              {flagged.has(a.key) && <span className="flag" aria-label="has a problem" />}
            </span>
            <span className="nm">
              <span className={`roleTag ${a.role}`}>{ROLE_META[a.role].label}</span> {a.model ?? 'default'}
            </span>
          </button>
        ))}
        <div className="teamAddRow">
          <span className="branch" aria-hidden="true">└</span>
          {addable.length === 0 ? (
            <button type="button" className="teamAdd" disabled={full} onClick={() => add(blankAgent(draft.agents))}>
              <Plus size={12} aria-hidden="true" /> {full ? `Up to ${MAX_TEAM_AGENTS} agents` : 'Add agent'}
            </button>
          ) : (
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className="teamAdd" disabled={full}>
                  <Plus size={12} aria-hidden="true" /> {full ? `Up to ${MAX_TEAM_AGENTS} agents` : 'Add agent'}
                </button>
              </MenuTrigger>
              <MenuContent className="teamAddMenu">
                <MenuItem onSelect={() => add(blankAgent(draft.agents))}>New agent</MenuItem>
                <MenuSeparator />
                {addable.map((a) => (
                  <MenuItem key={a.name} onSelect={() => add(fromEntry(a))}>
                    <span className="swatch" style={{ background: AGENT_HEX[a.color] }} aria-hidden="true" />
                    <span className="teamAddName">{a.label}</span>
                    <span className="teamAddCan">{canSummary(a.can)}</span>
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          )}
        </div>
        <div className="teamTreeFoot">Triage runs it: the manager writes a task card you approve, the builder builds, the project's checks run, checkers verify, the manager reports.</div>
      </div>

      {agent ? (
        <AgentForm
          key={agent.key}
          agent={agent}
          problems={probs.filter((p) => p.key === agent.key || (p.field === 'role' && agent.role === 'builder'))}
          usedBy={mode === 'library' && agent.base ? library.find((a) => a.name === agent.base)?.usedBy ?? [] : []}
          mode={mode}
          onChange={(patch) => patchAgent(agent.key, patch)}
          onRemove={() => remove(agent.key)}
        />
      ) : (
        <ManagerForm manager={draft.manager} onChange={(manager) => onChange({ ...draft, manager })} />
      )}
    </div>
  )
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
      <Select
        className="teamSel"
        aria-label="Effort"
        value={effort ?? ''}
        onValueChange={(v) => onEffort((v || null) as EffortLevel | null)}
      >
        <SelectItem value="">Default</SelectItem>
        {EFFORTS.map((x) => (
          <SelectItem key={x} value={x}>
            {EFFORT_LABEL[x]}
          </SelectItem>
        ))}
      </Select>
    </div>
      {model?.includes('[1m]') && (
        <div className="teamHint warn">
          1M-context model: in a team every member compacts at 200K anyway, so the bigger window buys nothing — pick the plain model.
        </div>
      )}
    </div>
  )
}

function ManagerForm({ manager, onChange }: { manager: ManagerSpec; onChange: (m: ManagerSpec) => void }) {
  return (
    <div className="teamForm">
      <Row label="Name">
        <input className="teamInp" value="Manager" disabled aria-label="Name" />
        <div className="teamHint">Every team has one. It's who you talk to.</div>
      </Row>
      <Row label="Model">
        <ModelEffort
          model={manager.model}
          effort={manager.effort}
          onModel={(model) => onChange({ ...manager, model })}
          onEffort={(effort) => onChange({ ...manager, effort })}
        />
      </Row>
      <Row label="Can">
        <div className="teamCans">
          {AGENT_CANS.map((c) => (
            <div key={c} className={`teamCan locked${c === 'read' ? ' on' : ''}`} aria-disabled="true">
              <span className="box" aria-hidden="true" />
              <span>
                <span className="ct">{CAN_META[c].label}</span>
                <span className="cs">{c === 'read' ? CAN_META[c].hint : c === 'web' || c === 'browser' ? 'off for the manager' : 'never — the manager delegates'}</span>
              </span>
            </div>
          ))}
        </div>
      </Row>
      <Row label="Instructions">
        <textarea
          className="teamArea"
          rows={4}
          value={manager.instructions}
          placeholder="Anything this manager should always do — “keep tasks under 30 minutes”, “ask me before touching billing code”."
          onChange={(e) => onChange({ ...manager, instructions: e.target.value })}
        />
      </Row>
      <div className="teamFixed">
        <b>Set by triage, not editable:</b> plan → delegate → report to you; never edits files or runs commands; how to message
        agents; that a message from an agent isn't from you.
      </div>
    </div>
  )
}

export function AgentForm({
  agent,
  problems: probs,
  usedBy,
  mode,
  onChange,
  onRemove,
}: {
  agent: EditorAgent
  problems: Problem[]
  usedBy: string[]
  mode: 'run' | 'library'
  onChange: (patch: Partial<EditorAgent>) => void
  onRemove?: () => void
}) {
  const nameErr = probs.find((p) => p.field === 'name' && !p.quiet)
  const editErr = probs.find((p) => p.field === 'edit')
  const roleErr = probs.find((p) => p.field === 'role')
  const toggle = (c: AgentCan) => onChange({ can: agent.can.includes(c) ? agent.can.filter((x) => x !== c) : [...agent.can, c] })
  const shared = usedBy.length > 1
  return (
    <div className="teamForm">
      <Row label="Name">
        <input
          className={`teamInp${nameErr ? ' bad' : ''}`}
          value={agent.label}
          placeholder="e.g. Reviewer"
          aria-label="Name"
          autoFocus={!agent.label}
          onChange={(e) => onChange({ label: e.target.value, touched: true })}
        />
        {nameErr && <div className="teamErr">{nameErr.message}</div>}
      </Row>
      <Row label="Description">
        <input
          className="teamInp wide"
          value={agent.description}
          placeholder="What this agent is for — the manager reads it to decide who gets what"
          aria-label="Description"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Row>
      <Row label="Model">
        <ModelEffort model={agent.model} effort={agent.effort} onModel={(model) => onChange({ model })} onEffort={(effort) => onChange({ effort })} />
      </Row>
      <Row label="Role">
        <div className="teamRoles" role="radiogroup" aria-label="Role">
          {AGENT_ROLES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={agent.role === r}
              className={`teamRole${agent.role === r ? ' on' : ''}`}
              title={ROLE_META[r].hint}
              // Only the builder writes: leaving that role drops "Edit files" with it.
              onClick={() => onChange({ role: r, ...(r !== 'builder' ? { can: agent.can.filter((c) => c !== 'edit') } : {}) })}
            >
              {ROLE_META[r].label}
            </button>
          ))}
        </div>
        <div className="teamHint">{ROLE_META[agent.role].hint}</div>
        {roleErr && <div className="teamErr">{roleErr.message}</div>}
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
              disabled={c === 'edit' && agent.role !== 'builder' && !agent.can.includes('edit')}
              title={c === 'edit' && agent.role !== 'builder' ? 'Only the builder edits files' : undefined}
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
        {editErr && (
          <div className="teamCallout err">
            <b>Only the builder edits files.</b> {editErr.message} — two writers in one folder overwrite each other. Turn it off, or make
            this agent the builder.
          </div>
        )}
      </Row>
      <Row label="Prompt">
        <textarea
          className="teamArea"
          rows={6}
          value={agent.prompt}
          placeholder="You are the … on this team. How it works, what good looks like, and when to hand back."
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
        <div className="teamHint">Triage appends the team protocol at spawn — no need to explain messaging.</div>
      </Row>
      <div className="teamFormFoot">
        <span className="teamHint">
          {mode === 'run'
            ? agent.base && agent.dirty
              ? 'Edited for this run. Save as team keeps it as a new agent — the library file is untouched.'
              : agent.base
                ? `From the library: ${agent.base}.md`
                : 'New for this run. Save as team keeps it.'
            : shared
              ? `Shared — saving changes it for ${usedBy.join(', ')}.`
              : agent.base
                ? `agents/${agent.base}.md`
                : 'Saved as a new agent file.'}
        </span>
        {onRemove && (
          <button type="button" className="btn sm ghost" onClick={onRemove}>
            Remove from team
          </button>
        )}
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
