import {
  ChevronRight,
  CircleDot,
  Eye,
  FileText,
  Folder,
  Home,
  Inbox,
  MessagesSquare,
  PenLine,
  Pin,
  Plus,
  Terminal,
  X,
  type LucideProps,
} from 'lucide-react'
import { useEffect, useRef, useState, type ComponentType, type MouseEvent, type RefObject } from 'react'
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

const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/**
 * What a tab holds. The first three are *processes* — something is alive and
 * would be lost; the rest are *documents*, which is why only they are ever
 * peeked at rather than pinned.
 */
export type TabKind = 'session' | 'terminal' | 'draft' | 'item' | 'artifact' | 'watch' | 'watch-form'

const ICON: Record<TabKind, ComponentType<LucideProps>> = {
  session: MessagesSquare,
  terminal: Terminal,
  draft: PenLine,
  item: CircleDot,
  artifact: FileText,
  watch: Eye,
  'watch-form': Eye,
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
  onSelect: (key: string) => void
  onClose: (key: string) => void
  /** Promote the peeked document to a tab of its own. */
  onPin: (key: string) => void
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

/** The tab band: Inbox pinned, one closable tab per open session or terminal, + for a new session. */
export function TabBand({
  activeKey,
  tabs,
  preview,
  pageTab,
  onInbox,
  onSelect,
  onClose,
  onPin,
  onNew,
  onNewTerminal,
  terminalCwd,
}: Props) {
  const strip = useRef<HTMLDivElement>(null)
  const count = tabs.length + (preview ? 1 : 0) + (pageTab ? 1 : 0)
  const fade = useEdgeFade(strip, count)
  const pageRef = useKeepInView(!!pageTab)

  return (
    <div className="tabband" role="tablist">
      {/* Inbox and the + sit outside the scroller: the way out of a crowded
          band must never be the thing that scrolled off it. */}
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

      <div className="strip" ref={strip} data-fade={fade} role="presentation">
        {tabs.map((t) => (
          <Tab key={t.key} tab={t} active={activeKey === t.key} onSelect={onSelect} onClose={onClose} onPin={onPin} />
        ))}

        {preview && (
          <Tab tab={preview} active={activeKey === preview.key} onSelect={onSelect} onClose={onClose} onPin={onPin} />
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
  onPin,
}: {
  tab: OpenTab
  active: boolean
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onPin: (key: string) => void
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
          className={`tab${active ? ' active' : ''}${tab.preview ? ' preview' : ''}`}
          title={tab.preview ? `${tab.title} — double-click to keep open` : tab.title}
          onClick={() => onSelect(tab.key)}
          onDoubleClick={() => tab.preview && onPin(tab.key)}
          onAuxClick={(e) => e.button === 1 && close(e)}
        >
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
        <CtxMenuItem onSelect={() => onClose(tab.key)}>
          <X size={14} aria-hidden="true" />
          <span className="name">Close</span>
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
          <MessagesSquare size={14} aria-hidden="true" />
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
