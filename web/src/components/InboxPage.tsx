import {
  AlarmClock,
  Archive,
  Check,
  CheckSquare,
  ChevronRight,
  ExternalLink,
  ImagePlus,
  Link2,
  MoreHorizontal,
  Play,
  Sparkles,
  Square,
  Flag,
  Folder,
  Pencil,
  RefreshCw,
  ThumbsDown,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RepoScopeEditor } from './RepoScope.js'
import type {
  BriefJob,
  Group,
  ItemImage,
  ItemImageEdit,
  ItemListResponse,
  ItemStatus,
  ManualItemResponse,
  Project,
  ProjectsResponse,
  ReposResponse,
  ScoredItem,
  WatchesResponse,
} from '../../../shared/protocol.js'
import { itemImageUrl } from '../../../shared/protocol.js'
import { withWorkspace } from '../workspaceUrl.js'
import { useAttachments } from '../attachments.js'
import { AttachmentStrip } from './AttachmentStrip.js'
import { inboxStore, useInbox } from '../inboxStore.js'
import { rowOpen } from '../tabs.js'
import { briefPill, briefStore, useBriefs } from '../briefStore.js'
import { CreateBriefDialog } from './CreateBriefDialog.js'
import {
  GROUP_ORDER,
  GROUP_TITLE,
  KIND_LABEL,
  PRIORITY_LABEL,
  PRIORITY_VALUES,
  itemTone,
  kindIcon,
  ago,
  priorityClass,
  shortAge,
  weekday,
} from '../itemUi.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'
import { anyDialogOpen, isTypingTarget } from '../keys.js'

/** The status tabs (.docs/watches-v2.md): items are durable and never deleted,
 *  so done/snoozed/archived are viewable, not just write-only. */
const TABS = [
  { id: 'open', label: 'Open' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'done', label: 'Done' },
  { id: 'archived', label: 'Archived' },
] as const
type Tab = (typeof TABS)[number]['id']

type OtherState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: ScoredItem[] }
  | { phase: 'error'; message: string }

type Props = {
  onDispatch: (item: ScoredItem) => void
  onRefineWatch: (item: ScoredItem) => void
  onOpenItem: (id: string) => void
  /** Keep it in the band without leaving the inbox (⌘-click, middle-click). */
  onPinItem: (id: string, title: string) => void
  /** Bumped by the shell (Queue panel "+") to open the new-item composer. */
  composeSignal?: number
}

