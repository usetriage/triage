import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  InboxResponse,
  Project,
  ProjectsResponse,
  ScoredItem,
  SessionSummary,
  TerminalSummary,
  Watch,
  WatchesResponse,
} from '../../../shared/protocol.js'
import { MOD_LABEL } from '../keys.js'
import { SETTINGS_TABS, type SettingsTab } from '../settings.js'
import { grantLabel } from '../../../core/watch/tools.js'

export type Command = {
  id: string
  section: 'Actions' | 'Pages' | 'Settings' | 'Projects' | 'Sessions' | 'Terminals' | 'Watches' | 'Work items'
  label: string
  hint?: string
  run: () => void
}

type Props = {
  open: boolean
  sessions: readonly SessionSummary[]
  terminals: readonly TerminalSummary[]
  onClose: () => void
  onNavigate: (hash: string) => void
  onNewSession: () => void
  onNewTerminal: () => void
  onOpenItem: (item: ScoredItem) => void
  onNewSessionIn: (project: Project) => void
  onSyncInbox: () => void
  onAddWatch: () => void
  onOpenSettings: (tab?: SettingsTab) => void
  onHelp: () => void
}

const SECTION_ORDER: Command['section'][] = ['Actions', 'Pages', 'Settings', 'Projects', 'Sessions', 'Terminals', 'Watches', 'Work items']

export function CommandPalette({
  open,
  sessions,
  terminals,
  onClose,
  onNavigate,
  onNewSession,
  onNewTerminal,
  onOpenItem,
  onNewSessionIn,
  onSyncInbox,
  onAddWatch,
  onOpenSettings,
  onHelp,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [items, setItems] = useState<ScoredItem[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [watches, setWatches] = useState<Watch[]>([])

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      setQuery('')
      setSel(0)
      el.showModal()
      // Work items come from the server's snapshot cache — ~30ms, no sync.
      void fetch('/api/inbox')
        .then((r) => r.json() as Promise<InboxResponse>)
        .then((b) => {
          if (b.ok) setItems(b.items)
        })
        .catch(() => {})
      void fetch('/api/projects')
        .then((r) => r.json() as Promise<ProjectsResponse>)
        .then((b) => {
          if (b.ok) setProjects(b.projects)
        })
        .catch(() => {})
      void fetch('/api/watches')
        .then((r) => r.json() as Promise<WatchesResponse>)
        .then((b) => {
          if (b.ok) setWatches(b.watches)
        })
        .catch(() => {})
    }
    if (!open && el.open) el.close()
  }, [open])

  const commands = useMemo<Command[]>(
    () => [
      { id: 'new', section: 'Actions', label: 'New session', hint: 'n', run: onNewSession },
      { id: 'newterm', section: 'Actions', label: 'New terminal', run: onNewTerminal },
      { id: 'sync', section: 'Actions', label: 'Sync inbox now', run: onSyncInbox },
      { id: 'addwatch', section: 'Actions', label: 'Add watch', run: onAddWatch },
      { id: 'help', section: 'Actions', label: 'Keyboard shortcuts', hint: '?', run: onHelp },
      { id: 'settings', section: 'Actions', label: 'Settings', hint: `${MOD_LABEL},`, run: () => onOpenSettings() },
      ...SETTINGS_TABS.map((t): Command => ({
        id: `set:${t.id}`,
        section: 'Settings',
        label: `Settings: ${t.label}`,
        hint: t.id === 'connectors' ? 'g c' : t.id === 'projects' ? 'g p' : t.sub,
        run: () => onOpenSettings(t.id),
      })),
      { id: 'inbox', section: 'Pages', label: 'Inbox', hint: 'g i', run: () => onNavigate('/inbox') },
      { id: 'sessions', section: 'Pages', label: 'Sessions', hint: 'g s', run: () => onNavigate('') },
      { id: 'terminals', section: 'Pages', label: 'Terminals', hint: 'g t', run: () => onNavigate('/terminals') },
      { id: 'watches', section: 'Pages', label: 'Watches', hint: 'g w', run: () => onNavigate('/watches') },
      ...watches.map((w): Command => ({
        id: `wa:${w.id}`,
        section: 'Watches',
        label: `${w.enabled ? 'Pause' : 'Resume'} watch: ${w.title}`,
        hint: w.tools.map(grantLabel).join(', '),
        run: () => {
          void fetch(`/api/watches?id=${encodeURIComponent(w.id)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: !w.enabled }),
          })
        },
      })),
      ...projects.map((pr): Command => ({
        id: `p:${pr.id}`,
        section: 'Projects',
        label: `New session in ${pr.name}`,
        hint: pr.repo || pr.path.split('/').pop(),
        run: () => onNewSessionIn(pr),
      })),
      ...sessions.map((s): Command => ({
        id: `s:${s.id}`,
        section: 'Sessions',
        label: s.title,
        hint: `${s.status} · ${s.cwd.split('/').pop() ?? ''}`,
        run: () => onNavigate(s.id),
      })),
      ...terminals.map((t): Command => ({
        id: `t:${t.id}`,
        section: 'Terminals',
        label: t.title,
        hint: `${t.status} · ${t.cwd.split('/').pop() ?? ''}`,
        run: () => onNavigate(`/terminal/${t.id}`),
      })),
      ...items.map((i): Command => ({
        id: `w:${i.id}`,
        section: 'Work items',
        label: i.title,
        hint: `${i.repo} · ${i.reason}`,
        run: () => onOpenItem(i),
      })),
    ],
    [sessions, terminals, items, projects, watches, onNavigate, onNewSession, onNewTerminal, onOpenItem, onNewSessionIn, onSyncInbox, onAddWatch, onOpenSettings, onHelp],
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q
      ? commands.filter((c) => (c.label + ' ' + (c.hint ?? '')).toLowerCase().includes(q))
      : commands
    return [...matched].sort(
      (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
    )
  }, [commands, query])

  const clamped = Math.min(sel, Math.max(0, shown.length - 1))

  function runSelected() {
    const cmd = shown[clamped]
    if (!cmd) return
    onClose()
    cmd.run()
  }

  return (
    <dialog ref={dialog} id="palette" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <input
        autoFocus
        placeholder="Search sessions, items, projects, commands…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setSel(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSel((s) => Math.min(s + 1, shown.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((s) => Math.max(s - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            runSelected()
          }
        }}
      />
      <div className="palList">
        {shown.map((cmd, i) => (
          <div key={cmd.id}>
            {(i === 0 || shown[i - 1].section !== cmd.section) && (
              <div className="palSection">{cmd.section}</div>
            )}
            <div
              className={`palRow${i === clamped ? ' sel' : ''}`}
              ref={i === clamped ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseMove={() => i !== clamped && setSel(i)}
              onClick={runSelected}
            >
              <span className="palLabel">{cmd.label}</span>
              {cmd.hint && <span className="palHint">{cmd.hint}</span>}
            </div>
          </div>
        ))}
        {shown.length === 0 && <div className="palEmpty">Nothing matches.</div>}
      </div>
    </dialog>
  )
}
