import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CircleDot,
  Eye,
  FileDiff,
  FileText,
  Folder,
  Home,
  Inbox,
  MessageSquare,
  PanelLeftOpen,
  PenLine,
  Pin,
  Plus,
  Terminal,
  X,
  XCircle,
  type LucideProps,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
  type MouseEvent,
  type RefObject,
} from 'react'
import type { Project, ProjectsResponse } from '../../../shared/protocol.js'
import {
  CtxMenu,
  CtxMenuContent,
  CtxMenuItem,
  CtxMenuSeparator,
  CtxMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '../ui/Menu.js'
import { MOD_LABEL } from '../keys.js'

const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/**
 * What a tab holds. The first three are *processes* — something is alive and
 * would be lost; the rest are *documents*, which is why only they are ever
 * peeked at rather than pinned.
 */
export type TabKind = 'session' | 'terminal' | 'draft' | 'item' | 'artifact' | 'watch' | 'watch-form' | 'change'

const ICON: Record<TabKind, ComponentType<LucideProps>> = {
  session: MessageSquare,
  terminal: Terminal,
  draft: PenLine,
  item: CircleDot,
  artifact: FileText,
  watch: Eye,
  'watch-form': Eye,
  change: FileDiff,
}

export type OpenTab = {
  /** the tab-band key: a session id, or `<kind>:<id>` for everything else */
  key: string
  kind: TabKind
  title: string
  color: string
  /** live: a working session, or a running shell */
  running: boolean
  /** the peek slot — styled as provisional, and replaced by the next document */
  preview?: boolean
}

export type PageTab = { key: string; label: string; icon: ComponentType<LucideProps> }

type Props = {
  /** 'inbox', a tab key, or a page tab key */
  activeKey: string
  tabs: readonly OpenTab[]
  /** The one document being peeked at, if any — it outlives navigating away. */
  preview?: OpenTab | null
  /** A transient tab for a rail *index* (Watches, Terminals, Artifacts). */
  pageTab?: PageTab | null
  onInbox: () => void
  /** Set while the panel is hidden: its show button leads the band. */
  onShowPanel?: () => void
  onSelect: (key: string) => void
  onClose: (key: string) => void
  /** Close every open tab at once, preview included. */
  onCloseAll: () => void
  /** Promote the peeked document to a tab of its own. */
  onPin: (key: string) => void
  /** Drag a pinned tab: move it to sit before `before`'s key, or to the end when `before` is null. */
  onReorder: (key: string, before: string | null) => void
  onNew: () => void
  /** Open a shell — in `cwd`, or the daemon's default (home) when undefined. */
  onNewTerminal: (cwd?: string) => void
  /** The folder a new terminal opens in by default: the active tab's. */
  terminalCwd?: string
}

/**
 * Which edges still have tabs past them, as a `data-fade` value. The band
 * scrolls once the tabs stop fitting, and a scrolling strip with no edge
 * treatment reads as a clipped one — the fade is the only thing saying
 * "there is more this way".
 */
function useEdgeFade(ref: RefObject<HTMLDivElement | null>, count: number) {
  const [fade, setFade] = useState<'left' | 'right' | 'both' | 'none'>('none')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const left = el.scrollLeft > 1
      // Sub-pixel layout means scrollWidth can sit a hair above clientWidth
      // with nothing actually hidden; a 1px deadband keeps the fade off.
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setFade(left && right ? 'both' : left ? 'left' : right ? 'right' : 'none')
    }
    read()
    el.addEventListener('scroll', read, { passive: true })
    // Resizing the window changes what fits; opening or closing a tab changes
    // what there is to fit, and re-runs this effect through `count`.
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      ro.disconnect()
    }
  }, [ref, count])
  return fade
}

type DragBag = {
  dragging: boolean
  dropEdge: 'before' | 'after' | null
  onDragStart: (e: DragEvent<HTMLButtonElement>) => void
  onDragOver: (e: DragEvent<HTMLButtonElement>) => void
  onDrop: (e: DragEvent<HTMLButtonElement>) => void
  onDragEnd: () => void
}

