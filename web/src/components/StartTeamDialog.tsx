import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DispatchPreviewResponse, SaveTeamResponse, ScoredItem, StartTeamResponse } from '../../../shared/protocol.js'
import { draftFromTeam, loadTeamLibrary, problems, teamsCall, wireAgents, type TeamDraft, type TeamLibrary } from '../teams.js'
import { Select, SelectItem } from '../ui/Select.js'
import { TeamEditor } from './TeamEditor.js'

type Props = {
  open: boolean
  item: ScoredItem
  onClose: () => void
  /** the team started — open the manager's session */
  onStarted: (managerId: string) => void
}

const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
const DEFAULT_KICKOFF = 'Start the team on this item. Understand the scope, show me the plan, then delegate the first task.'

/**
 * "Start a team": who is about to take this item, before anything spawns. The
 * library team the item's workspace ships (or the user saved) fills the tree;
 * every edit applies to this run only until Save as team keeps it. Nothing
 * starts until Start work.
 */
export function StartTeamDialog({ open, item, onClose, onStarted }: Props) {
  const [lib, setLib] = useState<TeamLibrary | null>(null)
  const [team, setTeam] = useState<string>('')
  const [draft, setDraft] = useState<TeamDraft>({ manager: { model: null, effort: null, instructions: '' }, agents: [] })
  const [selected, setSelected] = useState('manager')
  const [dirty, setDirty] = useState(false)
  const [kickoff, setKickoff] = useState(DEFAULT_KICKOFF)
  const [folder, setFolder] = useState<string | null | undefined>(undefined)
  const [saving, setSaving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = (name: string, l: TeamLibrary | null = lib) => {
    if (!l) return
    const t = l.teams.find((x) => x.name === name) ?? null
    setTeam(t ? t.name : '')
    setDraft(draftFromTeam(t, l))
    setSelected('manager')
    setDirty(false)
    setSaving(null)
    setError(null)
  }

  // Reseed each time the dialog opens: the library may have changed in Settings.
  useEffect(() => {
    if (!open) return
    setKickoff(DEFAULT_KICKOFF)
    setError(null)
    setBusy(false)
    setFolder(undefined)
    void loadTeamLibrary()
      .then((l) => {
        setLib(l)
        pick(l.teams.find((t) => t.name === 'development')?.name ?? l.teams[0]?.name ?? '', l)
      })
      .catch((err) => setError(String(err)))
    void fetch(`/api/dispatch/preview?itemId=${encodeURIComponent(item.id)}`)
      .then((r) => r.json() as Promise<DispatchPreviewResponse>)
      .then((b) => setFolder(b.ok ? b.preview.cwd : null))
      .catch(() => setFolder(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id])

  const change = (next: TeamDraft) => {
    setDraft(next)
    setDirty(true)
  }

  const probs = problems(draft.agents)
  const reason = folder === null ? 'this item has no project folder' : probs[0]?.message
  const quiet = folder !== null && probs[0]?.quiet
  const n = draft.agents.length + 1
  const teamLabel = lib?.teams.find((t) => t.name === team)?.label

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const b = await teamsCall<StartTeamResponse & { ok: true }>('POST', 'start', {
        itemId: item.id,
        team: team || null,
        manager: draft.manager,
        agents: wireAgents(draft.agents),
        kickoff,
      })
      onStarted(b.managerId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  async function save() {
    if (!saving?.trim()) return
    setError(null)
    try {
      const b = await teamsCall<SaveTeamResponse & { ok: true }>('POST', 'save', {
        name: null,
        label: saving.trim(),
        description: '',
        manager: draft.manager,
        agents: wireAgents(draft.agents),
        agentMode: 'fork',
      })
      setLib({ teams: b.library.teams, agents: b.library.agents, dir: b.library.dir })
      pick(b.team, { teams: b.library.teams, agents: b.library.agents, dir: b.library.dir })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="teamOverlay" />
        <Dialog.Content className="teamDialog" aria-describedby={undefined}>
          <header className="teamDialogHead">
            <Dialog.Title className="t">Start a team</Dialog.Title>
            <span className="item" title={item.title}>
              · {item.title}
            </span>
            <span className="r">
              <label className="teamPickLbl" htmlFor="teamPick">
                Team
              </label>
              <Select id="teamPick" className="teamSel" aria-label="Team" value={team} onValueChange={pick} disabled={!lib}>
                {lib?.teams.map((t) => (
                  <SelectItem key={t.name} value={t.name}>
                    {t.label}
                  </SelectItem>
                ))}
                <SelectItem value="">Blank — just the manager</SelectItem>
              </Select>
              {dirty && <span className="pill edited">edited</span>}
              <Dialog.Close asChild>
                <button type="button" className="iconBtn" aria-label="Close" title="Close (Esc)">
                  <X size={15} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </span>
          </header>

          {lib ? (
            <TeamEditor draft={draft} onChange={change} selected={selected} onSelect={setSelected} library={lib.agents} mode="run" />
          ) : (
            <div className="teamLoading">{error ?? 'Loading teams…'}</div>
          )}

          <footer className="teamDialogFoot">
            <div className="teamKick">
              <label htmlFor="teamKick">kickoff · to the manager — the item and its brief are attached</label>
              <textarea id="teamKick" className="teamArea" rows={2} value={kickoff} onChange={(e) => setKickoff(e.target.value)} />
            </div>
            <div className="teamFootRow">
              <span>
                Folder{' '}
                <span className="mono path">{folder === undefined ? '…' : folder === null ? 'none — set a project on the item' : tilde(folder)}</span>
              </span>
              <span>
                {n} agents · about {n}× a single session
              </span>
              <span className="sp" />
              {error && lib && <span className="why">{error}</span>}
              {!error && reason && <span className={`why${quiet ? ' quiet' : ''}`}>{reason}</span>}
              {saving !== null ? (
                <span className="teamSaveInline">
                  <input
                    className="teamInp"
                    autoFocus
                    value={saving}
                    placeholder="Team name"
                    aria-label="Team name"
                    onChange={(e) => setSaving(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void save()}
                  />
                  <button type="button" className="btn sm" disabled={!saving.trim()} onClick={() => void save()}>
                    Save
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setSaving(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={!lib || probs.length > 0}
                  title="Keep this team in your library — edited agents are saved as new agents"
                  onClick={() => setSaving(dirty && teamLabel ? `My ${teamLabel}` : '')}
                >
                  Save as team
                </button>
              )}
              <button type="button" className="btn primary" disabled={!lib || busy || !!reason || folder === undefined} onClick={() => void start()}>
                {busy ? 'Starting…' : 'Start work'}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
