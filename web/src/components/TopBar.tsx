import { Activity, Check, ChevronLeft, ChevronRight, ChevronsUpDown, CircleHelp, Gauge, PanelLeft, Plus, Settings, Settings2, SquareArrowOutUpRight } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { goBack, goForward, useDesktopNav } from '../desktop.js'
import { MOD_LABEL } from '../keys.js'
import type { Workspace } from '../../../shared/protocol.js'
import type { ConnState } from '../store.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'
import { basePath } from '../workspaceUrl.js'
import { TriageLogo } from './Logo.js'

type Props = {
  /** Phone layout: a back button and the page title take the logo's place. */
  mobile?: boolean
  title?: string | null
  /** Where back goes from this page; absent on a section's own page. */
  onBack?: () => void
  workspaces: readonly Workspace[]
  workspaceId: string
  conn: ConnState
  onSwitchWorkspace: (id: string) => void
  onNewWorkspace: () => void
  onWorkspaceSettings: () => void
  onOpenSystem: (tab: 'status' | 'activity') => void
  onOpenSettings: () => void
  onHelp: () => void
  /** Inside Triage.app: the bar is the window's title bar (see desktop.ts). */
  desktop?: { panelCollapsed: boolean; onTogglePanel: () => void }
}

const CONN_TITLE: Record<ConnState, string> = {
  connecting: 'Connecting to the daemon…',
  connected: 'Daemon connected — system status',
  disconnected: 'Daemon disconnected — retrying',
}

/** 44px top bar: the logo lockup, the workspace pill, then system / activity / settings / help. */
export function TopBar({
  mobile,
  title,
  onBack,
  workspaces,
  workspaceId,
  conn,
  onSwitchWorkspace,
  onNewWorkspace,
  onWorkspaceSettings,
  onOpenSystem,
  onOpenSettings,
  onHelp,
  desktop,
}: Props) {
  if (desktop && !mobile) {
    return (
      <DesktopBar
        {...desktop}
        switcher={
          <WorkspaceSwitcher
            workspaces={workspaces}
            workspaceId={workspaceId}
            onSwitch={onSwitchWorkspace}
            onNew={onNewWorkspace}
            onSettings={onWorkspaceSettings}
          />
        }
        system={<SystemIcons conn={conn} onOpenSystem={onOpenSystem} onOpenSettings={onOpenSettings} onHelp={onHelp} />}
      />
    )
  }
  if (mobile) {
    return (
      <header className="topbar mobile">
        {onBack ? (
          <button type="button" className="topIcon back" aria-label="Back" onClick={onBack}>
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
        ) : (
          <TriageLogo />
        )}
        {onBack && title && <span className="topTitle">{title}</span>}
        <span className="spacer" />
        <WorkspaceSwitcher
          workspaces={workspaces}
          workspaceId={workspaceId}
          onSwitch={onSwitchWorkspace}
          onNew={onNewWorkspace}
          onSettings={onWorkspaceSettings}
        />
        <button type="button" className="topIcon" aria-label={CONN_TITLE[conn]} onClick={() => onOpenSystem('status')}>
          <Gauge size={17} aria-hidden="true" />
          <span className={`connDot ${conn === 'connected' ? '' : conn === 'connecting' ? 'connecting' : 'down'}`} aria-hidden="true" />
        </button>
        <button type="button" className="topIcon" aria-label="Settings" onClick={onOpenSettings}>
          <Settings size={17} aria-hidden="true" />
        </button>
      </header>
    )
  }
  return (
    <header className="topbar">
      <TriageLogo />
      <WorkspaceSwitcher
        workspaces={workspaces}
        workspaceId={workspaceId}
        onSwitch={onSwitchWorkspace}
        onNew={onNewWorkspace}
        onSettings={onWorkspaceSettings}
      />
      <span className="spacer" />
      <SystemIcons conn={conn} onOpenSystem={onOpenSystem} onOpenSettings={onOpenSettings} onHelp={onHelp} />
    </header>
  )
}

/** System status, activity, settings, help — the right end of the bar. */
function SystemIcons({
  conn,
  onOpenSystem,
  onOpenSettings,
  onHelp,
}: Pick<Props, 'conn' | 'onOpenSystem' | 'onOpenSettings' | 'onHelp'>) {
  return (
    <>
      <button type="button" className="topIcon" title={CONN_TITLE[conn]} onClick={() => onOpenSystem('status')}>
        <Gauge size={15} aria-hidden="true" />
        <span className={`connDot ${conn === 'connected' ? '' : conn === 'connecting' ? 'connecting' : 'down'}`} aria-hidden="true" />
      </button>
      <button type="button" className="topIcon" title="Watch runs and activity" onClick={() => onOpenSystem('activity')}>
        <Activity size={15} aria-hidden="true" />
      </button>
      <button type="button" className="topIcon" title={`Settings (${MOD_LABEL},)`} onClick={onOpenSettings}>
        <Settings size={15} aria-hidden="true" />
      </button>
      <button type="button" className="topIcon" title="Keyboard shortcuts (?)" onClick={onHelp}>
        <CircleHelp size={15} aria-hidden="true" />
      </button>
    </>
  )
}

