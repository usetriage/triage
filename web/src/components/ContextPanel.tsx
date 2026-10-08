/**
 * The 280px context panel beside the rail. Two contents, chosen by where you
 * are: the ranked Queue (inbox and item pages) or the Sessions list (home and
 * session pages). Both open with the search field, which is the ⌘K palette.
 */
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  Home,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  PenLine,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ArtifactWithLinks, Project, ProjectsResponse, ScoredItem, SessionSummary, TerminalSummary } from '../../../shared/protocol.js'
import { draftTitle, type Draft } from '../drafts.js'
import { GROUP_ORDER, GROUP_SHORT, itemTone, kindIcon } from '../itemUi.js'
import { MOD_LABEL } from '../keys.js'
import { rowOpen } from '../tabs.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'

/** Hides the panel; provided by the desktop shell only (a phone sheet closes from its tab). */
export const PanelCollapseContext = createContext<(() => void) | null>(null)

export function PanelSearch({ onSearch, placeholder }: { onSearch: () => void; placeholder: string }) {
  const collapse = useContext(PanelCollapseContext)
  return (
    <div className="panelSearch">
      <button type="button" className="searchBtn" onClick={onSearch} title={`Search (${MOD_LABEL}K)`}>
        <Search size={13} aria-hidden="true" />
        <span className="t">{placeholder}</span>
        <span className="kbd">{MOD_LABEL}K</span>
      </button>
      {collapse && (
        <button type="button" className="iconBtn" onClick={collapse} title={`Hide panel (${MOD_LABEL}B)`} aria-label="Hide panel">
          <PanelLeftClose size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Queue — the open inbox, grouped and ranked
// ---------------------------------------------------------------------------

type QueueProps = {
  items: readonly ScoredItem[]
  loaded: boolean
  selectedId: string | null
  onOpenItem: (id: string) => void
  /** Keep it in the band without leaving where you are (⌘-click, middle-click). */
  onPinItem: (id: string, title: string) => void
  onAdd: () => void
  onRefresh: () => void
  onSearch: () => void
}

export function QueuePanel({ items, loaded, selectedId, onOpenItem, onPinItem, onAdd, onRefresh, onSearch }: QueueProps) {
  return (
    <aside className="panel" aria-label="Queue">
      <PanelSearch onSearch={onSearch} placeholder="Search items, sessions…" />
      <div className="panelBody">
        <div className="panelHead">
          <span>Queue</span>
          <span className="n">{items.length}</span>
          <span className="acts">
            <button type="button" className="iconBtn sm" title="Add a work item (n)" onClick={onAdd}>
              <Plus size={13} aria-hidden="true" />
            </button>
            <button type="button" className="iconBtn sm" title="Refresh (r)" onClick={onRefresh}>
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          </span>
        </div>
        {loaded && items.length === 0 && <div className="panelEmpty">Inbox zero — nothing is waiting on you.</div>}
        {GROUP_ORDER.map((g) => {
          const rows = items.filter((i) => i.group === g)
          if (rows.length === 0) return null
          return (
            <div key={g}>
              <div className="panelGroup">
                {GROUP_SHORT[g]}
                <span className="n">{rows.length}</span>
              </div>
              {rows.map((item) => {
                const Icon = kindIcon(item)
                const tone = itemTone(item)
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`prow${item.id === selectedId ? ' sel' : ''}`}
                    title={item.title}
                    {...rowOpen(
                      () => onOpenItem(item.id),
                      () => onPinItem(item.id, item.title),
                    )}
                  >
                    <Icon size={13} aria-hidden="true" />
                    <span className="t">{item.title}</span>
                    {tone && <span className={`dot sm ${tone}`} aria-hidden="true" />}
                    <span className="m">{Math.round(item.score)}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="panelFoot">
        <span className="kbd">j</span>
        <span className="kbd">k</span> move <span className="kbd">Enter</span> open <span className="kbd">e</span> done{' '}
        <span className="kbd">z</span> snooze
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Artifacts — the workspace's notes and briefs, newest first
// ---------------------------------------------------------------------------

type ArtifactsProps = {
  artifacts: readonly ArtifactWithLinks[]
  loaded: boolean
  currentId: string | null
  onOpen: (id: string) => void
  onPin: (id: string, title: string) => void
  onNew: () => void
  onRefresh: () => void
  onSearch: () => void
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 48 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

/** Notes you wrote, then briefs the model wrote — two groups, each newest first. */
export function ArtifactsPanel({ artifacts, loaded, currentId, onOpen, onPin, onNew, onRefresh, onSearch }: ArtifactsProps) {
  const visible = artifacts.filter((a) => !a.hidden)
  const groups: Array<[string, ArtifactWithLinks[]]> = [
    ['Notes', visible.filter((a) => a.author === 'human')],
    ['Briefs', visible.filter((a) => a.author === 'model')],
  ]
  return (
    <aside className="panel" aria-label="Artifacts">
      <PanelSearch onSearch={onSearch} placeholder="Search artifacts, items…" />
      <div className="panelBody">
        <div className="panelHead">
          <span>Artifacts</span>
          <span className="n">{visible.length}</span>
          <span className="acts">
            <button type="button" className="iconBtn sm" title="New note (n)" onClick={onNew}>
              <Plus size={13} aria-hidden="true" />
            </button>
            <button type="button" className="iconBtn sm" title="Re-index the folder" onClick={onRefresh}>
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          </span>
        </div>
        {loaded && visible.length === 0 && <div className="panelEmpty">No notes yet — write one, or drop a .md file in the folder.</div>}
        {groups.map(([label, rows]) =>
          rows.length === 0 ? null : (
            <div key={label}>
              <div className="panelGroup">
                {label}
                <span className="n">{rows.length}</span>
              </div>
              {rows.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`prow${a.id === currentId ? ' sel' : ''}`}
                  title={`${a.title} — ${a.path}`}
                  {...rowOpen(
                    () => onOpen(a.id),
                    () => onPin(a.id, a.title),
                  )}
                >
                  <FileText size={13} aria-hidden="true" />
                  <span className="t">{a.title}</span>
                  {a.links.length > 0 && <span className="dot sm blue" aria-hidden="true" title="linked" />}
                  <span className="m">{ago(a.updated)}</span>
                </button>
              ))}
            </div>
          ),
        )}
      </div>
      <div className="panelFoot">
        <span className="kbd">n</span> new note <span className="kbd">Enter</span> open · type <span className="kbd">@artifact:</span> in any composer
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Sessions — every session in the workspace, pinned first
// ---------------------------------------------------------------------------

/** Newest first. Archived is only the tail of the same axis — nothing is filed by hand. */
const TIME_BUCKETS = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Archived'] as const

/** Which bucket a session falls in, by last activity against local midnight. */
function bucketOf(updatedAt: number): (typeof TIME_BUCKETS)[number] {
  const midnight = new Date().setHours(0, 0, 0, 0)
  const day = 86_400_000
  if (updatedAt >= midnight) return 'Today'
  if (updatedAt >= midnight - day) return 'Yesterday'
  if (updatedAt >= midnight - 7 * day) return 'Previous 7 days'
  if (updatedAt >= midnight - 30 * day) return 'Previous 30 days'
  return 'Archived'
}

type SessionsProps = {
  sessions: readonly SessionSummary[]
  currentId: string | null
  /** unsent session tabs — listed first so a half-written prompt is never lost */
  drafts: readonly Draft[]
  currentDraftId: string | null
  onSelectDraft: (id: string) => void
  onDiscardDraft: (id: string) => void
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onSetPinned: (id: string, pinned: boolean) => void
  onDelete: (id: string) => void
  onSearch: () => void
}

export function SessionsPanel({
  sessions,
  currentId,
  drafts,
  currentDraftId,
  onSelectDraft,
  onDiscardDraft,
  onSelect,
  onNew,
  onRename,
  onSetPinned,
  onDelete,
  onSearch,
}: SessionsProps) {
  // At most one row is being renamed at a time — the panel is a list, not a form.
  const [renaming, setRenaming] = useState<string | null>(null)
  // Deleting is irreversible, so it is confirmed in a modal rather than on the row.
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  // Archive is the one unbounded group, so it is the only one that collapses.
  const [archiveOpen, setArchiveOpen] = useState(false)
  // Selecting an archived session reveals it, but the toggle still wins afterwards:
  // this fires on the selection changing, not on every summaries broadcast.
  useEffect(() => {
    if (!currentId) return
    const s = sessions.find((x) => x.id === currentId)
    if (s && !s.pinned && bucketOf(s.updatedAt) === 'Archived') setArchiveOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId])

  const pinned = sessions.filter((s) => s.pinned)
  const rest = sessions.filter((s) => !s.pinned)
  const running = sessions.filter((s) => s.status === 'running' || s.status === 'starting').length

  const row = (s: SessionSummary) => (
    <SessionRow
      key={s.id}
      session={s}
      active={s.id === currentId}
      renaming={renaming === s.id}
      onSelect={() => onSelect(s.id)}
      onStartRename={() => setRenaming(s.id)}
      onEndRename={(title) => {
        setRenaming(null)
        if (title !== undefined && title !== s.title) onRename(s.id, title)
      }}
      onSetPinned={(p) => onSetPinned(s.id, p)}
      onDelete={() => setDeleting(s)}
    />
  )

  return (
    <aside className="panel" aria-label="Sessions">
      <PanelSearch onSearch={onSearch} placeholder="Search sessions, items…" />
      <div className="panelBody">
        <div className="panelHead">
          <span>Sessions</span>
          <span className="n">{sessions.length}</span>
          {running > 0 && <span className="n" title="running now">· {running} live</span>}
          <span className="acts">
            <button type="button" className="iconBtn sm" title="New session (n)" onClick={onNew}>
              <Plus size={13} aria-hidden="true" />
            </button>
          </span>
        </div>
        {sessions.length === 0 && drafts.length === 0 && (
          <div className="panelEmpty">No sessions yet. Dispatch a work item, or start one from the composer.</div>
        )}
        {drafts.length > 0 && (
          <>
            <div className="panelGroup">
              Unsent <span className="n">{drafts.length}</span>
            </div>
            {drafts.map((d) => (
              <div
                key={d.id}
                className={`prow draft${d.id === currentDraftId ? ' sel' : ''}`}
                role="button"
                tabIndex={0}
                title={draftTitle(d)}
                onClick={() => onSelectDraft(d.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelectDraft(d.id)
                  }
                }}
              >
                <PenLine size={13} aria-hidden="true" />
                <span className="t">{draftTitle(d)}</span>
                <button
                  type="button"
                  className="iconBtn rowMenu"
                  aria-label={`Discard draft ${draftTitle(d)}`}
                  title="Discard draft"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDiscardDraft(d.id)
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
          </>
        )}
        {pinned.length > 0 && (
          <>
            <div className="panelGroup">
              Pinned <span className="n">{pinned.length}</span>
            </div>
            {pinned.map(row)}
          </>
        )}
        {TIME_BUCKETS.map((label) => {
          const rows = rest.filter((s) => bucketOf(s.updatedAt) === label)
          if (rows.length === 0) return null
          if (label !== 'Archived')
            return (
              <div key={label}>
                <div className="panelGroup">
                  {label} <span className="n">{rows.length}</span>
                </div>
                {rows.map(row)}
              </div>
            )
          return (
            <div key={label}>
              <button
                type="button"
                className="panelGroup asBtn"
                aria-expanded={archiveOpen}
                onClick={() => setArchiveOpen((v) => !v)}
              >
                {archiveOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                {label} <span className="n">{rows.length}</span>
              </button>
              {archiveOpen && rows.map(row)}
            </div>
          )
        })}
      </div>
      <div className="panelFoot">
        <span className="kbd">n</span> new session <span className="kbd">g s</span> here
      </div>

      <DeleteSessionDialog
        session={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) onDelete(deleting.id)
          setDeleting(null)
        }}
      />
    </aside>
  )
}

const STATUS_DOT: Record<SessionSummary['status'], string> = {
  starting: 'live',
  running: 'live',
  idle: 'green',
  error: 'red',
}

type RowProps = {
  session: SessionSummary
  active: boolean
  renaming: boolean
  onSelect: () => void
  onStartRename: () => void
  /** `undefined` = cancelled; a string = the committed title. */
  onEndRename: (title?: string) => void
  onSetPinned: (pinned: boolean) => void
  onDelete: () => void
}

function SessionRow({ session: s, active, renaming, onSelect, onStartRename, onEndRename, onSetPinned, onDelete }: RowProps) {
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) input.current?.select()
  }, [renaming])

  if (renaming) {
    return (
      <div className={`prow${active ? ' sel' : ''}`}>
        <span className={`dot sm ${STATUS_DOT[s.status]}`} aria-hidden="true" />
        <input
          ref={input}
          className="renameInput"
          defaultValue={s.title}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEndRename(e.currentTarget.value.trim() || undefined)
            else if (e.key === 'Escape') {
              e.stopPropagation()
              onEndRename()
            }
          }}
          onBlur={(e) => onEndRename(e.currentTarget.value.trim() || undefined)}
        />
      </div>
    )
  }

  return (
    <div
      className={`prow${active ? ' sel' : ''}`}
      role="button"
      tabIndex={0}
      title={s.title}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <span className={`dot sm ${STATUS_DOT[s.status]}`} aria-hidden="true" />
      <span className="t">{s.title}</span>
      {s.pinned && <Pin className="pinMark" size={11} aria-label="Pinned" />}
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="iconBtn rowMenu"
            aria-label={`Session options for ${s.title}`}
            title="Session options"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem asChild>
            <a href={`#${s.id}`} target="_blank" rel="noreferrer">
              <ExternalLink size={14} aria-hidden="true" />
              Open in new tab
            </a>
          </MenuItem>
          <MenuItem onSelect={() => onSetPinned(!s.pinned)}>
            {s.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
            {s.pinned ? 'Unpin' : 'Pin to top'}
          </MenuItem>
          <MenuItem onSelect={onStartRename}>
            <Pencil size={14} aria-hidden="true" />
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem className="danger" onSelect={onDelete}>
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}

/**
 * The confirmation for a delete. A native <dialog>, like the other modals, so
 * Escape and the backdrop close it and `anyDialogOpen` sees it.
 */
function DeleteSessionDialog({
  session,
  onCancel,
  onConfirm,
}: {
  session: SessionSummary | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (session && !el.open) el.showModal()
    if (!session && el.open) el.close()
  }, [session])

  return (
    <dialog ref={dialog} id="deleteSession" onClose={onCancel} onClick={(e) => e.target === dialog.current && onCancel()}>
      <h3>Delete session?</h3>
      <p>
        <strong>{session?.title}</strong> and its whole transcript will be deleted. This cannot be undone.
      </p>
      <div className="row">
        <button type="button" className="cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          Delete session
        </button>
      </div>
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Terminals — the shells the daemon is running for this workspace
// ---------------------------------------------------------------------------

type TerminalsProps = {
  terminals: readonly TerminalSummary[]
  currentId: string | null
  /** Where "+" opens a shell by default — the active tab's folder, when there is one. */
  defaultCwd?: string
  onSelect: (id: string) => void
  onNew: (cwd?: string) => void
  onRename: (id: string, title: string) => void
  onClose: (id: string) => void
  onSearch: () => void
}

const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

export function TerminalsPanel({ terminals, currentId, defaultCwd, onSelect, onNew, onRename, onClose, onSearch }: TerminalsProps) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const running = terminals.filter((t) => t.status === 'running').length

  return (
    <aside className="panel" aria-label="Terminals">
      <PanelSearch onSearch={onSearch} placeholder="Search terminals, sessions…" />
      <div className="panelBody">
        <div className="panelHead">
          <span>Terminals</span>
          <span className="n">{terminals.length}</span>
          {running > 0 && running !== terminals.length && <span className="n">· {running} running</span>}
          <span className="acts">
            <NewTerminalMenu defaultCwd={defaultCwd} onNew={onNew} />
          </span>
        </div>
        {terminals.length === 0 && (
          <div className="panelEmpty">No terminals yet. Open one with + — it starts in the active tab's folder.</div>
        )}
        {terminals.map((t) => (
          <TerminalRow
            key={t.id}
            terminal={t}
            active={t.id === currentId}
            renaming={renaming === t.id}
            onSelect={() => onSelect(t.id)}
            onStartRename={() => setRenaming(t.id)}
            onEndRename={(title) => {
              setRenaming(null)
              if (title !== undefined && title !== t.title) onRename(t.id, title)
            }}
            onClose={() => onClose(t.id)}
          />
        ))}
      </div>
      <div className="panelFoot">
        <Terminal size={13} aria-hidden="true" />
        <span>New terminals open in the active tab's folder.</span>
      </div>
    </aside>
  )
}

/** "+" for a terminal: the active folder first, then every project, then home. */
export function NewTerminalMenu({ defaultCwd, onNew, className }: { defaultCwd?: string; onNew: (cwd?: string) => void; className?: string }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [open])

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <button type="button" className={className ?? 'iconBtn sm'} title="New terminal">
          <Plus size={13} aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="wide">
        {defaultCwd && (
          <>
            <MenuItem onSelect={() => onNew(defaultCwd)}>
              <Terminal size={14} aria-hidden="true" />
              <span className="text">
                <span className="name">New terminal here</span>
                <span className="desc">{homely(defaultCwd)}</span>
              </span>
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {projects.map((p) => (
          <MenuItem key={p.id} onSelect={() => onNew(p.path)}>
            <Folder size={14} aria-hidden="true" />
            <span className="text">
              <span className="name">{p.name}</span>
              <span className="desc">{homely(p.path)}</span>
            </span>
          </MenuItem>
        ))}
        {projects.length > 0 && <MenuSeparator />}
        <MenuItem onSelect={() => onNew(undefined)}>
          <Home size={14} aria-hidden="true" />
          Home folder
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function TerminalRow({
  terminal: t,
  active,
  renaming,
  onSelect,
  onStartRename,
  onEndRename,
  onClose,
}: {
  terminal: TerminalSummary
  active: boolean
  renaming: boolean
  onSelect: () => void
  onStartRename: () => void
  onEndRename: (title?: string) => void
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (renaming) input.current?.select()
  }, [renaming])

  const running = t.status === 'running'

  if (renaming) {
    return (
      <div className={`prow${active ? ' sel' : ''}`}>
        <span className={`dot sm ${running ? 'green' : 'stone'}`} aria-hidden="true" />
        <input
          ref={input}
          className="renameInput"
          defaultValue={t.title}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEndRename(e.currentTarget.value.trim() || undefined)
            else if (e.key === 'Escape') {
              e.stopPropagation()
              onEndRename()
            }
          }}
          onBlur={(e) => onEndRename(e.currentTarget.value.trim() || undefined)}
        />
      </div>
    )
  }

  return (
    <div
      className={`prow term${active ? ' sel' : ''}${running ? '' : ' off'}`}
      role="button"
      tabIndex={0}
      title={`${t.title} — ${homely(t.cwd)}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <span className={`dot sm ${running ? 'green' : 'stone'}`} aria-hidden="true" />
      <span className="t">
        {t.title}
        <span className="sub">{running ? homely(t.cwd) : `exited · ${t.exitCode ?? '?'}`}</span>
      </span>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="iconBtn rowMenu"
            aria-label={`Terminal options for ${t.title}`}
            title="Terminal options"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={onStartRename}>
            <Pencil size={14} aria-hidden="true" />
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem className="danger" onSelect={onClose}>
            <X size={14} aria-hidden="true" />
            {running ? 'Kill and close' : 'Close'}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}