/** The context-menu path to the same reorder — the keyboard route, since drag is pointer-only. */
type ReorderBag = { canLeft: boolean; canRight: boolean; onLeft: () => void; onRight: () => void }

/**
 * A private MIME type for the drag payload, not `text/plain` — the prompt box
 * and the inbox title field are drop targets everywhere in this app, and a
 * plain-text tab key would land in them as typed text on an overshot drop.
 * Nothing outside the band ever reads this payload (the dragged key lives in
 * state, see below), so an unrecognised type costs nothing; it still has to
 * be *something*, since Firefox won't start a drag with an empty `dataTransfer`.
 */
const TAB_DRAG_TYPE = 'application/x-triage-tab'

/**
 * Native HTML5 drag and drop for the strip — one horizontal list doesn't need
 * a library. `dropBefore` names the key the dragged tab would land in front
 * of (or `null` for the end); it drives both the reorder call and the
 * indicator, so the two can never show a different answer than they act on.
 * Safari won't hand back `dataTransfer` payload during `dragover`, so the
 * dragged key lives in state instead of being read off the event.
 */
function useTabDrag(tabs: readonly OpenTab[], onReorder: (key: string, before: string | null) => void) {
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  // Separate from dragKey: dropBefore's own `null` already means "end of
  // list", so it can't also mean "pointer isn't over a tab right now" — the
  // gap past the last tab, Inbox, the +. Without this the last real target
  // stays painted under the cursor once the drag leaves the strip.
  const [overStrip, setOverStrip] = useState(false)

  const onDragEnd = useCallback(() => {
    setDragKey(null)
    setDropBefore(null)
    setOverStrip(false)
  }, [])

  const onStripDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverStrip(false)
  }, [])

  const bag = useCallback(
    (key: string, index: number): DragBag => ({
      dragging: dragKey === key,
      dropEdge:
        !dragKey || !overStrip
          ? null
          : dropBefore === key
            ? 'before'
            : dropBefore === null && index === tabs.length - 1
              ? 'after'
              : null,
      onDragStart: (e) => {
        e.dataTransfer.setData(TAB_DRAG_TYPE, key)
        e.dataTransfer.effectAllowed = 'move'
        setDragKey(key)
        setDropBefore(key)
        setOverStrip(true)
      },
      onDragOver: (e) => {
        if (!dragKey) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOverStrip(true)
        const rect = e.currentTarget.getBoundingClientRect()
        const before = e.clientX < rect.left + rect.width / 2
        const target = before ? tabs[index].key : (tabs[index + 1]?.key ?? null)
        setDropBefore((cur) => (cur === target ? cur : target))
      },
      onDrop: (e) => {
        e.preventDefault()
        if (dragKey) onReorder(dragKey, dropBefore)
      },
      onDragEnd,
    }),
    [dragKey, dropBefore, overStrip, tabs, onReorder, onDragEnd],
  )

  return { bag, onStripDragLeave }
}