/**
 * Triage.app's title bar (.docs/titlebar-variations.html, E). Two zones that
 * line up with the columns below: over the rail + panel, the traffic lights,
 * the lockup, the panel toggle and ← →; over the content, the workspace and
 * the system icons. With the panel hidden the zones run together as one row.
 * Empty space drags the window; double-clicking it zooms (both native).
 */
function DesktopBar({
  panelCollapsed,
  onTogglePanel,
  switcher,
  system,
}: {
  panelCollapsed: boolean
  onTogglePanel: () => void
  switcher: ReactNode
  system: ReactNode
}) {
  const nav = useDesktopNav()
  return (
    <header className={`topbar desktopBar${panelCollapsed ? ' panelHidden' : ''}${nav.fullscreen ? ' fullscreen' : ''}`}>
      <div className="dbSide">
        <TriageLogo />
        <span className="spacer" />
        <button
          type="button"
          className="topIcon"
          title={`${panelCollapsed ? 'Show' : 'Hide'} panel (${MOD_LABEL}B)`}
          aria-label={panelCollapsed ? 'Show panel' : 'Hide panel'}
          aria-pressed={!panelCollapsed}
          onClick={onTogglePanel}
        >
          <PanelLeft size={15} aria-hidden="true" />
        </button>
        <button type="button" className="topIcon" title={`Back (${MOD_LABEL}[)`} aria-label="Back" disabled={!nav.canGoBack} onClick={goBack}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button type="button" className="topIcon" title={`Forward (${MOD_LABEL}])`} aria-label="Forward" disabled={!nav.canGoForward} onClick={goForward}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="dbMain">
        {switcher}
        <span className="spacer" />
        {system}
      </div>
    </header>
  )
}

/**
 * The workspace switcher (.docs/workspaces.md): which world am I in, and the
 * door to the others. The colour dot is the ambient signal; the menu lists
 * every workspace (active checked), plus New and Settings.
 */
function WorkspaceSwitcher({
  workspaces,
  workspaceId,
  onSwitch,
  onNew,
  onSettings,
}: {
  workspaces: readonly Workspace[]
  workspaceId: string
  onSwitch: (id: string) => void
  onNew: () => void
  onSettings: () => void
}) {
  // A tab is bound to its workspace by its URL, so a workspace row is really a
  // link: ⌘/Ctrl-click opens it in a second tab instead of moving this one.
  // Radix drives rows through `onSelect`, which does not carry the modifier —
  // the pointer event that preceded it does, so stash it there.
  const newTab = useRef(false)
  // The glyph swallows its own pointer events (below), so Radix never selects
  // the row for it and never closes the menu either — we hold `open` to do it.
  const [open, setOpen] = useState(false)
  const active = workspaces.find((w) => w.id === workspaceId)
  if (!active) return null // hello not in yet
  const openInNewTab = (id: string) => {
    window.open(basePath(id), '_blank', 'noopener')
    setOpen(false)
  }
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        newTab.current = false
        setOpen(next)
      }}
    >
      <MenuTrigger asChild>
        <button type="button" className="wsPill" title={`Workspace: ${active.name}`}>
          <span className="wsDot" style={{ background: active.color }} aria-hidden="true" />
          <span className="wsName">{active.name}</span>
          <ChevronsUpDown size={11} aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="wsMenu">
        {workspaces.map((w) => (
          <MenuItem
            key={w.id}
            title={`${w.name} — ${MOD_LABEL}-click to open in a new tab`}
            onPointerDown={(e) => (newTab.current = e.metaKey || e.ctrlKey || e.button === 1)}
            onSelect={() => {
              if (newTab.current) openInNewTab(w.id)
              else if (w.id !== workspaceId) onSwitch(w.id)
              newTab.current = false
            }}
          >
            <span className="wsDot" style={{ background: w.color }} aria-hidden="true" />
            <span className="wsMenuName">
              {w.name}
              {w.isDefault && <em className="wsDefaultTag">default</em>}
            </span>
            {/* The modifier, spelled out as a glyph. It keeps every pointer
                event to itself: Radix selects an item on click *and* on a
                pointer-up it did not see the pointer-down for, so letting any
                of the three through would also switch this tab. */}
            <span
              className="wsOpenTab"
              aria-hidden="true"
              title={`Open in a new tab (${MOD_LABEL}-click)`}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                openInNewTab(w.id)
              }}
            >
              <SquareArrowOutUpRight size={12} aria-hidden="true" />
            </span>
            {w.id === workspaceId && <Check size={13} aria-hidden="true" />}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={onNew}>
          <Plus size={14} aria-hidden="true" />
          New workspace…
        </MenuItem>
        <MenuItem onSelect={onSettings}>
          <Settings2 size={14} aria-hidden="true" />
          Workspace settings…
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
