import { FileText, Eye, Terminal as TerminalIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { DispatchPreviewResponse,
  EffortLevel,
  ImageAttachment,
  Mention,
  PermissionBehavior,
  PermissionMode,
  Project,
  ProjectsResponse,
  QuestionAnswers,
  ScoredItem,
  SessionStatus,
  TerminalSummary,
  WatchesResponse,
} from '../../shared/protocol.js'
import { CommandPalette } from './components/CommandPalette.js'
import { useSessionChanges } from './useSessionChanges.js'
import { ChangesDrawer } from './components/ChangesDrawer.js'
import { Composer } from './components/Composer.js'
import { ArtifactsPanel, NewTerminalMenu, QueuePanel, SessionsPanel, TerminalsPanel } from './components/ContextPanel.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { InboxPage } from './components/InboxPage.js'
import { ItemPage } from './components/ItemPage.js'
import { NewSessionComposer, type NewSession } from './components/NewSessionComposer.js'
import { Rail, type RailSection } from './components/Rail.js'
import { SettingsModal } from './components/SettingsModal.js'
import { SystemModal, type SystemTab } from './components/SystemModal.js'
import { TabBand, type OpenTab, type PageTab, type TabKind } from './components/TabBand.js'
import { dispatchPrompt, dispatchTitle } from './dispatch.js'
import { draftStore, draftTitle, useDrafts } from './drafts.js'
import { TerminalPage } from './components/TerminalPage.js'
import { TopBar } from './components/TopBar.js'
import { Transcript } from './components/Transcript.js'
import { WatchesPage } from './components/WatchesPage.js'
import { REFINE_WATCH_KEY, WatchFormPage } from './components/WatchFormPage.js'
import { WatchPage } from './components/WatchPage.js'
import { ArtifactsPage } from './components/ArtifactsPage.js'
import { ArtifactPage } from './components/ArtifactPage.js'
import { WorkspaceModal, type WorkspaceModalMode } from './components/WorkspaceModal.js'
import {
  itemHash,
  useConn,
  useEvents,
  useHashRoute,
  useOnboarded,
  useSessions,
  useTerminals,
  useWorkspaceId,
  useWorkspaces,
  type Route,
} from './hooks.js'
import { inboxStore, useInbox } from './inboxStore.js'
import { artifactStore, useArtifacts } from './artifactStore.js'
import { anyDialogOpen, isTypingTarget } from './keys.js'
import { EFFORT_LABEL, findModel, useModels } from './models.js'
import { openSettings } from './settings.js'
import { store } from './store.js'
import { usePanelWidth } from './panelWidth.js'
import { projectColor, useLastRoutes, useOpenTabs } from './tabs.js'

/** `/Users/you/Code/x` → `~/Code/x` — display only. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  running: 'working',
  idle: 'idle',
  error: 'error',
}

const PAGE_TABS: Record<'watches' | 'terminals' | 'artifacts', PageTab> = {
  terminals: { key: 'page:terminals', label: 'Terminals', icon: TerminalIcon },
  artifacts: { key: 'page:artifacts', label: 'Artifacts', icon: FileText },
  watches: { key: 'page:watches', label: 'Watches', icon: Eye },
}

const termKey = (id: string) => `term:${id}`
const draftKey = (id: string) => `draft:${id}`
const draftRoute = (id: string) => `/new/${id}`

/**
 * The tab-band key for a route, or null when the route is not a tab at all
 * (`home` redirects, `settings` is a modal). Sessions keep the bare id they
 * have always had; everything else is `<kind>:<id>`.
 */
function tabKeyOf(route: Route): string | null {
  switch (route.page) {
    case 'inbox':
      return 'inbox'
    case 'session':
      return route.id
    case 'draft':
      return draftKey(route.id)
    case 'terminal':
      return termKey(route.id)
    case 'item':
      return `item:${route.id}`
    case 'artifact':
      return `artifact:${route.id}`
    case 'watch':
      return `watch:${route.id}`
    case 'watch-form':
      return `watch-form:${route.id ?? 'new'}`
    case 'artifacts':
    case 'watches':
    case 'terminals':
      return PAGE_TABS[route.page].key
    case 'home':
    case 'settings':
      return null
  }
}

/** The route a tab key points back at — the inverse of `tabKeyOf`. */
function routeOfKey(key: string): string {
  const cut = key.indexOf(':')
  const id = cut === -1 ? '' : key.slice(cut + 1)
  switch (cut === -1 ? '' : key.slice(0, cut)) {
    case 'term':
      return `/terminal/${id}`
    case 'draft':
      return draftRoute(id)
    case 'item':
      return itemHash(id)
    case 'artifact':
      return `/artifact/${id}`
    case 'watch':
      return `/watches/${encodeURIComponent(id)}`
    case 'watch-form':
      return id === 'new' ? '/watches/new' : `/watches/${encodeURIComponent(id)}/edit`
    case 'page':
      return `/${id}`
    default:
      // a bare session id, or the pinned inbox
      return key === 'inbox' ? '/inbox' : key
  }
}

/** Documents are peeked at; processes are pinned. */
const DOC_KINDS: readonly TabKind[] = ['item', 'artifact', 'watch', 'watch-form']

function kindOfKey(key: string): TabKind | null {
  const cut = key.indexOf(':')
  // A session is the one key with no prefix; the pinned inbox is not a kind.
  if (cut === -1) return key === 'inbox' ? null : 'session'
  const p = key.slice(0, cut)
  if (p === 'term') return 'terminal'
  if (p === 'draft') return 'draft'
  return DOC_KINDS.includes(p as TabKind) ? (p as TabKind) : null
}

/** A document is peeked at by default; a process is pinned from the start. */
function isDocKey(key: string): boolean {
  const kind = kindOfKey(key)
  return !!kind && DOC_KINDS.includes(kind)
}

/** What a document tab is called before its store has caught up. */
const GENERIC: Record<TabKind, string> = {
  session: 'Session',
  terminal: 'Terminal',
  draft: 'Draft',
  item: 'Work item',
  artifact: 'Artifact',
  watch: 'Watch',
  'watch-form': 'Watch',
}

/**
 * Which rail section a route belongs to: the rail's highlight, and the key
 * rail memory is filed under.
 */
function sectionOf(route: Route): RailSection | null {
  switch (route.page) {
    case 'inbox':
    case 'item':
      return 'inbox'
    case 'home':
    case 'session':
    case 'draft':
      return 'sessions'
    case 'terminal':
    case 'terminals':
      return 'terminals'
    case 'artifact':
    case 'artifacts':
      return 'artifacts'
    case 'watch':
    case 'watch-form':
    case 'watches':
      return 'watches'
    case 'settings':
      return null
  }
}

export function App() {
  const conn = useConn()
  const sessions = useSessions()
  const terminals = useTerminals()
  const drafts = useDrafts()
  const models = useModels()
  const inbox = useInbox()
  const artifacts = useArtifacts()
  const [route, navigate] = useHashRoute()
  const currentId = route.page === 'session' ? route.id : null
  const currentTerminalId = route.page === 'terminal' ? route.id : null
  const currentDraftId = route.page === 'draft' ? route.id : null
  const events = useEvents(currentId)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // A diff selection quoted into the composer; the nonce makes a repeat land.
  const [quote, setQuote] = useState({ text: '', nonce: 0 })
  // Fetched once per session and shared by the transcript's turn markers and
  // the changes drawer.
  const sessionChanges = useSessionChanges(currentId)
  const [helpOpen, setHelpOpen] = useState(false)
  const [system, setSystem] = useState<{ open: boolean; tab: SystemTab }>({ open: false, tab: 'status' })
  const [composeSignal, setComposeSignal] = useState(0)
  const workspaces = useWorkspaces()
  const workspaceId = useWorkspaceId()
  const onboarded = useOnboarded()
  const [wsModal, setWsModal] = useState<WorkspaceModalMode | null>(null)
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null
  const { tabs, preview, titles, open: openTab, close: closeTab, replace: replaceTab, setPreview, remember } =
    useOpenTabs(workspaceId)

  /** Every document the band is holding — pinned or peeked. */
  const docKeys = useMemo(
    () => [...tabs, ...(preview ? [preview] : [])].filter((k) => isDocKey(k)),
    [tabs, preview],
  )
  const { lastRoutes, record: recordRoute } = useLastRoutes(workspaceId)
  const panelSize = usePanelWidth()

  // First run: the workspace modal doubles as onboarding — introduce the
  // concept, name the default workspace, pick the Claude auth method.
  useEffect(() => {
    if (!onboarded && activeWorkspace) {
      setWsModal({ kind: 'onboarding', workspace: activeWorkspace })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded, activeWorkspace?.id])
  // pending "g" prefix for two-key sequences (g i, g s, g w, g p, g c)
  const goPrefix = useRef<number | undefined>(undefined)

  const current = sessions.find((s) => s.id === currentId) ?? null
  const currentTerminal = terminals.find((t) => t.id === currentTerminalId) ?? null
  const currentDraft = drafts.find((d) => d.id === currentDraftId) ?? null
  // Drafts are per workspace; bind before anything reads them.
  useEffect(() => draftStore.bind(workspaceId), [workspaceId])
  // Name the workspace in the tab title — with one tab per workspace, the
  // favicon alone cannot tell them apart.
  useEffect(() => {
    document.title = activeWorkspace ? `triage • ${activeWorkspace.name}` : 'triage'
  }, [activeWorkspace?.name])
  // The old home route: the inbox is the product's home now.
  useEffect(() => {
    if (route.page === 'home') navigate('/inbox')
  }, [route.page, navigate])

  // `#/settings/<tab>` is a door, not a page: open the modal on that tab and
  // put the URL back on whatever was underneath (the inbox on a cold load).
  const lastPageHash = useRef('/inbox')
  useEffect(() => {
    if (route.page === 'settings') {
      openSettings(route.tab)
      navigate(lastPageHash.current)
    } else if (route.page !== 'home') {
      lastPageHash.current = location.hash.slice(1) || '/inbox'
    }
  }, [route, navigate])

  // Watches have no client store; the band needs their titles, so fetch the
  // (small) list once the first watch is in play and keep it.
  const [watchTitles, setWatchTitles] = useState<Map<string, string>>(new Map())
  const wantWatchTitles = sectionOf(route) === 'watches' || docKeys.some((k) => k.startsWith('watch'))
  useEffect(() => {
    if (conn !== 'connected' || !wantWatchTitles) return
    void fetch('/api/watches')
      .then((r) => r.json() as Promise<WatchesResponse>)
      .then((b) => {
        if (b.ok) setWatchTitles(new Map(b.watches.map((w) => [w.id, w.title])))
      })
      .catch(() => {})
  }, [conn, wantWatchTitles])

  /** The live name for a document tab, or null while its store is still cold. */
  const liveTitle = useCallback(
    (key: string): string | null => {
      const id = key.slice(key.indexOf(':') + 1)
      if (key.startsWith('item:')) return inbox.items.find((i) => i.id === id)?.title ?? null
      if (key.startsWith('artifact:')) return artifacts.artifacts.find((a) => a.id === id)?.title ?? null
      if (key.startsWith('watch:')) return watchTitles.get(id) ?? null
      if (key.startsWith('watch-form:')) return id === 'new' ? 'New watch' : watchTitles.get(id) ?? null
      return null
    },
    [inbox.items, artifacts.artifacts, watchTitles],
  )

  /** A document tab: its best known name, no project dot, nothing running. */
  const docTab = useCallback(
    (key: string): OpenTab | null => {
      const kind = kindOfKey(key)
      if (!kind) return null
      return { key, kind, title: (liveTitle(key) ?? titles[key]) || GENERIC[kind], color: 'var(--stone)', running: false }
    },
    [liveTitle, titles],
  )

  /** Commit a peeked document to a real tab — it stops being replaceable. */
  const pin = useCallback(
    (key: string, title?: string) => {
      if (title) remember({ [key]: title })
      openTab(key)
    },
    [openTab, remember],
  )

  /** Editing what you were only peeking at makes it yours: keep the tab. */
  const pinCurrent = useCallback(() => {
    const key = tabKeyOf(route)
    if (key && isDocKey(key)) openTab(key)
  }, [route, openTab])

  // The peek slot: opening a document parks it in the band so it survives you
  // looking at a session.
  useEffect(() => {
    const key = tabKeyOf(route)
    if (key && isDocKey(key)) setPreview(key)
  }, [route, setPreview])

  // Names arrive after the tab does — stores load, things get renamed. Teach
  // the band every name it can currently resolve.
  useEffect(() => {
    const patch: Record<string, string> = {}
    for (const k of docKeys) {
      const t = liveTitle(k)
      if (t) patch[k] = t
    }
    if (Object.keys(patch).length) remember(patch)
  }, [docKeys, liveTitle, remember])

  // Rail memory: remember where you were in each section, so leaving and
  // coming back lands on what you were reading rather than the section root.
  useEffect(() => {
    const section = sectionOf(route)
    // `home` redirects to the inbox above; `settings` is a modal, not a place.
    if (!section || route.page === 'home') return
    recordRoute(section, location.hash.slice(1) || '/inbox')
  }, [route, recordRoute])

  // The open inbox feeds the rail badge and the Queue panel from the start.
  useEffect(() => {
    if (conn === 'connected') void inboxStore.refresh()
  }, [conn])
  // The Artifacts panel lists from the index; load it when that world is in front.
  useEffect(() => {
    const wanted = route.page === 'artifacts' || route.page === 'artifact' || docKeys.some((k) => k.startsWith('artifact:'))
    if (conn === 'connected' && wanted) void artifactStore.refresh()
  }, [conn, route.page, docKeys])

  // A session created from this tab becomes the selected one — and when it
  // came from a draft tab, it takes that tab's slot.
  const pendingDraft = useRef<string | null>(null)
  useEffect(
    () =>
      store.onSessionCreated((s) => {
        const d = pendingDraft.current
        pendingDraft.current = null
        if (d) {
          replaceTab(draftKey(d), s.id)
          draftStore.remove(d)
        }
        navigate(s.id)
      }),
    [navigate, replaceTab],
  )
  useEffect(() => store.onTerminalCreated((t) => navigate(`/terminal/${t.id}`)), [navigate])

  // A visited terminal or draft gets a tab too.
  useEffect(() => {
    if (currentTerminalId) openTab(termKey(currentTerminalId))
  }, [currentTerminalId, openTab])
  useEffect(() => {
    if (currentDraftId) openTab(draftKey(currentDraftId))
  }, [currentDraftId, openTab])

  // Replay the log whenever the selection changes (and after a reconnect);
  // a visited session gets a tab.
  useEffect(() => {
    if (currentId) {
      store.subscribeSession(currentId)
      openTab(currentId)
    }
  }, [currentId, conn, openTab])

  const respond = useCallback(
    (requestId: string, behavior: PermissionBehavior, answers?: QuestionAnswers) => {
      if (currentId)
        store.send({ type: 'permission_response', sessionId: currentId, requestId, behavior, answers })
    },
    [currentId],
  )

  const sendMessage = useCallback(
    (text: string, images?: ImageAttachment[], mentions?: Mention[]) => {
      if (currentId) store.send({ type: 'user_message', sessionId: currentId, text, images, mentions })
    },
    [currentId],
  )

  const setModel = useCallback(
    (model: string | undefined, effort: EffortLevel | undefined) => {
      if (currentId) store.send({ type: 'set_model', sessionId: currentId, model, effort })
    },
    [currentId],
  )

  const setFastMode = useCallback(
    (fastMode: boolean) => {
      if (currentId) store.send({ type: 'set_fast_mode', sessionId: currentId, fastMode })
    },
    [currentId],
  )

  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      if (currentId) store.send({ type: 'set_permission_mode', sessionId: currentId, mode })
    },
    [currentId],
  )

  const interrupt = useCallback(() => {
    if (currentId) store.send({ type: 'interrupt', sessionId: currentId })
  }, [currentId])

  const renameSession = useCallback((sessionId: string, title: string) => {
    store.send({ type: 'rename_session', sessionId, title })
  }, [])

  const setPinned = useCallback((sessionId: string, pinned: boolean) => {
    store.send({ type: 'set_pinned', sessionId, pinned })
  }, [])

  const deleteSession = useCallback(
    (sessionId: string) => {
      store.send({ type: 'delete_session', sessionId })
      closeTab(sessionId)
      // Deleting what you are looking at leaves nothing to look at.
      if (sessionId === currentId) navigate('')
    },
    [currentId, navigate, closeTab],
  )

  // New session = a draft tab. An untouched draft is reused rather than
  // stacking blank tabs; a folder-specific one is always fresh.
  const newSession = useCallback(() => {
    const d = draftStore.findEmpty() ?? draftStore.create()
    navigate(draftRoute(d.id))
  }, [navigate])

  const newSessionIn = useCallback(
    (project: Project) => {
      const d = draftStore.create({ cwd: project.path })
      navigate(draftRoute(d.id))
    },
    [navigate],
  )

  const discardDraft = useCallback(
    (id: string) => {
      draftStore.remove(id)
      closeTab(draftKey(id))
      if (id === currentDraftId) navigate('/inbox')
    },
    [closeTab, currentDraftId, navigate],
  )

  const syncInbox = useCallback(() => {
    void inboxStore.refresh(true).finally(() => navigate('/inbox'))
  }, [navigate])

  const openItem = useCallback((id: string) => navigate(itemHash(id)), [navigate])

  // Terminals: open in a folder (the server falls back to home), rename, kill.
  const newTerminal = useCallback((cwd?: string) => {
    store.send({ type: 'terminal_create', cwd })
  }, [])
  const renameTerminal = useCallback((terminalId: string, title: string) => {
    store.send({ type: 'terminal_rename', terminalId, title })
  }, [])
  const closeTerminal = useCallback(
    (terminalId: string) => {
      store.send({ type: 'terminal_close', terminalId })
      closeTab(termKey(terminalId))
      if (terminalId === currentTerminalId) {
        const rest = terminals.filter((t) => t.id !== terminalId)
        navigate(rest.length ? `/terminal/${rest[rest.length - 1].id}` : '/terminals')
      }
    },
    [closeTab, currentTerminalId, terminals, navigate],
  )
  // Where "+" opens a shell: the folder of whatever tab is in front.
  const terminalCwd = current?.cwd ?? currentTerminal?.cwd ?? currentDraft?.cwd

  // Back to a section lands on what you were last doing there; clicking the
  // section you are already in pops to its root (Inbox, Artifacts, Watches).
  // Sessions and Terminals have no index page — their list *is* the panel — so
  // they keep their own "take me to the live one" fallback chain instead.
  const goTo = useCallback(
    (section: RailSection) => {
      const back = sectionOf(route) === section ? undefined : lastRoutes[section]
      if (section === 'sessions') {
        // A remembered session that has since been deleted is no memory at all.
        const alive = back?.startsWith('/new/')
          ? drafts.some((d) => d.id === back.slice('/new/'.length))
          : !!back && sessions.some((s) => s.id === back)
        // The remembered one, else the session in front, else the last session
        // tab, else a fresh draft.
        const last = (alive ? back : undefined) ?? currentId ?? [...tabs].reverse().find((k) => sessions.some((s) => s.id === k))
        if (last) navigate(last)
        else newSession()
      } else if (section === 'terminals') {
        const id = back?.startsWith('/terminal/') ? back.slice('/terminal/'.length) : undefined
        if (id && terminals.some((t) => t.id === id)) navigate(`/terminal/${id}`)
        else {
          const last = currentTerminalId ?? terminals[terminals.length - 1]?.id
          navigate(last ? `/terminal/${last}` : '/terminals')
        }
      } else navigate(back ?? (section === 'inbox' ? '/inbox' : `/${section}`))
    },
    [navigate, route, lastRoutes, currentId, currentTerminalId, terminals, tabs, sessions, drafts, newSession],
  )

  // Closing the tab you are on lands you on its neighbour, else the inbox.
  // A terminal tab closing does not kill the shell — that is the panel's menu.
  const activeTabKey = tabKeyOf(route) ?? 'home'
  const closeOpenTab = useCallback(
    (key: string) => {
      if (key === activeTabKey) {
        // A pinned tab hands over to its neighbour; the preview has none.
        const i = tabs.indexOf(key)
        const next = i === -1 ? undefined : tabs[i + 1] ?? tabs[i - 1]
        navigate(next ? routeOfKey(next) : '/inbox')
      }
      // Closing a draft tab discards the draft — there is nowhere else it lives.
      if (key.startsWith('draft:')) draftStore.remove(key.slice(6))
      closeTab(key)
    },
    [tabs, activeTabKey, navigate, closeTab],
  )

  // Global hotkeys. ⌘K works everywhere (even in inputs); single keys only
  // outside text fields and while no dialog is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setHelpOpen(false)
        setPaletteOpen((v) => !v)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setHelpOpen(false)
        setPaletteOpen(false)
        openSettings()
        return
      }
      if (isTypingTarget(e) || anyDialogOpen() || e.metaKey || e.ctrlKey || e.altKey) return

      if (goPrefix.current !== undefined) {
        clearTimeout(goPrefix.current)
        goPrefix.current = undefined
        if (e.key === 'i') return goTo('inbox')
        if (e.key === 's') return goTo('sessions')
        if (e.key === 't') return goTo('terminals')
        if (e.key === 'c') return openSettings('connectors')
        if (e.key === 'p') return openSettings('projects')
        if (e.key === 'w') return goTo('watches')
        return // unknown sequence — swallow
      }
      if (e.key === 'g') {
        goPrefix.current = window.setTimeout(() => (goPrefix.current = undefined), 1000)
        return
      }
      if (e.key === 'n') {
        e.preventDefault()
        // In the inbox, `n` is "new work item"; among terminals, a new shell;
        // everywhere else, a new session.
        if (route.page === 'inbox') setComposeSignal((n) => n + 1)
        else if (route.page === 'terminal' || route.page === 'terminals') newTerminal(terminalCwd)
        else if (route.page === 'artifacts' || route.page === 'artifact') navigate('/artifact/new')
        else newSession()
      } else if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, newSession, newTerminal, terminalCwd, goTo, currentId, route.page])

  const create = useCallback((draftId: string, s: NewSession) => {
    pendingDraft.current = draftId
    store.send({
      type: 'create_session',
      title: s.title,
      cwd: s.cwd,
      firstMessage: s.firstMessage || undefined,
      model: s.model,
      effort: s.effort,
      fastMode: s.fastMode,
      permissionMode: s.permissionMode,
      images: s.images,
      mentions: s.mentions,
      itemId: s.itemId,
    })
  }, [])

  const addWatch = useCallback(() => navigate('/watches/new'), [navigate])

  // Thumbs-down on a matched item: the correction lands as appended text on
  // the watch's instruction — the rule stays human-readable.
  const refineWatch = useCallback(
    (item: ScoredItem) => {
      if (!item.watchId) return
      sessionStorage.setItem(REFINE_WATCH_KEY, JSON.stringify({ watchId: item.watchId, note: item.title }))
      navigate(`/watches/${encodeURIComponent(item.watchId)}/edit`)
    },
    [navigate],
  )

  // Dispatch = a draft tab prefilled by the server (.docs/next-version.md):
  // the kind's template, the item's description, and the brief as an
  // `@artifact:` mention when one exists. The old client-side prompt stays
  // as the fallback when the preview cannot be fetched.
  const dispatch = useCallback(
    (item: ScoredItem) => {
      const openWith = (init: { cwd?: string; text: string; mentions?: Mention[] }) => {
        const d = draftStore.create({ label: dispatchTitle(item), itemId: item.id, ...init })
        navigate(draftRoute(d.id))
      }
      void fetch(`/api/dispatch/preview?itemId=${encodeURIComponent(item.id)}`)
        .then((r) => r.json() as Promise<DispatchPreviewResponse>)
        .then((b) => {
          if (!b.ok) throw new Error(b.error)
          openWith({ cwd: b.preview.cwd ?? undefined, text: b.preview.text, mentions: b.preview.mentions })
        })
        .catch(() =>
          fetch('/api/projects')
            .then((r) => r.json() as Promise<ProjectsResponse>)
            .then((p) => {
              const match =
                p.ok &&
                ((item.projectId && p.projects.find((x) => x.id === item.projectId)) ||
                  (item.repo && p.projects.find((x) => x.repo && x.repo === item.repo)))
              openWith({ cwd: match ? match.path : undefined, text: dispatchPrompt(item) })
            })
            .catch(() => openWith({ text: dispatchPrompt(item) })),
        )
    },
    [navigate],
  )

  // --- derived shell state -------------------------------------------------

  const railActive: RailSection | null = sectionOf(route)

  const openTabs = useMemo<OpenTab[]>(
    () =>
      tabs.flatMap((key): OpenTab[] => {
        if (key.startsWith('draft:')) {
          const d = drafts.find((x) => x.id === key.slice(6))
          return d ? [{ key, kind: 'draft', title: draftTitle(d), color: 'var(--stone)', running: false }] : []
        }
        if (key.startsWith('term:')) {
          const t: TerminalSummary | undefined = terminals.find((x) => x.id === key.slice(5))
          return t ? [{ key, kind: 'terminal', title: t.title, color: projectColor(t.cwd), running: t.status === 'running' }] : []
        }
        if (isDocKey(key)) {
          const t = docTab(key)
          return t ? [t] : []
        }
        const s = sessions.find((x) => x.id === key)
        return s
          ? [{ key, kind: 'session', title: s.title, color: projectColor(s.cwd), running: s.status === 'running' || s.status === 'starting' }]
          : []
      }),
    [tabs, sessions, terminals, drafts, docTab],
  )

  // Only the rail *indexes* get a transient page tab now: an artifact, watch
  // or item in front is a document, and gets a real tab of its own.
  const pageTab =
    route.page === 'watches' || route.page === 'terminals' || route.page === 'artifacts' ? PAGE_TABS[route.page] : null

  const previewTab = useMemo<OpenTab | null>(() => {
    const t = preview ? docTab(preview) : null
    return t ? { ...t, preview: true } : null
  }, [preview, docTab])

  // Brief runs are sessions too, but they belong to their item: the Sessions
  // panel and the palette list only chats.
  const chatSessions = useMemo(() => sessions.filter((s) => s.kind !== 'brief'), [sessions])
  const runningCount = chatSessions.filter((s) => s.status === 'running' || s.status === 'starting').length
  const modelName = current ? findModel(models, current.model)?.name ?? current.model : undefined

  const panel =
    railActive === 'terminals' ? (
      <TerminalsPanel
        terminals={terminals}
        currentId={currentTerminalId}
        defaultCwd={terminalCwd}
        onSelect={(id) => navigate(`/terminal/${id}`)}
        onNew={newTerminal}
        onRename={renameTerminal}
        onClose={closeTerminal}
        onSearch={() => setPaletteOpen(true)}
      />
    ) : railActive === 'artifacts' ? (
      <ArtifactsPanel
        artifacts={artifacts.artifacts}
        loaded={artifacts.loaded}
        currentId={route.page === 'artifact' ? route.id : null}
        onOpen={(id) => navigate(`/artifact/${id}`)}
        onPin={(id, title) => pin(`artifact:${id}`, title)}
        onNew={() => navigate('/artifact/new')}
        onRefresh={() => void fetch('/api/artifacts/reindex', { method: 'POST' }).then(() => artifactStore.refresh())}
        onSearch={() => setPaletteOpen(true)}
      />
    ) : railActive === 'inbox' ? (
      <QueuePanel
        items={inbox.items}
        loaded={inbox.loaded}
        selectedId={route.page === 'item' ? route.id : null}
        onOpenItem={openItem}
        onPinItem={(id, title) => pin(`item:${id}`, title)}
        onAdd={() => {
          setComposeSignal((n) => n + 1)
          if (route.page !== 'inbox') navigate('/inbox')
        }}
        onRefresh={() => void inboxStore.refresh(true)}
        onSearch={() => setPaletteOpen(true)}
      />
    ) : (
      <SessionsPanel
        sessions={chatSessions}
        currentId={currentId}
        drafts={drafts}
        currentDraftId={currentDraftId}
        onSelectDraft={(id) => navigate(draftRoute(id))}
        onDiscardDraft={discardDraft}
        onSelect={navigate}
        onNew={newSession}
        onRename={renameSession}
        onSetPinned={setPinned}
        onDelete={deleteSession}
        onSearch={() => setPaletteOpen(true)}
      />
    )

  return (
    <div className="app">
      <TopBar
        workspaces={workspaces}
        workspaceId={workspaceId}
        conn={conn}
        onSwitchWorkspace={(id) => store.switchWorkspace(id)}
        onNewWorkspace={() => setWsModal({ kind: 'create' })}
        onWorkspaceSettings={() => openSettings('workspace')}
        onOpenSystem={(tab) => setSystem({ open: true, tab })}
        onOpenSettings={() => openSettings()}
        onHelp={() => setHelpOpen(true)}
      />

      <div
        className={`shell${panelSize.dragging ? ' resizing' : ''}`}
        style={{ '--panel-w': `${panelSize.width}px` } as CSSProperties}
      >
        <Rail
          active={railActive}
          inboxCount={inbox.items.length}
          runningCount={runningCount}
          terminalCount={terminals.filter((t) => t.status === 'running').length}
          onGo={goTo}
        />

        {panel}
        <div
          className="panelResize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panel (double-click to reset)"
          title="Drag to resize · double-click to reset"
          {...panelSize.handleProps}
        />

        <div id="main">
          <TabBand
            activeKey={activeTabKey}
            tabs={openTabs}
            preview={previewTab}
            onPin={pin}
            pageTab={pageTab}
            onInbox={() => navigate('/inbox')}
            onSelect={(key) => navigate(routeOfKey(key))}
            onClose={closeOpenTab}
            onNew={newSession}
            onNewTerminal={newTerminal}
            terminalCwd={terminalCwd}
          />

          <div className="content">
            {route.page === 'inbox' ? (
              <InboxPage
                onDispatch={dispatch}
                onRefineWatch={refineWatch}
                onOpenItem={openItem}
                onPinItem={(id, title) => pin(`item:${id}`, title)}
                composeSignal={composeSignal}
              />
            ) : route.page === 'item' ? (
              <ItemPage key={route.id} id={route.id} onDispatch={dispatch} onNavigate={navigate} onDirty={pinCurrent} />
            ) : route.page === 'terminal' ? (
              currentTerminal ? (
                <TerminalPage
                  key={currentTerminal.id}
                  terminal={currentTerminal}
                  onRename={(title) => renameTerminal(currentTerminal.id, title)}
                  onClose={() => closeTerminal(currentTerminal.id)}
                  onNewHere={() => newTerminal(currentTerminal.cwd)}
                />
              ) : (
                <div id="empty">Terminal not found — it may have been closed.</div>
              )
            ) : route.page === 'terminals' ? (
              <div className="termHome">
                <div className="glow green" aria-hidden="true" />
                <h2 className="display">Terminals.</h2>
                <p>
                  A real shell, run by the daemon in a project folder. It lands as a tab beside your
                  sessions, and anything you start in it keeps running while you look elsewhere.
                </p>
                <div className="choices">
                  <NewTerminalMenu defaultCwd={terminalCwd} onNew={newTerminal} className="btn primary" />
                </div>
              </div>
            ) : route.page === 'artifacts' ? (
              <ArtifactsPage onOpen={(id) => navigate(`/artifact/${id}`)} onPin={(id, title) => pin(`artifact:${id}`, title)} />
            ) : route.page === 'artifact' ? (
              <ArtifactPage key={route.id} id={route.id} onNavigate={navigate} onDirty={pinCurrent} />
            ) : route.page === 'watches' ? (
              <WatchesPage onNavigate={navigate} onPin={(id, title) => pin(`watch:${id}`, title)} />
            ) : route.page === 'watch' ? (
              <WatchPage key={route.id} id={route.id} onNavigate={navigate} />
            ) : route.page === 'watch-form' ? (
              <WatchFormPage key={route.id ?? 'new'} id={route.id} onNavigate={navigate} />
            ) : route.page === 'draft' ? (
              currentDraft ? (
                <NewSessionComposer
                  key={currentDraft.id}
                  draft={currentDraft}
                  onChange={(patch) => draftStore.update(currentDraft.id, patch)}
                  onCreate={(s) => create(currentDraft.id, s)}
                />
              ) : (
                <div id="empty">This draft was discarded.</div>
              )
            ) : route.page === 'home' || route.page === 'settings' ? null : current ? (
              <>
                <div id="chatHeader">
                  <span id="chatTitle" title={current.title}>
                    {current.title}
                  </span>
                  <span className="pills">
                    {modelName && (
                      <span className="pill" title="Model · effort">
                        {modelName}
                        {current.effort ? ` · ${EFFORT_LABEL[current.effort].toLowerCase()}` : ''}
                      </span>
                    )}
                    <span className="pill mono" title={current.cwd}>
                      <span className="t">{homely(current.cwd)}</span>
                      {current.branch ? ` · ${current.branch}` : ''}
                    </span>
                  </span>
                  <span className={`state ${current.status}`}>
                    <span
                      className={`dot ${
                        current.status === 'running' || current.status === 'starting'
                          ? 'live'
                          : current.status === 'error'
                            ? 'red'
                            : 'green'
                      }`}
                    />
                    {STATUS_LABEL[current.status]}
                  </span>
                </div>
                <Transcript
                  key={current.id}
                  sessionId={current.id}
                  events={events}
                  turns={sessionChanges?.turns}
                  onRespond={respond}
                />
                <ChangesDrawer
                  key={`changes-${current.id}`}
                  sessionId={current.id}
                  changes={sessionChanges}
                  onQuote={(text) => setQuote((q) => ({ text, nonce: q.nonce + 1 }))}
                />
                <Composer
                  key={`composer-${current.id}`}
                  quote={quote}
                  status={current.status}
                  cwd={current.cwd}
                  branch={current.branch}
                  model={current.model}
                  effort={current.effort}
                  fastMode={current.fastMode}
                  fastModeState={current.fastModeState}
                  fastModeDisabledReason={current.fastModeDisabledReason}
                  permissionMode={current.permissionMode}
                  onSend={sendMessage}
                  onInterrupt={interrupt}
                  onModelChange={setModel}
                  onFastModeChange={setFastMode}
                  onPermissionModeChange={setPermissionMode}
                />
              </>
            ) : (
              <div id="empty">Session not found — it may have been deleted.</div>
            )}
          </div>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        sessions={chatSessions}
        terminals={terminals}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onNewSession={newSession}
        onNewTerminal={() => newTerminal(terminalCwd)}
        onOpenItem={(item) => openItem(item.id)}
        onNewSessionIn={newSessionIn}
        onSyncInbox={syncInbox}
        onAddWatch={addWatch}
        onOpenSettings={(tab) => openSettings(tab)}
        onHelp={() => setHelpOpen(true)}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SystemModal
        open={system.open}
        initialTab={system.tab}
        conn={conn}
        onClose={() => setSystem((s) => ({ ...s, open: false }))}
      />
      <WorkspaceModal mode={wsModal} onClose={() => setWsModal(null)} />
      <SettingsModal workspace={activeWorkspace} onOpenSystem={(tab) => setSystem({ open: true, tab })} />
    </div>
  )
}