/** The tab band: Inbox pinned, one closable tab per open session or terminal, + for a new session. */
export function TabBand({
  activeKey,
  tabs,
  preview,
  pageTab,
  onInbox,
  onShowPanel,
  onSelect,
  onClose,
  onCloseAll,
  onPin,
  onReorder,
  onNew,
  onNewTerminal,
  terminalCwd,
}: Props) {
  const strip = useRef<HTMLDivElement>(null)
  const count = tabs.length + (preview ? 1 : 0) + (pageTab ? 1 : 0)
  const fade = useEdgeFade(strip, count)
  const pageRef = useKeepInView(!!pageTab)
  const { bag: dragBag, onStripDragLeave } = useTabDrag(tabs, onReorder)

  return (
    <div className="tabband" role="tablist">
      {/* Inbox and the + sit outside the scroller: the way out of a crowded
          band must never be the thing that scrolled off it. */}
      {onShowPanel && (
        <button type="button" className="add showPanel" onClick={onShowPanel} title={`Show panel (${MOD_LABEL}B)`} aria-label="Show panel">
          <PanelLeftOpen size={15} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        role="tab"
        aria-selected={activeKey === 'inbox'}
        className={`tab lead${activeKey === 'inbox' ? ' active' : ''}`}
        onClick={onInbox}
      >
        <Inbox size={13} aria-hidden="true" />
        <span className="t">Inbox</span>
      </button>

      <div className="strip" ref={strip} data-fade={fade} role="presentation" onDragLeave={onStripDragLeave}>
        {tabs.map((t, i) => (
          <Tab
            key={t.key}
            tab={t}
            active={activeKey === t.key}
            onSelect={onSelect}
            onClose={onClose}
            onCloseAll={onCloseAll}
            onPin={onPin}
            drag={dragBag(t.key, i)}
            reorder={{
              canLeft: i > 0,
              canRight: i < tabs.length - 1,
              onLeft: () => onReorder(t.key, tabs[i - 1]?.key ?? null),
              onRight: () => onReorder(t.key, tabs[i + 2]?.key ?? null),
            }}
          />
        ))}

        {preview && (
          <Tab
            tab={preview}
            active={activeKey === preview.key}
            onSelect={onSelect}
            onClose={onClose}
            onCloseAll={onCloseAll}
            onPin={onPin}
          />
        )}

        {pageTab && (
          <button type="button" role="tab" aria-selected className="tab active" ref={pageRef}>
            <pageTab.icon size={13} aria-hidden="true" />
            <span className="t">{pageTab.label}</span>
          </button>
        )}
      </div>

      <NewTabMenu onNew={onNew} onNewTerminal={onNewTerminal} terminalCwd={terminalCwd} />
    </div>
  )
}

/**
 * Hold the selected tab on screen. Selecting happens from the inbox, the
 * command palette and the rail as well as from the band itself, so a tab can
 * become active while sitting well outside the scrolled strip.
 */
function useKeepInView(active: boolean) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!active) return
    ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return ref
}

/**
 * One tab. A session or shell carries its project dot; a document does not.
 * A peeked document is provisional: double-click keeps it, the way a preview
 * editor works everywhere else.
 */