export function InboxPage({ onDispatch, onRefineWatch, onOpenItem, onPinItem, composeSignal = 0 }: Props) {
  const [tab, setTab] = useState<Tab>('open')
  // The open tab reads the shared snapshot (the Queue panel shows the same
  // list); the other tabs are loaded here on demand.
  const snap = useInbox()
  const [other, setOther] = useState<OtherState>({ phase: 'loading' })
  const [reposOpen, setReposOpen] = useState(false)
  const [repoCount, setRepoCount] = useState<number | null>(null)
  const [watchTitles, setWatchTitles] = useState<Map<string, string>>(new Map())
  const [projects, setProjects] = useState<Project[]>([])
  const [composer, setComposer] = useState<{ open: boolean; editing: ScoredItem | null }>({
    open: false,
    editing: null,
  })
  const [scanning, setScanning] = useState(false)
  const [sel, setSel] = useState(0)
  // Multi-select (.docs/next-version.md, phase 2): checked rows brief together.
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [briefing, setBriefing] = useState<ScoredItem[] | null>(null)
  const briefs = useBriefs()
  useEffect(() => {
    if (!briefs.loaded) void briefStore.refresh()
  }, [briefs.loaded])
  const toggleChecked = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const isOpen = tab === 'open'

  const loadOther = useCallback(async (which: Exclude<Tab, 'open'>) => {
    setOther({ phase: 'loading' })
    try {
      const res = await fetch(`/api/items?status=${which}`)
      const body = (await res.json()) as ItemListResponse
      setOther(body.ok ? { phase: 'ready', items: body.items } : { phase: 'error', message: body.error })
    } catch (err) {
      setOther({ phase: 'error', message: String(err) })
    }
  }, [])

  const reload = useCallback(
    (refresh: boolean) => {
      if (tab === 'open') void inboxStore.refresh(refresh)
      else void loadOther(tab)
    },
    [tab, loadOther],
  )

  const scanNow = useCallback(async () => {
    setScanning(true)
    try {
      await fetch('/api/scan', { method: 'POST' }).catch(() => {})
      // give the forced GitHub reconcile a moment, then reload
      setTimeout(() => void inboxStore.refresh(true), 1200)
    } finally {
      setTimeout(() => setScanning(false), 1200)
    }
  }, [])

  const projectName = useCallback(
    (id?: string) => (id ? projects.find((p) => p.id === id)?.name : undefined),
    [projects],
  )

  const removeLocally = useCallback(
    (id: string) => {
      if (isOpen) inboxStore.patch((items) => items.filter((i) => i.id !== id))
      else setOther((prev) => (prev.phase === 'ready' ? { ...prev, items: prev.items.filter((i) => i.id !== id) } : prev))
    },
    [isOpen],
  )

  // A status change is a recorded transition on a durable item — the row leaves
  // the current tab optimistically; the item is never deleted (.docs/watches-v2.md).
  const setItemState = useCallback(
    async (item: ScoredItem, status: ItemStatus, snoozeUntil?: number) => {
      removeLocally(item.id)
      await fetch('/api/items/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, status, snoozeUntil }),
      }).catch(() => {})
    },
    [removeLocally],
  )

  // A priority override applies to any item and survives re-sync. Reflect the
  // chip immediately; re-ranking lands on the next refresh.
  const setPriority = useCallback((item: ScoredItem, priority: number) => {
    inboxStore.patch((items) => items.map((i) => (i.id === item.id ? { ...i, priority: priority || undefined } : i)))
    void fetch('/api/items/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, priority: priority || null }),
    }).catch(() => {})
  }, [])

  // "Delete" a manual item archives it (never a hard delete); it moves to Archived.
  const deleteManual = useCallback(
    (item: ScoredItem) => {
      removeLocally(item.id)
      void fetch(`/api/items/manual?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' }).catch(() => {})
    },
    [removeLocally],
  )

  const snooze1d = useCallback((item: ScoredItem) => void setItemState(item, 'snoozed', tomorrow9()), [setItemState])

  const selectTab = useCallback(
    (next: Tab) => {
      setTab(next)
      setSel(0)
      if (next !== 'open') void loadOther(next)
    },
    [loadOther],
  )

  // Items in on-screen order. The Open tab renders in GROUP_ORDER; the other
  // tabs are a flat, source-time-ordered list.
  const ordered = useMemo<readonly ScoredItem[]>(
    () =>
      isOpen
        ? GROUP_ORDER.flatMap((g) => snap.items.filter((i) => i.group === g))
        : other.phase === 'ready'
          ? other.items
          : [],
    [isOpen, snap.items, other],
  )

  // The live selection: checked ids that are still on screen. Ids of rows that
  // already left the tab (done via the keyboard, refreshed away) don't count.
  const checkedItems = useMemo(
    () => (isOpen ? ordered.filter((i) => checked.has(i.id)) : []),
    [isOpen, ordered, checked],
  )
  const clearChecked = useCallback(() => setChecked(new Set()), [])

  // Bulk transition: every checked row leaves the tab optimistically, the N
  // single-item POSTs run together, and a failed one resyncs the list so it
  // stays honest (there is no batch form of /api/items/state).
  const bulkState = useCallback(
    async (status: ItemStatus, snoozeUntil?: number) => {
      const targets = checkedItems
      if (!targets.length) return
      clearChecked()
      for (const t of targets) removeLocally(t.id)
      const results = await Promise.allSettled(
        targets.map((t) =>
          fetch('/api/items/state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: t.id, status, snoozeUntil }),
          }),
        ),
      )
      if (results.some((r) => r.status === 'rejected' || !r.value.ok)) reload(false)
    },
    [checkedItems, clearChecked, removeLocally, reload],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e) || anyDialogOpen() || e.metaKey || e.ctrlKey || e.altKey) return
      const cur = ordered[sel]
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((v) => Math.min(v + 1, Math.max(0, ordered.length - 1)))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((v) => Math.max(v - 1, 0))
      } else if (e.key === 'Enter' && cur) {
        e.preventDefault()
        onOpenItem(cur.id)
      } else if (e.key === 'o' && cur?.url) {
        e.preventDefault()
        window.open(cur.url, '_blank', 'noopener')
      } else if (e.key === 'd' && cur) {
        e.preventDefault()
        onDispatch(cur)
      } else if (e.key === 'b' && isOpen) {
        e.preventDefault()
        const picked = checkedItems.length ? checkedItems : cur ? [cur] : []
        if (picked.length) setBriefing(picked)
      } else if (e.key === ' ' && cur && isOpen) {
        e.preventDefault()
        toggleChecked(cur.id)
      } else if (e.key === 'Escape' && checkedItems.length && !e.defaultPrevented) {
        e.preventDefault()
        clearChecked()
      } else if (e.key === 'e' && checkedItems.length) {
        e.preventDefault()
        void bulkState('done')
      } else if (e.key === 'e' && cur) {
        e.preventDefault()
        void setItemState(cur, isOpen ? 'done' : 'open')
      } else if (e.key === 'x' && checkedItems.length) {
        e.preventDefault()
        void bulkState('archived')
      } else if (e.key === 'x' && cur) {
        e.preventDefault()
        void setItemState(cur, 'archived')
      } else if (e.key === 'z' && checkedItems.length) {
        e.preventDefault()
        void bulkState('snoozed', tomorrow9())
      } else if (e.key === 'z' && cur && isOpen) {
        e.preventDefault()
        snooze1d(cur)
      } else if (e.key === 'r') {
        e.preventDefault()
        reload(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ordered, sel, isOpen, onDispatch, onOpenItem, reload, setItemState, snooze1d, checkedItems, toggleChecked, bulkState, clearChecked])

  const loadProjects = useCallback(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!snap.loaded) void inboxStore.refresh(false)
    loadProjects()
    void fetch('/api/repos')
      .then((r) => r.json() as Promise<ReposResponse>)
      .then((b) => {
        if (b.ok) setRepoCount(b.connected.length)
      })
      .catch(() => {})
    void fetch('/api/watches')
      .then((r) => r.json() as Promise<WatchesResponse>)
      .then((b) => {
        if (b.ok) setWatchTitles(new Map(b.watches.map((w) => [w.id, w.title])))
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadProjects])

  // The shell's "+" (Queue panel) opens the composer from anywhere in the inbox.
  const lastSignal = useRef(composeSignal)
  useEffect(() => {
    if (composeSignal !== lastSignal.current) {
      lastSignal.current = composeSignal
      setComposer({ open: true, editing: null })
    }
  }, [composeSignal])

  const loading = isOpen ? !snap.loaded && snap.loading : other.phase === 'loading'
  const error = isOpen ? (!snap.loaded ? snap.error : undefined) : other.phase === 'error' ? other.message : undefined
  const items = ordered
  const blocking = isOpen ? snap.items.filter((i) => i.group === 'blocking').length : 0
  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? ''
  const emptyText = isOpen
    ? snap.notices.length > 0
      ? 'No open items to show — but a source is degraded, so this may be incomplete.'
      : 'Inbox zero — nothing is waiting on you.'
    : `Nothing in ${tabLabel.toLowerCase()}.`

  const rowProps: RowActions = {
    tab,
    watchTitles,
    projectName,
    onSelect: (id) => setSel(ordered.findIndex((i) => i.id === id)),
    onOpen: onOpenItem,
    onPin: onPinItem,
    onDispatch,
    onDone: (i) => void setItemState(i, 'done'),
    onSnooze: snooze1d,
    onArchive: (i) => void setItemState(i, 'archived'),
    onReopen: (i) => void setItemState(i, 'open'),
    onRefineWatch,
    onSetPriority: setPriority,
    onEdit: (i) => setComposer({ open: true, editing: i }),
    onDelete: deleteManual,
    checked,
    onToggle: toggleChecked,
    onBrief: (i) => setBriefing([i]),
    briefOf: (id) => briefs.byItem.get(id),
  }

  return (
    <div className="page wide" id="inboxPage">
      <div className="glow blue" aria-hidden="true" />
      <div className="inner">
        <div className="pageHead">
          <h1 className="display">
            {isOpen ? weekday() : tabLabel}.{' '}
            {loading && items.length === 0 ? (
              <span className="muted">syncing…</span>
            ) : (
              <span className="muted">
                {items.length} item{items.length === 1 ? '' : 's'}
                {blocking > 0 && (
                  <>
                    , <span className="blk">{blocking} blocking</span>
                  </>
                )}
                .
              </span>
            )}
          </h1>
          <span className="pageMeta" title={snap.syncedAt ? new Date(snap.syncedAt).toLocaleString() : undefined}>
            <RefreshCw size={12} aria-hidden="true" />
            {snap.syncedAt ? `synced ${ago(snap.syncedAt)}` : 'not synced yet'}
            {repoCount != null && ` · ${repoCount === 0 ? 'no repos' : `${repoCount} repo${repoCount === 1 ? '' : 's'}`}`}
            {watchTitles.size > 0 && ` · ${watchTitles.size} watch${watchTitles.size === 1 ? '' : 'es'}`}
          </span>
        </div>

        <div className="toolRow">
          <div className="seg" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`segBtn${tab === t.id ? ' active' : ''}`}
                onClick={() => selectTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="right">
            <button type="button" className="btn sm ghost" onClick={() => setComposer({ open: true, editing: null })}>
              + Add item
            </button>
            <button type="button" className="btn sm ghost mono" onClick={() => setReposOpen(true)}>
              {repoCount == null ? 'Repos' : repoCount === 0 ? 'Repos: none' : `Repos: ${repoCount}`}
            </button>
            <button type="button" className="btn sm ghost" disabled={scanning} onClick={() => void scanNow()}>
              {scanning ? 'Scanning…' : 'Scan now'}
            </button>
            <button type="button" className="btn sm ghost" disabled={loading} onClick={() => reload(true)}>
              {loading ? 'Syncing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {loading && items.length === 0 && (
          <div className="probing">
            <span className="pip" /> {isOpen ? 'Syncing sources…' : 'Loading…'}
          </div>
        )}

        {error && <div className="msg error">Sync failed: {error}</div>}

        {!loading && !error && (
          <>
            {isOpen &&
              snap.notices.map((n) => (
                <div key={n} className="notice">
                  {n}
                </div>
              ))}
            {items.length === 0 ? (
              <div className="inboxEmpty">
                {emptyText}
                {isOpen && (
                  <button type="button" className="btn" onClick={() => setComposer({ open: true, editing: null })}>
                    Add a work item
                  </button>
                )}
              </div>
            ) : isOpen ? (
              <div className="homeList">
                {GROUP_ORDER.map((g) => (
                  <ItemGroup
                    key={g}
                    group={g}
                    items={snap.items.filter((i) => i.group === g)}
                    selectedId={ordered[sel]?.id ?? null}
                    {...rowProps}
                  />
                ))}
              </div>
            ) : (
              <div className="homeList">
                {items.map((item) => (
                  <WorkRow key={item.id} item={item} selected={item.id === (ordered[sel]?.id ?? null)} {...rowProps} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {checkedItems.length > 0 && (
        <SelectionBar
          count={checkedItems.length}
          onBrief={() => setBriefing(checkedItems)}
          onDone={() => void bulkState('done')}
          onSnooze={() => void bulkState('snoozed', tomorrow9())}
          onArchive={() => void bulkState('archived')}
          onClear={clearChecked}
        />
      )}

      <RepoPicker
        open={reposOpen}
        onClose={() => setReposOpen(false)}
        onSaved={(count) => {
          setRepoCount(count)
          setReposOpen(false)
          void inboxStore.refresh(true) // scope changed — resync now
        }}
      />

      <ItemComposer
        open={composer.open}
        editing={composer.editing}
        projects={projects}
        onClose={() => setComposer({ open: false, editing: null })}
        onSaved={() => {
          setComposer({ open: false, editing: null })
          reload(false) // include the new/edited item
        }}
        onSavedMore={() => reload(false)} // "Add more" — refresh, stay open
      />

      <CreateBriefDialog
        open={briefing !== null}
        items={briefing ?? []}
        onClose={() => setBriefing(null)}
        onQueued={clearChecked}
      />
    </div>
  )
}

/** Tomorrow 09:00 local — the one snooze duration the inbox knows (`z`). */
function tomorrow9(): number {
  const t = new Date()
  t.setDate(t.getDate() + 1)
  t.setHours(9, 0, 0, 0)
  return t.getTime()
}

/**
 * Floating bulk-action bar. Appears bottom-centre of the pane while rows are
 * checked and offers the same verbs as a row's hover cluster, applied to all
 * of them at once. It sticks to the bottom of the page scroller rather than
 * the viewport so it never sits over the rail or the Queue panel.
 */
function SelectionBar({
  count,
  onBrief,
  onDone,
  onSnooze,
  onArchive,
  onClear,
}: {
  count: number
  onBrief: () => void
  onDone: () => void
  onSnooze: () => void
  onArchive: () => void
  onClear: () => void
}) {
  return (
    <div className="selDock">
      <div className="selBar" role="toolbar" aria-label={`${count} checked`}>
        <span className="count">
          <span className="n">{count}</span> checked
        </span>
        <span className="sep" aria-hidden="true" />
        <button type="button" className="btn sm primary" title="Brief the checked items together (b)" onClick={onBrief}>
          <Sparkles size={13} aria-hidden="true" /> Brief
        </button>
        <button type="button" className="btn sm ghost" title="Mark the checked items done (e)" onClick={onDone}>
          <Check size={14} aria-hidden="true" /> Done
        </button>
        <button type="button" className="btn sm ghost" title="Snooze the checked items until tomorrow 9am (z)" onClick={onSnooze}>
          <AlarmClock size={13} aria-hidden="true" /> Snooze
        </button>
        <button type="button" className="btn sm ghost" title="Archive the checked items (x)" onClick={onArchive}>
          <Archive size={13} aria-hidden="true" /> Archive
        </button>
        <span className="sep" aria-hidden="true" />
        <button type="button" className="iconBtn sm" title="Clear selection (Esc)" aria-label="Clear selection" onClick={onClear}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

type RowActions = {
  tab: Tab
  watchTitles: Map<string, string>
  projectName: (id?: string) => string | undefined
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onPin: (id: string, title: string) => void
  onDispatch: (item: ScoredItem) => void
  onDone: (item: ScoredItem) => void
  onSnooze: (item: ScoredItem) => void
  onArchive: (item: ScoredItem) => void
  onReopen: (item: ScoredItem) => void
  onRefineWatch: (item: ScoredItem) => void
  onSetPriority: (item: ScoredItem, priority: number) => void
  onEdit: (item: ScoredItem) => void
  onDelete: (item: ScoredItem) => void
  checked: Set<string>
  onToggle: (id: string) => void
  onBrief: (item: ScoredItem) => void
  briefOf: (id: string) => BriefJob | undefined
}

function ItemGroup({
  group,
  items,
  selectedId,
  ...actions
}: { group: Group; items: ScoredItem[]; selectedId: string | null } & RowActions) {
  if (items.length === 0) return null
  const [tier, qual] = GROUP_TITLE[group].split(' · ')
  return (
    <>
      <div className={`secLabel ${group}`}>
        <span className="tier">{tier}</span>
        {qual && <span className="qual">{qual}</span>}
      </div>
      {items.map((item) => (
        <WorkRow key={item.id} item={item} selected={item.id === selectedId} {...actions} />
      ))}
    </>
  )
}

/**
 * One work item, one line (.docs/work-item-variations.html — variation A).
 *
 * The row is a ledger entry, not a card: state, source and age sit in
 * fixed-width right-aligned cells so they form columns down the page, and
 * scanning happens by alignment rather than by reading a strip of pills. The
 * right-hand cells are the row's one piece of real estate and three things
 * take turns in it, never two at once — the meta columns at rest, the
 * shortcut legend when the row is keyboard-selected, the action cluster on
 * hover. Because they swap in place, nothing reflows under the cursor.
 */
function WorkRow({
  item,
  selected,
  tab,
  watchTitles,
  projectName,
  onSelect,
  onOpen,
  onPin,
  onDispatch,
  onDone,
  onSnooze,
  onArchive,
  onReopen,
  onRefineWatch,
  onSetPriority,
  onEdit,
  onDelete,
  checked,
  onToggle,
  onBrief,
  briefOf,
}: { item: ScoredItem; selected: boolean } & RowActions) {
  const [menuOpen, setMenuOpen] = useState(false)
  const isManual = item.source === 'manual'
  const isOpen = tab === 'open'
  const isChecked = checked.has(item.id)
  const brief = briefPill(briefOf(item.id))
  const pri = item.priority ?? 0
  // watchId now rides in the provenance list; fall back to the item field.
  const watchId = item.watchId ?? item.foundBy?.[item.foundBy.length - 1]?.watchId
  const watchTitle = watchId ? watchTitles.get(watchId) : undefined
  const Icon = kindIcon(item)
  const alert = itemTone(item) === 'red'

  // The state cell speaks only when it has something the glyph does not say:
  // a brief's progress outranks the kind, and "to-do" is what the glyph means.
  const state = brief?.label ?? (isManual ? (watchTitle ?? '') : (KIND_LABEL[item.kind] ?? item.kind))
  const source = projectName(item.projectId) ?? item.repo
  // The scored reason ("2 people waiting · opened 3d ago") is the fallback when
  // the item carries no human note.
  const trailing = item.why || item.reason

  return (
    <div
      className={['wrow', priorityClass(item), selected && 'sel', isChecked && 'checked', menuOpen && 'menu', alert && 'alert']
        .filter(Boolean)
        .join(' ')}
      ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
      onMouseMove={() => !selected && onSelect(item.id)}
    >
      {isOpen ? (
        <button
          type="button"
          className="check"
          title={isChecked ? 'Uncheck (Space)' : 'Check to act on several rows at once (Space)'}
          aria-pressed={isChecked}
          onClick={() => onToggle(item.id)}
        >
          {isChecked ? <CheckSquare size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
        </button>
      ) : (
        <span />
      )}
      <span className="bar" title={pri > 0 ? `Priority: ${PRIORITY_LABEL[pri]}` : undefined} />
      <span className="glyph">
        <Icon size={14} aria-hidden="true" />
      </span>
      <button
        type="button"
        className="t"
        title={item.title}
        {...rowOpen(
          () => onOpen(item.id),
          () => onPin(item.id, item.title),
        )}
      >
        {item.returned && (
          <span className="returned" title="Was done — the source updated since">
            ↩
          </span>
        )}
        <span className="name">{item.title}</span>
        {trailing && <span className="why">{trailing}</span>}
      </button>

      <span className="meta" aria-hidden={selected || undefined}>
        <span className={`c state${brief ? ` ${brief.tone}` : ''}`}>{state}</span>
        <span className="c src">{source}</span>
        <span className="c when" title={item.updatedAt ? new Date(item.updatedAt).toLocaleString() : undefined}>
          {shortAge(item.updatedAt)}
        </span>
      </span>

      {selected && (
        <span className="keys" aria-hidden="true">
          <span>
            <span className="kbd">↵</span> open
          </span>
          <span>
            <span className="kbd">d</span> dispatch
          </span>
          {isOpen && (
            <>
              <span>
                <span className="kbd">e</span> done
              </span>
              <span>
                <span className="kbd">z</span> snooze
              </span>
            </>
          )}
        </span>
      )}

      <span className="acts">
        {isOpen ? (
          <button type="button" className="btn sm primary" title="Start a Claude Code session on this item (d)" onClick={() => onDispatch(item)}>
            Dispatch
          </button>
        ) : (
          <button type="button" className="btn sm primary" title="Move back to the open inbox (e)" onClick={() => onReopen(item)}>
            Reopen
          </button>
        )}
        {isOpen && (
          <>
            <button type="button" className="iconBtn sm" title={brief ? 'Re-brief (b)' : 'Create a brief (b)'} onClick={() => onBrief(item)}>
              <Sparkles size={13} aria-hidden="true" />
            </button>
            <button type="button" className="iconBtn sm green" title="Mark done (e)" onClick={() => onDone(item)}>
              <Check size={14} aria-hidden="true" />
            </button>
            <button type="button" className="iconBtn sm" title="Snooze until tomorrow 9am (z)" onClick={() => onSnooze(item)}>
              <AlarmClock size={13} aria-hidden="true" />
            </button>
          </>
        )}
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <button type="button" className="iconBtn sm" title="More actions">
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="rowMenu">
            <MenuItem onSelect={() => onOpen(item.id)}>
              <ChevronRight size={13} aria-hidden="true" /> Open item<span className="k">↵</span>
            </MenuItem>
            {item.url && (
              <MenuItem onSelect={() => window.open(item.url, '_blank', 'noopener')}>
                <ExternalLink size={13} aria-hidden="true" /> Open at the source<span className="k">o</span>
              </MenuItem>
            )}
            {item.linked?.map((l) => (
              <MenuItem key={l.id} onSelect={() => window.open(l.url, '_blank', 'noopener')}>
                <ExternalLink size={13} aria-hidden="true" /> Also in {l.source} · {l.repo}
              </MenuItem>
            ))}
            {isOpen ? (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => onBrief(item)}>
                  <Sparkles size={13} aria-hidden="true" /> {brief ? 'Re-brief' : 'Create a brief'}
                  <span className="k">b</span>
                </MenuItem>
                <MenuItem onSelect={() => onDispatch(item)}>
                  <Play size={13} aria-hidden="true" /> Dispatch to a session<span className="k">d</span>
                </MenuItem>
                <MenuItem onSelect={() => onDone(item)}>
                  <Check size={13} aria-hidden="true" /> Mark done<span className="k">e</span>
                </MenuItem>
                <MenuItem onSelect={() => onSnooze(item)}>
                  <AlarmClock size={13} aria-hidden="true" /> Snooze to tomorrow<span className="k">z</span>
                </MenuItem>
                <MenuSeparator />
                <div className="uiMenuCap">Priority</div>
                {PRIORITY_VALUES.map((v) => (
                  <MenuItem key={v} onSelect={() => onSetPriority(item, v)}>
                    <span className={`dot sm prio${v}`} aria-hidden="true" />
                    {v === 0 ? 'None' : PRIORITY_LABEL[v]}
                    {v === pri && <Check className="check" size={13} aria-hidden="true" />}
                  </MenuItem>
                ))}
                <MenuSeparator />
                {isManual && (
                  <MenuItem onSelect={() => onEdit(item)}>
                    <Pencil size={13} aria-hidden="true" /> Edit
                  </MenuItem>
                )}
                {watchId && (
                  <MenuItem onSelect={() => onRefineWatch(item)}>
                    <ThumbsDown size={13} aria-hidden="true" /> Bad match — refine this watch
                  </MenuItem>
                )}
                <MenuItem className="danger" onSelect={() => (isManual ? onDelete(item) : onArchive(item))}>
                  {isManual ? <Trash2 size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
                  {isManual ? 'Delete' : 'Archive'}
                  <span className="k">x</span>
                </MenuItem>
              </>
            ) : (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => onReopen(item)}>
                  <Undo2 size={13} aria-hidden="true" /> Move back to open<span className="k">e</span>
                </MenuItem>
                {tab !== 'archived' && (
                  <MenuItem className="danger" onSelect={() => onArchive(item)}>
                    <Archive size={13} aria-hidden="true" /> Archive<span className="k">x</span>
                  </MenuItem>
                )}
              </>
            )}
          </MenuContent>
        </Menu>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item composer: add or edit a manual work item. Title, description, link,
// project, priority — plus screenshots, which are the point: a brief or a
// dispatched session reads the images the same way it reads the description,
// so "here is what's broken" can be a paste rather than a paragraph.
// ---------------------------------------------------------------------------

function ItemComposer({
  open,
  editing,
  projects,
  onClose,
  onSaved,
  onSavedMore,
}: {
  open: boolean
  editing: ScoredItem | null
  projects: Project[]
  onClose: () => void
  onSaved: () => void
  /** Saved with "Add more" on: refresh the inbox, but keep the composer open. */
  onSavedMore: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [priority, setPriority] = useState(0)
  const [description, setDescription] = useState('')
  const [url, setUrl] = useState('')
  const [linkOpen, setLinkOpen] = useState(false)
  /** images the item already holds (edit only) — dropping one here deletes it on save */
  const [kept, setKept] = useState<ItemImage[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [addMore, setAddMore] = useState(false)
  const attach = useAttachments()

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      el.showModal()
      setTitle(editing?.title ?? '')
      setProjectId(editing?.projectId ?? '')
      setPriority(editing?.priority ?? 0)
      setDescription(editing?.description ?? editing?.note ?? '')
      setUrl(editing?.url ?? '')
      setLinkOpen(!!editing?.url)
      setKept(editing?.images ?? [])
      attach.clear()
      setError(null)
    }
    if (!open && el.open) el.close()
  }, [open, editing])

  // One tray, two origins: what the item already holds and what is being
  // pasted now. The strip does not care which is which; removal does.
  const thumbs = [
    ...kept.map((i) => ({ id: i.id, url: editing ? withWorkspace(itemImageUrl(editing.id, i.id)) : '', name: i.name })),
    ...attach.images,
  ]
  const removeThumb = (id: string) => {
    if (kept.some((i) => i.id === id)) setKept((prev) => prev.filter((i) => i.id !== id))
    else attach.remove(id)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      // The complete desired set: refs to keep, then the new pastes.
      const images: ItemImageEdit[] = [
        ...kept.map((i) => ({ id: i.id })),
        ...(attach.payload() ?? []),
      ]
      const payload = {
        title,
        projectId: projectId || undefined,
        priority,
        description: description.trim() || undefined,
        url: url.trim() || undefined,
        images,
      }
      const path = editing ? `/api/items/manual?id=${encodeURIComponent(editing.id)}` : '/api/items/manual'
      const res = await fetch(path, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as ManualItemResponse
      if (!body.ok) {
        setError(body.error)
      } else if (addMore && !editing) {
        // keep the composer open for the next one; clear all but the project
        onSavedMore()
        setTitle('')
        setDescription('')
        setUrl('')
        setLinkOpen(false)
        setPriority(0)
        attach.clear()
        setError(null)
        titleInput.current?.focus()
      } else {
        onSaved()
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog ref={dialog} className="itemComposer" onClose={onClose}>
      <form
        className={dragging ? 'dragging' : undefined}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        // ⌘↵ saves from any field — the description is where you live, and
        // reaching for the button to save a two-line to-do is a tax.
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && title.trim() && !saving) {
            e.preventDefault()
            void save()
          }
        }}
        onPaste={attach.onPaste}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(false)
          void attach.add(e.dataTransfer.files)
        }}
      >
        <div className="composerHead">
          <div className="crumbs">
            <span className="crumb">Inbox</span>
            <span className="crumbSep">›</span>
            <span className="crumb now">{editing ? 'Edit work item' : 'New work item'}</span>
          </div>
          <button type="button" className="composerClose" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <input
          ref={titleInput}
          className="titleInput"
          autoFocus
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="descInput"
          rows={4}
          placeholder="Context, acceptance criteria, or a pasted screenshot — the brief reads all of it."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        {linkOpen && (
          <label className="linkRow">
            <Link2 size={13} aria-hidden="true" />
            <input
              type="url"
              placeholder="https://…"
              value={url}
              autoFocus={!editing?.url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
        )}

        <div className="composerAttachments">
          <AttachmentStrip images={thumbs} error={attach.error} onRemove={removeThumb} />
          {thumbs.length === 0 && !attach.error && (
            <button type="button" className="dropHint" onClick={() => filePicker.current?.click()}>
              <ImagePlus size={12} aria-hidden="true" />
              Paste, drop, or click to attach a screenshot
            </button>
          )}
        </div>

        <input
          ref={filePicker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void attach.add(e.target.files)
            // Reset, so picking the same file twice in a row still fires.
            e.target.value = ''
          }}
        />

        <div className="pillRow">
          <label className={`pill prio${priority}`} title="Priority">
            <Flag size={12} aria-hidden="true" />
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {PRIORITY_VALUES.map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'Priority' : PRIORITY_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
          <label className={`pill${projectId ? ' set' : ''}`} title="Project">
            <Folder size={12} aria-hidden="true" />
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={`pill add${thumbs.length ? ' set' : ''}`}
            onClick={() => filePicker.current?.click()}
            title="Attach screenshots — or just paste them"
          >
            <ImagePlus size={12} aria-hidden="true" />
            {thumbs.length > 0 ? `${thumbs.length} image${thumbs.length === 1 ? '' : 's'}` : 'Image'}
          </button>
          {!linkOpen && (
            <button type="button" className="pill add" onClick={() => setLinkOpen(true)} title="Add a link">
              <Link2 size={12} aria-hidden="true" />
              Link
            </button>
          )}
        </div>

        {error && <div className="msg error">{error}</div>}

        <div className="composerFoot">
          {!editing && (
            <label className="addMore" title="Keep this open to add another after saving">
              <input type="checkbox" checked={addMore} onChange={(e) => setAddMore(e.target.checked)} />
              <span className="switch" aria-hidden="true" />
              Add more
            </label>
          )}
          <div className="footActions">
            <span className="hint">⌘↵</span>
            <button type="button" className="cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="go" disabled={saving || !title.trim()}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add item'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Repo picker: which repos the GitHub source is scoped to, per workspace.
// Empty = no GitHub items (scope is opt-in per workspace — see workspaces.md).
// ---------------------------------------------------------------------------

function RepoPicker({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: (count: number) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog ref={dialog} className="repoDialog" onClose={onClose}>
      <h3>Connected repos</h3>
      <p className="pickerSub">
        The GitHub source only pulls from checked repos, and this scope is per workspace. Nothing
        checked = no GitHub items here.
      </p>
      {open && <RepoScopeEditor onSaved={onSaved} onCancel={onClose} />}
    </dialog>
  )
}
