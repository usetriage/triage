import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { FolderOpen, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { AgentEntry, LibraryStatus, RecipeEntry, TeamLibraryResponse } from '../../../shared/protocol.js'
import { AGENT_HEX, canSummary, loadTeamLibrary, stepLine, teamsCall, usd, type TeamLibrary } from '../teams.js'
import { AgentForm, agentBody, agentProblem, blankDraft, draftFromEntry, type AgentDraft } from './AgentForm.js'

const STATUS: Record<LibraryStatus, { label: string; title: string }> = {
  default: { label: 'default', title: 'Exactly as triage ships it' },
  edited: { label: 'edited', title: 'A triage default you changed — Reset puts it back' },
  update: { label: 'newer default', title: 'You edited this, and triage has since shipped a newer default — Reset to take it (your edits are lost)' },
  yours: { label: 'yours', title: 'Made by you — triage never touches it' },
}

const asLib = (b: TeamLibraryResponse): TeamLibrary => {
  if (!b.ok) throw new Error(b.error)
  return { teams: b.teams, agents: b.agents, dir: b.dir }
}

/** "$3", or "$2.50" when the budget isn't whole dollars. */
const budget = (n: number): string => (Number.isInteger(n) ? `$${n}` : usd(n))

const openFolder = () => void teamsCall('POST', 'open').catch(() => {})

/**
 * Settings → Teams: the workspace's teams and the agents they're made of. Both
 * are files (server/teams.ts). A team is a recipe — edited as its file, made
 * from a run with "Save as team" — so this lists teams and edits only agents,
 * the one place a shared agent changes in place with who uses it said out loud.
 */
export function TeamsTab() {
  const [lib, setLib] = useState<TeamLibrary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'teams' | 'agents'>('teams')
  // undefined: closed; null: a new agent; a name: that agent's file
  const [editing, setEditing] = useState<string | null | undefined>(undefined)
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
          <button type="button" className="btn sm ghost" onClick={openFolder} title={lib?.dir}>
            <FolderOpen size={12} aria-hidden="true" /> Open folder
          </button>
          {view === 'agents' && (
            <button type="button" className="btn sm" onClick={() => setEditing(null)}>
              <Plus size={12} aria-hidden="true" /> New agent
            </button>
          )}
        </div>

        {error && <div className="msg error">{error}</div>}
        {!lib && !error && <div className="pickerLoading">Loading…</div>}

        {lib && (
          <>
            <Tabs.Content value="teams">
              {lib.teams.length === 0 ? (
                <div className="projEmpty">No teams — "Save as team" on a run's card makes one, or delete the folder's .seeded.json to get the defaults back.</div>
              ) : (
                <div className="libList">
                  {lib.teams.map((t) => (
                    <TeamRow
                      key={t.name}
                      team={t}
                      confirming={confirm === `team:${t.name}`}
                      onReset={() => void reset('team', t.name)}
                      onDelete={() => setConfirm(`team:${t.name}`)}
                      onConfirm={() => void remove('team', t.name)}
                      onCancel={() => setConfirm(null)}
                    />
                  ))}
                </div>
              )}
              <div className="libHint">
                Teams are recipe files in <span className="mono">teams/</span> — edit one in your editor. "Save as team" on a run's card makes a new one.
              </div>
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
                      onEdit={() => setEditing(a.name)}
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

      {lib && editing !== undefined && (
        <AgentEditDialog lib={lib} name={editing} onClose={() => setEditing(undefined)} onSaved={(l) => (setLib(l), setEditing(undefined))} />
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
  onOpen,
  onReset,
  onDelete,
  onConfirm,
  onCancel,
}: {
  status: LibraryStatus
  confirming: boolean
  confirmText: string
  onEdit?: () => void
  onOpen?: () => void
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
      {onEdit && (
        <button type="button" className="btn sm ghost" onClick={onEdit}>
          Edit
        </button>
      )}
      {onOpen && (
        <button type="button" className="btn sm ghost" onClick={onOpen} title="Teams are edited as files — opens the teams folder">
          Open file
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
  confirming,
  ...acts
}: {
  team: RecipeEntry
  confirming: boolean
  onReset: () => void
  onDelete: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const r = team.recipe
  const file = `teams/${team.name}.md`
  return (
    <div className="libRow team">
      <span className="libName" title={r?.description || file}>
        {r ? r.label : <span className="mono">{team.name}</span>}
      </span>
      {r ? (
        <span className="libSteps">
          <span className="libStepLine mono" title={r.steps.map((s) => `${s.id}: ${s.agent}${s.fanOut ? ` ×${s.fanOut.max} by ${s.fanOut.by}` : ''}${s.output ? ` → ${s.output}` : ''}${s.gate ? ' · waits for you' : ''}`).join('\n')}>
            {r.steps.map((s, i) => (
              <span key={s.id}>
                {i > 0 && <span className="arrow"> → </span>}
                {stepLine(s)}
                {s.gate === 'you' && <span className="gate"> · you</span>}
              </span>
            ))}
          </span>
          {team.missing.length > 0 && (
            <span className="libMissing" title={`No agent file for: ${team.missing.join(', ')}`}>
              missing {team.missing.join(', ')}
            </span>
          )}
        </span>
      ) : (
        <span className="libSteps">
          <span className="libErr" title={team.errors.length > 1 ? team.errors.join('\n') : undefined}>
            {team.errors[0] ?? 'this file is not a valid recipe'}
            {team.errors.length > 1 && <span className="more"> +{team.errors.length - 1}</span>}
          </span>
        </span>
      )}
      <span className="libBudget mono" title={r ? 'What one run may spend before it pauses' : undefined}>
        {r ? budget(r.budgetUsd) : ''}
      </span>
      <Status s={team.status} />
      <RowActions status={team.status} confirming={confirming} confirmText={`Delete ${r?.label ?? team.name}?`} onOpen={openFolder} {...acts} />
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
        confirmText={agent.usedBy.length ? `Delete ${agent.label}? ${agent.usedBy.join(', ')} will be missing it.` : `Delete ${agent.label}?`}
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

function AgentEditDialog({ lib, name, onClose, onSaved }: { lib: TeamLibrary; name: string | null; onClose: () => void; onSaved: (l: TeamLibrary) => void }) {
  const entry = name ? lib.agents.find((a) => a.name === name) ?? null : null
  const [agent, setAgent] = useState<AgentDraft>(() => (entry ? draftFromEntry(entry) : blankDraft(lib.agents)))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const problem = agentProblem(agent)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      onSaved(asLib(await teamsCall<TeamLibraryResponse>('PUT', 'agent', agentBody(agent))))
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
          {(error || problem) && <span className={`why${!error && problem?.quiet ? ' quiet' : ''}`}>{error ?? problem?.message}</span>}
          <Dialog.Close asChild>
            <button type="button" className="btn ghost">
              Cancel
            </button>
          </Dialog.Close>
          <button type="button" className="btn primary" disabled={busy || !!problem} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save agent'}
          </button>
        </>
      }
    >
      <div className="teamSolo">
        <AgentForm agent={agent} usedBy={entry?.usedBy ?? []} onChange={(patch) => setAgent((a) => ({ ...a, ...patch }))} />
      </div>
    </EditShell>
  )
}