function Tab({
  tab,
  active,
  onSelect,
  onClose,
  onCloseAll,
  onPin,
  drag,
  reorder,
}: {
  tab: OpenTab
  active: boolean
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onCloseAll: () => void
  onPin: (key: string) => void
  /** Present only for pinned tabs — the preview slot and page tab neither drag nor take a drop. */
  drag?: DragBag
  /** Present only for pinned tabs — same reasoning as `drag`, but this is the keyboard/menu route to it. */
  reorder?: ReorderBag
}) {
  const close = (e: MouseEvent) => {
    e.stopPropagation()
    onClose(tab.key)
  }
  const Icon = ICON[tab.kind]
  const dotted = tab.kind === 'session' || tab.kind === 'terminal'
  const ref = useKeepInView(active)
  return (
    <CtxMenu>
      <CtxMenuTrigger asChild>
        <button
          type="button"
          ref={ref}
          role="tab"
          aria-selected={active}
          draggable={!!drag}
          className={`tab${active ? ' active' : ''}${tab.preview ? ' preview' : ''}${drag?.dragging ? ' dragging' : ''}`}
          title={tab.preview ? `${tab.title} — double-click to keep open` : tab.title}
          onClick={() => onSelect(tab.key)}
          onDoubleClick={() => tab.preview && onPin(tab.key)}
          onAuxClick={(e) => e.button === 1 && close(e)}
          onDragStart={drag?.onDragStart}
          onDragOver={drag?.onDragOver}
          onDrop={drag?.onDrop}
          onDragEnd={drag?.onDragEnd}
        >
          {drag?.dropEdge === 'before' && <span className="dropline before" aria-hidden="true" />}
          <Icon size={13} aria-hidden="true" />
          <span className={`t${tab.kind === 'draft' ? ' draft' : ''}`}>
            {dotted && (
              <span className={`pdot${tab.running ? ' live' : ''}`} style={{ background: tab.color }} aria-hidden="true" />
            )}
            {tab.title}
          </span>
          <span className="cl" role="button" aria-label={`Close ${tab.title}`} tabIndex={-1} onClick={close}>
            <X size={11} aria-hidden="true" />
          </span>
          {drag?.dropEdge === 'after' && <span className="dropline after" aria-hidden="true" />}
        </button>
      </CtxMenuTrigger>
      <CtxMenuContent>
        {tab.preview && (
          <>
            <CtxMenuItem onSelect={() => onPin(tab.key)}>
              <Pin size={14} aria-hidden="true" />
              <span className="text">
                <span className="name">Keep open</span>
                <span className="desc">Stop the next document replacing it</span>
              </span>
            </CtxMenuItem>
            <CtxMenuSeparator />
          </>
        )}
        {reorder && (
          <>
            <CtxMenuItem disabled={!reorder.canLeft} onSelect={reorder.onLeft}>
              <ArrowLeft size={14} aria-hidden="true" />
              <span className="name">Move left</span>
            </CtxMenuItem>
            <CtxMenuItem disabled={!reorder.canRight} onSelect={reorder.onRight}>
              <ArrowRight size={14} aria-hidden="true" />
              <span className="name">Move right</span>
            </CtxMenuItem>
            <CtxMenuSeparator />
          </>
        )}
        <CtxMenuItem onSelect={() => onClose(tab.key)}>
          <X size={14} aria-hidden="true" />
          <span className="name">Close</span>
        </CtxMenuItem>
        <CtxMenuItem onSelect={onCloseAll}>
          <XCircle size={14} aria-hidden="true" />
          <span className="name">Close all</span>
        </CtxMenuItem>
      </CtxMenuContent>
    </CtxMenu>
  )
}

/** The "+": a new session, or a new terminal — here, or in a project folder. */
function NewTabMenu({ onNew, onNewTerminal, terminalCwd }: Pick<Props, 'onNew' | 'onNewTerminal' | 'terminalCwd'>) {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])

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
        <button type="button" className="add" title="New tab — session or terminal">
          <Plus size={14} aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="wide">
        <MenuItem onSelect={onNew}>
          <MessageSquare size={14} aria-hidden="true" />
          <span className="text">
            <span className="name">New session</span>
            <span className="desc">Pick the project in the composer</span>
          </span>
          <span className="val">n</span>
        </MenuItem>
        <MenuItem onSelect={() => onNewTerminal(terminalCwd)}>
          <Terminal size={14} aria-hidden="true" />
          <span className="text">
            <span className="name">New terminal</span>
            <span className="desc">{terminalCwd ? homely(terminalCwd) : 'Home folder'}</span>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger className="nav">
            <Folder size={14} aria-hidden="true" />
            <span className="name">Terminal in…</span>
            <ChevronRight size={14} aria-hidden="true" />
          </MenuSubTrigger>
          <MenuSubContent className="wide">
            {projects.map((p) => (
              <MenuItem key={p.id} onSelect={() => onNewTerminal(p.path)}>
                <Folder size={14} aria-hidden="true" />
                <span className="text">
                  <span className="name">{p.name}</span>
                  <span className="desc">{homely(p.path)}</span>
                </span>
              </MenuItem>
            ))}
            {projects.length > 0 && <MenuSeparator />}
            <MenuItem onSelect={() => onNewTerminal(undefined)}>
              <Home size={14} aria-hidden="true" />
              Home folder
            </MenuItem>
          </MenuSubContent>
        </MenuSub>
      </MenuContent>
    </Menu>
  )
}
