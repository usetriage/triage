import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { FolderOpen, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { AgentEntry, LibraryStatus, SaveTeamResponse, TeamEntry, TeamLibraryResponse } from '../../../shared/protocol.js'
import {
  AGENT_HEX,
  blankAgent,
  canSummary,
  draftFromTeam,
  fromEntry,
  loadTeamLibrary,
  problems,
  teamsCall,
  wireAgents,
  type EditorAgent,
  type TeamDraft,
  type TeamLibrary,
} from '../teams.js'
import { AgentForm, TeamEditor } from './TeamEditor.js'

const STATUS: Record<LibraryStatus, { label: string; title: string }> = {
  default: { label: 'default', title: 'Exactly as triage ships it' },
  edited: { label: 'edited', title: 'A triage default you changed — Reset puts it back' },
  update: { label: 'newer default', title: 'You edited this, and triage has since shipped a newer default — Reset to take it (your edits are lost)' },
  yours: { label: 'yours', title: 'Made by you — triage never touches it' },
}

type Editing = { kind: 'team'; name: string | null; copy?: boolean } | { kind: 'agent'; name: string | null }

const asLib = (b: TeamLibraryResponse): TeamLibrary => {
  if (!b.ok) throw new Error(b.error)
  return { teams: b.teams, agents: b.agents, dir: b.dir }
}

/**
 * Settings → Teams: the workspace's teams and the agents they're made of. Both
 * are files (server/teams.ts); this is the one place that shows where each
 * stands against the defaults triage ships, and the only place a shared agent
 * is edited in place — with who uses it said out loud.
 */
export function TeamsTab() {
  const [lib, setLib] = useState<TeamLibrary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'teams' | 'agents'>('teams')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  const load = useCallback(() => {
    loadTeamLibrary()
      .then(setLib)
      .catch((err) => setError(String(err)))
  }, [])
  useEffect(load, [load])

  const act = async (fn: () => Promise<TeamLibraryResponse>) => {
    setError(null)
    try {
      setLib(asLib(await fn()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const reset = (kind: 'team' | 'agent', name: string) => act(() => teamsCall('POST', 'reset', { kind, name }))
  const remove = (kind: 'team' | 'agent', name: string) => {
    setConfirm(null)
    return act(() => teamsCall('DELETE', `${kind}?name=${encodeURIComponent(name)}`))
  }

  return (
    <section className="setSection teamsTab">
      <Tabs.Root value={view} onValueChange={(v) => setView(v as 'teams' | 'agents')}>
        <div className="teamsTabBar">
          <Tabs.List className="seg" aria-label="Teams or agents">
            <Tabs.Trigger value="teams" className="segBtn">
              Teams{lib ? ` · ${lib.teams.length}` : ''}
            </Tabs.Trigger>
            <Tabs.Trigger value="agents" className="segBtn">
              Agents{lib ? ` · ${lib.agents.length}` : ''}
            </Tabs.Trigger>
          </Tabs.List>
          <span className="sp" />
          <button type="button" className="btn sm ghost" onClick={() => void teamsCall('POST', 'open').catch(() => {})} title={lib?.dir}>
            <FolderOpen size={12} aria-hidden="true" /> Open folder
          </button>
          <button type="button" className="btn sm" onClick={() => setEditing({ kind: view === 'teams' ? 'team' : 'agent', name: null })}>
            <Plus size={12} aria-hidden="true" /> New {view === 'teams' ? 'team' : 'agent'}
          </button>
        </div>

        {error && <div className="msg error">{error}</div>}
        {!lib && !error && <div className="pickerLoading">Loading…</div>}

        {lib && (
          <>
            <Tabs.Content value="teams">
              {lib.teams.length === 0 ? (
                <div className="projEmpty">No teams — New team makes one, or delete the folder's .seeded.json to get the defaults back.</div>
              ) : (
                <div className="libList">
                  {lib.teams.map((t) => (
                    <TeamRow
                      key={t.name}
                      team={t}
                      agents={lib.agents}
                      confirming={confirm === `team:${t.name}`}
                      onEdit={() => setEditing({ kind: 'team', name: t.name })}
                      onDuplicate={() => setEditing({ kind: 'team', name: t.name, copy: true })}
                      onReset={() => void reset('team', t.name)}
                      onDelete={() => setConfirm(`team:${t.name}`)}
                      onConfirm={() => void remove('team', t.name)}
                      onCancel={() => setConfirm(null)}
                    />
                  ))}
                </div>
              )}
            </Tabs.Content>
            <Tabs.Content value="agents">
              {lib.agents.length === 0 ? (
                <div className="projEmpty">No agents yet — New agent makes one.</div>
              ) : (
                <div className="libList">
                  {lib.agents.map((a) => (
                    <AgentRow
                      key={a.name}
                      agent={a}
                      confirming={confirm === `agent:${a.name}`}
                      onEdit={() => setEditing({ kind: 'agent', name: a.name })}
                      onReset={() => void reset('agent', a.name)}
                      onDelete={() => setConfirm(`agent:${a.name}`)}
                      onConfirm={() => void remove('agent', a.name)}
                      onCancel={() => setConfirm(null)}
                    />
                  ))}
                </div>
              )}
            </Tabs.Content>
          </>
        )}
      </Tabs.Root>

      {lib && editing?.kind === 'team' && (
        <TeamEditDialog lib={lib} name={editing.name} copy={!!editing.copy} onClose={() => setEditing(null)} onSaved={(l) => (setLib(l), setEditing(null))} />
      )}
      {lib && editing?.kind === 'agent' && (
        <AgentEditDialog lib={lib} name={editing.name} onClose={() => setEditing(null)} onSaved={(l) => (setLib(l), setEditing(null))} />
      )}
    </section>
  )
}

function Status({ s }: { s: LibraryStatus }) {
  return (
    <span className={`libStatus ${s}`} title={STATUS[s].title}>
      {STATUS[s].label}
    </span>
  )
}

function RowActions({
  status,
  confirming,
  confirmText,
  onEdit,
  onDuplicate,
  onReset,
  onDelete,
  onConfirm,
  onCancel,
}: {
  status: LibraryStatus
  confirming: boolean
  confirmText: string
  onEdit: () => void
  onDuplicate?: () => void
  onReset: () => void
  onDelete: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  if (confirming)
    return (
      <span className="libActs confirm">
        <span className="libConfirmText">{confirmText}</span>
        <button type="button" className="btn sm danger" onClick={onConfirm}>
          Delete
        </button>
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    )
  return (
    <span className="libActs">
      <button type="button" className="btn sm ghost" onClick={onEdit}>
        Edit
      </button>
      {onDuplicate && (
        <button type="button" className="btn sm ghost" onClick={onDuplicate}>
          Duplicate
        </button>
      )}
      {(status === 'edited' || status === 'update') && (
        <button type="button" className="btn sm ghost" onClick={onReset} title="Put back exactly what triage ships">
          Reset
        </button>
      )}
      <button type="button" className="btn sm ghost" onClick={onDelete}>
        Delete
      </button>
    </span>
  )
}

function TeamRow({
  team,
  agents,
  confirming,
  ...acts
}: {
  team: TeamEntry
  agents: AgentEntry[]
  confirming: boolean
  onEdit: () => void
  onDuplicate: () => void
  onReset: () => void
  onDelete: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="libRow">
      <span className="libName">
        <span className="mgrGlyph" aria-hidden="true" />
        {team.label}
      </span>
      <span className="libRoster">
        {team.agents.map((n) => {
          const a = agents.find((x) => x.name === n)
          return a ? (
            <span key={n} className="libMember">
              <span className="swatch" style={{ background: AGENT_HEX[a.color] }} aria-hidden="true" />
              {a.label}
            </span>
          ) : null
        })}
        {team.missing.length > 0 && <span className="libMissing" title={`No agent file for: ${team.missing.join(', ')}`}>missing {team.missing.join(', ')}</span>}
        {team.agents.length === 0 && <span className="libMuted">just the manager</span>}
      </span>
      <Status s={team.status} />
      <RowActions status={team.status} confirming={confirming} confirmText={`Delete ${team.label}?`} {...acts} />
    </div>
  )
}

function AgentRow({
  agent,
  confirming,
  ...acts
}: {
  agent: AgentEntry
  confirming: boolean
  onEdit: () => void
  onReset: () => void
  onDelete: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="libRow agent">
      <span className="libName">
        <span className="swatch" style={{ background: AGENT_HEX[agent.color] }} aria-hidden="true" />
        {agent.label}
      </span>
      <span className="libModel mono">{agent.model ?? 'default'}</span>
      <span className="libCan">{canSummary(agent.can)}</span>
      <span className="libUsed">{agent.usedBy.length ? agent.usedBy.join(', ') : <span className="libMuted">no team</span>}</span>
      <Status s={agent.status} />
      <RowActions
        status={agent.status}
        confirming={confirming}
        confirmText={agent.usedBy.length ? `Delete ${agent.label}? It leaves ${agent.usedBy.join(', ')}.` : `Delete ${agent.label}?`}
        {...acts}
      />
    </div>
  )
}

function EditShell({ title, children, footer, onClose }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="teamOverlay" />
        <Dialog.Content className="teamDialog" aria-describedby={undefined}>
          <header className="teamDialogHead">
            <Dialog.Title className="t">{title}</Dialog.Title>
            <span className="r">
              <Dialog.Close asChild>
                <button type="button" className="iconBtn" aria-label="Close" title="Close (Esc)">
                  <X size={15} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </span>
          </header>
          {children}
          <footer className="teamDialogFoot">
            <div className="teamFootRow">{footer}</div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function TeamEditDialog({
  lib,
  name,
  copy,
  onClose,
  onSaved,
}: {
  lib: TeamLibrary
  name: string | null
  copy: boolean
  onClose: () => void
  onSaved: (l: TeamLibrary) => void
}) {
  const base = name ? lib.teams.find((t) => t.name === name) ?? null : null
  const [label, setLabel] = useState(base ? (copy ? `${base.label} copy` : base.label) : '')
  const [description, setDescription] = useState(base?.description ?? '')
  const [draft, setDraft] = useState<TeamDraft>(() => draftFromTeam(base, lib))
  const [selected, setSelected] = useState('manager')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const probs = problems(draft.agents)
  const reason = !label.trim() ? 'name the team' : probs[0]?.message

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const b = await teamsCall<SaveTeamResponse & { ok: true }>('POST', 'save', {
        name: copy ? null : name,
        label: label.trim(),
        description,
        manager: draft.manager,
        agents: wireAgents(draft.agents),
        agentMode: 'update',
        budgetUsd: draft.budgetUsd,
      })
      onSaved({ teams: b.library.teams, agents: b.library.agents, dir: b.library.dir })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <EditShell
      title={base && !copy ? `Edit ${base.label}` : copy ? `Duplicate ${base?.label ?? ''}` : 'New team'}
      onClose={onClose}
      footer={
        <>
          <span className="sp" />
          {(error || reason) && <span className="why">{error ?? reason}</span>}
          <Dialog.Close asChild>
            <button type="button" className="btn ghost">
              Cancel
            </button>
          </Dialog.Close>
          <button type="button" className="btn primary" disabled={busy || !!reason} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save team'}
          </button>
        </>
      }
    >
      <div className="teamMeta">
        <input className="teamInp" value={label} placeholder="Team name" aria-label="Team name" autoFocus={!label} onChange={(e) => setLabel(e.target.value)} />
        <input
          className="teamInp wide"
          value={description}
          placeholder="What this team is for"
          aria-label="Description"
          onChange={(e) => setDescription(e.target.value)}
        />
        <label className="teamBudget" title="What one run may spend before it pauses">
          Budget $
          <input
            className="teamInp"
            type="number"
            min={1}
            max={500}
            value={draft.budgetUsd}
            aria-label="Budget in dollars"
            onChange={(e) => setDraft({ ...draft, budgetUsd: Math.max(1, Math.min(500, Number(e.target.value) || 1)) })}
          />
        </label>
      </div>
      <TeamEditor draft={draft} onChange={setDraft} selected={selected} onSelect={setSelected} library={lib.agents} mode="library" />
    </EditShell>
  )
}

function AgentEditDialog({ lib, name, onClose, onSaved }: { lib: TeamLibrary; name: string | null; onClose: () => void; onSaved: (l: TeamLibrary) => void }) {
  const entry = name ? lib.agents.find((a) => a.name === name) ?? null : null
  const [agent, setAgent] = useState<EditorAgent>(() => (entry ? fromEntry(entry) : blankAgent([])))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const probs = problems([agent])
  const reason = probs[0]?.message

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const b = await teamsCall<TeamLibraryResponse>('PUT', 'agent', { name, agent: wireAgents([agent])[0] })
      onSaved(asLib(b))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <EditShell
      title={entry ? `Edit ${entry.label}` : 'New agent'}
      onClose={onClose}
      footer={
        <>
          <span className="mono libPath">{entry ? `agents/${entry.name}.md` : ''}</span>
          <span className="sp" />
          {(error || reason) && <span className={`why${!error && probs[0]?.quiet ? ' quiet' : ''}`}>{error ?? reason}</span>}
          <Dialog.Close asChild>
            <button type="button" className="btn ghost">
              Cancel
            </button>
          </Dialog.Close>
          <button type="button" className="btn primary" disabled={busy || !!reason} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save agent'}
          </button>
        </>
      }
    >
      <div className="teamSolo">
        <AgentForm
          agent={agent}
          problems={probs}
          usedBy={entry?.usedBy ?? []}
          mode="library"
          onChange={(patch) => setAgent((a) => ({ ...a, ...patch, dirty: true }))}
        />
      </div>
    </EditShell>
  )
}
