/**
 * The settings modal — one Radix dialog over ~85% of the viewport, a tab list
 * down the left, one pane on the right. Every tab is a destination in its own
 * right: `openSettings('auth')` (or `#/settings/auth`) lands on Claude auth
 * with nothing to click through, which is what a "Fix" link needs.
 *
 * Workspace-scoped tabs (Workspace · Claude auth · Sources · Projects) write to the
 * server; browser-scoped ones (Sessions · Shortcuts) write to localStorage.
 */
import * as Dialog from '@radix-ui/react-dialog'
import * as RadioGroup from '@radix-ui/react-radio-group'
import * as Slider from '@radix-ui/react-slider'
import * as Switch from '@radix-ui/react-switch'
import * as Tabs from '@radix-ui/react-tabs'
import {
  Activity,
  Cable,
  Check,
  Folder,
  Gauge,
  Info,
  Keyboard,
  KeyRound,
  MessagesSquare,
  Palette,
  Plug,
  RefreshCw,
  ScrollText,
  Settings2,
  Smartphone,
  Sparkles,
  SwatchBook,
  Users,
  Wallet,
  X,
  type LucideProps,
} from 'lucide-react'
import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import type {
  ConnectorsResponse,
  PlaybookResponse,
  PlaybooksResponse,
  SettingsResponse,
  SystemResponse,
  WorkspaceSettings,
  SystemStatus,
  Workspace,
  WorkspaceAuthBackend,
  WorkspaceResponse,
  WorkspacesResponse,
} from '../../../shared/protocol.js'
import { FAST_MODE_BLURB, modelSupportsFastMode } from '../fastMode.js'
import { SHORTCUTS } from '../keys.js'
import { findModel, useModels } from '../models.js'
import { KIND_LABEL } from '../itemUi.js'
import { Select, SelectItem } from '../ui/Select.js'
import { readSessionDefaults, writeSessionDefaults, type SessionDefaults } from '../sessionDefaults.js'
import {
  APPEARANCE_DEFAULTS,
  chooseTheme,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  resolveTheme,
  useAppearance,
  writeAppearance,
  type ThemeMode,
} from '../appearance.js'
import { findTheme, THEMES, type Theme, type ThemeScheme } from '../themes.js'
import { closeSettings, SETTINGS_TABS, setSettingsTab, useSettings, type SettingsTab } from '../settings.js'
import { store } from '../store.js'
import { ModelPopover } from './ModelPopover.js'
import { PermissionModePicker } from './PermissionModePicker.js'
import { ConnectorsPanel } from './Connectors.js'
import { McpTab } from './McpTab.js'
import { PhoneTab } from './PhoneTab.js'
import { ProjectsTab } from './ProjectsTab.js'
import { TeamsTab } from './TeamsTab.js'
import { RepoScopeEditor } from './RepoScope.js'
import { UsageTab } from './UsageTab.js'
import { ActivityTab, LogsTab, type SystemTab } from './SystemModal.js'
import { AuthCards, authTitle, ColorPicker, VerifyPanel, verifyWorkspace, type VerifyState } from './workspaceAuth.js'

const ICONS: Record<SettingsTab, ComponentType<LucideProps>> = {
  workspace: Settings2,
  auth: KeyRound,
  sources: Plug,
  projects: Folder,
  briefs: Sparkles,
  teams: Users,
  connectors: Plug,
  mcp: Cable,
  activity: Activity,
  usage: Wallet,
  logs: ScrollText,
  appearance: Palette,
  themes: SwatchBook,
  sessions: MessagesSquare,
  shortcuts: Keyboard,
  phone: Smartphone,
  about: Info,
}

type Props = {
  workspace: Workspace | null
  /** Open the system sheet (status · activity · logs) — closes the modal first. */
  onOpenSystem: (tab: SystemTab) => void
}

export function SettingsModal({ workspace, onOpenSystem }: Props) {
  const { open, tab } = useSettings()
  const meta = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0]
  // A read-out tab fills the pane and gets a Refresh button; the nonce it
  // drives resets per tab, so arriving somewhere never counts as a refresh.
  const fill = meta.fill === true
  const [nonce, setNonce] = useState(0)
  useEffect(() => setNonce(0), [tab])
  // On a phone the tab list is a sideways strip: keep the open tab in view.
  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() =>
      document.querySelector('.settingsTab[data-state="active"]')?.scrollIntoView({ inline: 'center', block: 'nearest' }),
    )
  }, [open, tab])

  const openSystem = useCallback(
    (t: SystemTab) => {
      closeSettings()
      onOpenSystem(t)
    },
    [onOpenSystem],
  )

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && closeSettings()}>
      <Dialog.Portal>
        <Dialog.Overlay className="settingsOverlay" />
        <Dialog.Content className="settings" aria-describedby={undefined}>
          <Tabs.Root
            value={tab}
            onValueChange={(v) => setSettingsTab(v as SettingsTab)}
            orientation="vertical"
            className="settingsTabs"
          >
            <nav className="settingsNav">
              <div className="settingsNavHead">
                <Dialog.Title className="title">Settings</Dialog.Title>
                {workspace && (
                  <div className="settingsNavWs" title={`Workspace: ${workspace.name}`}>
                    <span className="wsDot" style={{ background: workspace.color }} aria-hidden="true" />
                    <span className="name">{workspace.name}</span>
                  </div>
                )}
              </div>
              <Tabs.List aria-label="Settings sections" className="settingsList">
                <div className="settingsNavGroup">This workspace</div>
                {SETTINGS_TABS.filter((t) => t.group === 'workspace').map((t) => (
                  <NavTab key={t.id} id={t.id} label={t.label} />
                ))}
                <div className="settingsNavGroup">Diagnostics</div>
                {SETTINGS_TABS.filter((t) => t.group === 'diagnostics').map((t) => (
                  <NavTab key={t.id} id={t.id} label={t.label} />
                ))}
                <div className="settingsNavGroup">This browser</div>
                {SETTINGS_TABS.filter((t) => t.group === 'app').map((t) => (
                  <NavTab key={t.id} id={t.id} label={t.label} />
                ))}
              </Tabs.List>
              <div className="settingsNavFoot">
                <kbd>Esc</kbd> closes
              </div>
            </nav>

            <div className="settingsPane">
              <header className="settingsHead">
                <div>
                  <h2>{meta.label}</h2>
                  <p>{meta.sub}</p>
                </div>
                <span className="settingsHeadRight">
                  {fill && (
                    <button type="button" className="iconBtn" title="Refresh" aria-label="Refresh" onClick={() => setNonce((n) => n + 1)}>
                      <RefreshCw size={13} aria-hidden="true" />
                    </button>
                  )}
                <Dialog.Close asChild>
                  <button type="button" className="iconBtn settingsClose" title="Close (Esc)" aria-label="Close settings">
                    <X size={15} aria-hidden="true" />
                  </button>
                </Dialog.Close>
                </span>
              </header>
              <div className={`settingsBody${fill ? ' fill' : ''}`}>
                <div className="inner">
                  <Tabs.Content value="workspace">
                    {workspace ? <WorkspaceTab key={workspace.id} workspace={workspace} /> : <Loading />}
                  </Tabs.Content>
                  <Tabs.Content value="auth">
                    {workspace ? <AuthTab key={workspace.id} workspace={workspace} /> : <Loading />}
                  </Tabs.Content>
                  <Tabs.Content value="sources">
                    <SourcesTab />
                  </Tabs.Content>
                  <Tabs.Content value="projects">
                    <ProjectsTab />
                  </Tabs.Content>
                  <Tabs.Content value="briefs">
                    <BriefsTab />
                  </Tabs.Content>
                  <Tabs.Content value="teams">
                    <TeamsTab />
                  </Tabs.Content>
                  <Tabs.Content value="connectors" className="settingsFill">
                    <ConnectorsPanel refreshNonce={nonce} />
                  </Tabs.Content>
                  <Tabs.Content value="mcp">
                    <McpTab workspace={workspace} />
                  </Tabs.Content>
                  <Tabs.Content value="activity" className="settingsFill">
                    <ActivityTab key={nonce} />
                  </Tabs.Content>
                  <Tabs.Content value="usage" className="settingsFill">
                    <UsageTab refreshNonce={nonce} />
                  </Tabs.Content>
                  <Tabs.Content value="logs" className="settingsFill">
                    <LogsTab key={nonce} />
                  </Tabs.Content>
                  <Tabs.Content value="appearance">
                    <AppearanceTab />
                  </Tabs.Content>
                  <Tabs.Content value="themes">
                    <ThemesTab />
                  </Tabs.Content>
                  <Tabs.Content value="sessions">
                    <SessionsTab />
                  </Tabs.Content>
                  <Tabs.Content value="shortcuts">
                    <ShortcutsTab />
                  </Tabs.Content>
                  <Tabs.Content value="phone">
                    <PhoneTab />
                  </Tabs.Content>
                  <Tabs.Content value="about">
                    <AboutTab onOpenSystem={openSystem} />
                  </Tabs.Content>
                </div>
              </div>
            </div>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function NavTab({ id, label }: { id: SettingsTab; label: string }) {
  const Icon = ICONS[id]
  return (
    <Tabs.Trigger value={id} className="settingsTab">
      <Icon size={15} aria-hidden="true" />
      {label}
    </Tabs.Trigger>
  )
}

const Loading = () => <div className="pickerLoading">Loading…</div>

// ---------------------------------------------------------------------------
// Building blocks — a section with a heading, and a row: label left, control right.
// ---------------------------------------------------------------------------

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="setSection">
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setRow">
      <div className="lbl">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </div>
      <div className="ctl">{children}</div>
    </div>
  )
}

/** A save button plus a fading "Saved" — one idiom for every form here. */
function SaveRow({
  dirty,
  saving,
  saved,
  error,
  onSave,
  label = 'Save',
  children,
}: {
  dirty: boolean
  saving: boolean
  saved: boolean
  error?: string
  onSave: () => void
  label?: string
  children?: ReactNode
}) {
  return (
    <>
      {error && <div className="msg error">{error}</div>}
      <div className="setActions">
        <button type="button" className="btn primary" disabled={!dirty || saving} onClick={onSave}>
          {saving ? 'Saving…' : label}
        </button>
        {saved && !dirty && <span className="saved">Saved</span>}
        {children}
      </div>
    </>
  )
}

function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2500)
    return () => clearTimeout(t)
  }, [saved])
  return [saved, () => setSaved(true)]
}

// ---------------------------------------------------------------------------
// Workspace — identity, default, delete.
// ---------------------------------------------------------------------------

function WorkspaceTab({ workspace }: { workspace: Workspace }) {
  const [name, setName] = useState(workspace.name)
  const [color, setColor] = useState(workspace.color)
  const [description, setDescription] = useState(workspace.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, flashSaved] = useSavedFlash()

  const dirty =
    name.trim() !== workspace.name || color !== workspace.color || description.trim() !== (workspace.description ?? '')

  async function save() {
    if (!name.trim()) return setError('a workspace needs a name')
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/workspaces?id=${encodeURIComponent(workspace.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), color, description: description.trim() }),
      })
      const body = (await res.json()) as WorkspaceResponse
      if (!body.ok) throw new Error(body.error)
      await store.refreshWorkspaces()
      flashSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function makeDefault() {
    const res = await fetch('/api/workspaces/default', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: workspace.id }),
    })
    const body = (await res.json()) as WorkspacesResponse
    if (body.ok) await store.refreshWorkspaces()
  }

  return (
    <>
      <Section title="Identity" hint="The name and colour are the ambient signal for which world you are in.">
        <div className="setField">
          <label htmlFor="ws-name">Name</label>
          <input
            id="ws-name"
            type="text"
            value={name}
            placeholder="e.g. Work, Personal"
            onChange={(e) => setName(e.target.value)}
          />
          <label>Colour</label>
          <ColorPicker value={color} onChange={setColor} />
          <label htmlFor="ws-desc">Description</label>
          <input
            id="ws-desc"
            type="text"
            value={description}
            placeholder="What lives in this workspace"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <SaveRow dirty={dirty} saving={saving} saved={saved} error={error} onSave={() => void save()} />
      </Section>

      <Section title="Default workspace" hint="The workspace the daemon, the CLI, and a fresh browser open when none is named.">
        <Row
          label={workspace.isDefault ? 'This is the default workspace' : 'Make this the default'}
          hint={
            workspace.isDefault
              ? 'To change it, open another workspace’s settings and make that one the default.'
              : 'Nothing moves — only which workspace opens first.'
          }
        >
          {!workspace.isDefault && (
            <button type="button" className="btn" onClick={() => void makeDefault()}>
              Make default
            </button>
          )}
        </Row>
      </Section>

      <Section title="Details">
        <div className="setKv">
          <span className="k">id</span>
          <span className="v">{workspace.id}</span>
        </div>
        <div className="setKv">
          <span className="k">created</span>
          <span className="v">{new Date(workspace.createdAt).toLocaleString()}</span>
        </div>
        <div className="setKv">
          <span className="k">Claude auth</span>
          <span className="v">{authTitle(workspace.authBackend)}</span>
        </div>
      </Section>

      {!workspace.isDefault && (
        <Section
          title="Remove this workspace"
          hint="Unregisters it from triage. Its folder — database, secrets, logs — stays on disk; nothing is deleted."
        >
          <DeleteWorkspaceButton workspace={workspace} />
        </Section>
      )}
    </>
  )
}

/** Delete = unregister; the workspace's files stay on disk. Confirmed inline. */
function DeleteWorkspaceButton({ workspace }: { workspace: Workspace }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!confirming) {
    return (
      <button type="button" className="btn danger" onClick={() => setConfirming(true)}>
        Remove workspace…
      </button>
    )
  }
  return (
    <div className="setActions">
      <button
        type="button"
        className="btn danger"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void fetch(`/api/workspaces?id=${encodeURIComponent(workspace.id)}`, { method: 'DELETE' })
            .then((r) => r.json() as Promise<WorkspacesResponse>)
            .then((b) => {
              // The socket for this workspace is closed server-side; land on the default.
              if (b.ok) store.switchWorkspace(b.defaultId)
              else setError(b.error)
            })
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false))
        }}
      >
        {busy ? 'Removing…' : `Really remove “${workspace.name}”?`}
      </button>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Keep it
      </button>
      {error && <span className="setErr">{error}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Claude auth — the backend cards, save, and the live proof.
// ---------------------------------------------------------------------------

function AuthTab({ workspace }: { workspace: Workspace }) {
  const [backend, setBackend] = useState<WorkspaceAuthBackend>(workspace.authBackend)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, flashSaved] = useSavedFlash()
  const [verify, setVerify] = useState<VerifyState>(null)

  const dirty = backend !== workspace.authBackend || apiKey.trim() !== ''
  const needsKey = backend === 'api-key' && !apiKey.trim() && !workspace.apiKeyHint

  const runVerify = useCallback(() => {
    setVerify('probing')
    void verifyWorkspace(workspace.id).then(setVerify)
  }, [workspace.id])

  async function save() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/workspaces?id=${encodeURIComponent(workspace.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authBackend: backend, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
      })
      const body = (await res.json()) as WorkspaceResponse
      if (!body.ok) throw new Error(body.error)
      setApiKey('')
      await store.refreshWorkspaces()
      flashSaved()
      runVerify()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Section
        title="How this workspace signs in"
        hint={
          <>
            Currently <b>{authTitle(workspace.authBackend)}</b>
            {workspace.authBackend === 'api-key' && workspace.apiKeyHint ? ` (key ${workspace.apiKeyHint})` : ''}
            {workspace.authBackend === 'api-key' && !workspace.apiKeyHint ? ' — no key stored yet' : ''}.
            Auth is applied when a Claude subprocess starts: saving a change stops this workspace’s live sessions, and the
            next message revives each one with the new credentials.
          </>
        }
      >
        <AuthCards
          value={backend}
          onChange={setBackend}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          apiKeyHint={backend === workspace.authBackend ? workspace.apiKeyHint : null}
        />
        <SaveRow
          dirty={dirty && !needsKey}
          saving={saving}
          saved={saved}
          error={error}
          onSave={() => void save()}
          label="Save & verify"
        >
          {!dirty && (
            <button type="button" className="btn" disabled={verify === 'probing'} onClick={runVerify}>
              {verify === 'probing' ? 'Checking…' : 'Check it works'}
            </button>
          )}
        </SaveRow>
      </Section>

      {verify === null && workspace.authBackend === 'config-dir' && (
        <Section title="One-time login" hint="This workspace has its own claude.ai login. If it has never signed in, run this in a terminal, then check it works.">
          <code className="wsLoginCmd">{workspace.loginCommand}</code>
        </Section>
      )}

      {verify !== null && (
        <Section
          title="Proof"
          hint="A real probe with this workspace’s own credentials — the model list, the connectors, and for keys and separate logins one tiny turn against the API."
        >
          <VerifyPanel workspace={workspace} state={verify} onRecheck={runVerify} />
        </Section>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Sources — GitHub scope, connectors.
// ---------------------------------------------------------------------------

function SourcesTab() {
  const [connectors, setConnectors] = useState<{ total: number; connected: number; slack: boolean } | 'loading' | 'error'>(
    'loading',
  )
  useEffect(() => {
    // The server hands back its cached probe; no subprocess is started for this.
    void fetch('/api/connectors')
      .then((r) => r.json() as Promise<ConnectorsResponse>)
      .then((b) => {
        if (!b.ok) return setConnectors('error')
        const live = b.connectors.filter((c) => c.status === 'connected')
        setConnectors({
          total: b.connectors.length,
          connected: live.length,
          slack: live.some((c) => /slack/i.test(c.name)),
        })
      })
      .catch(() => setConnectors('error'))
  }, [])

  return (
    <>
      <Section
        title="GitHub repos"
        hint="The GitHub source only pulls from the repos checked here, and the scope is per workspace. Nothing checked means no GitHub items in this inbox."
      >
        <RepoScopeEditor onSaved={() => {}} />
      </Section>

      <WatchesSwitchSection />

      <Section
        title="Slack and connectors"
        hint="Slack watches run through the claude.ai Slack connector on this workspace’s Claude login. Connectors are managed at claude.ai and in ~/.claude; this is the read-out."
      >
        <Row
          label="Connectors a session can reach"
          hint={
            connectors === 'loading'
              ? 'Reading the last probe…'
              : connectors === 'error'
                ? 'The probe could not be read.'
                : `${connectors.connected} of ${connectors.total} connected · Slack ${connectors.slack ? 'connected' : 'not connected'}`
          }
        >
          <button type="button" className="btn" onClick={() => setSettingsTab('connectors')}>
            See connectors
          </button>
        </Row>
      </Section>
    </>
  )
}

/** The workspace's server-side knobs (GET/PUT /api/settings), shared by two tabs. */
function useWorkspaceSettings() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<SettingsResponse>)
      .then((b) => (b.ok ? setSettings(b.settings) : setError(b.error)))
      .catch((e) => setError(String(e)))
  }, [])
  const save = useCallback(async (patch: Partial<WorkspaceSettings>) => {
    setError(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const b = (await res.json()) as SettingsResponse
      if (b.ok) setSettings(b.settings)
      else setError(b.error)
    } catch (e) {
      setError(String(e))
    }
  }, [])
  return { settings, error, save }
}

/** The global watches switch — off by default in 0.7 (.docs/next-version.md) — and default run limits. */
function WatchesSwitchSection() {
  const { settings, error, save } = useWorkspaceSettings()
  const [timeoutMin, setTimeoutMin] = useState('')
  const [budget, setBudget] = useState('')
  useEffect(() => {
    if (!settings) return
    setTimeoutMin(String(Math.round(settings.watchTimeoutMs / 60_000)))
    setBudget(settings.watchBudgetUsd != null ? String(settings.watchBudgetUsd) : '')
  }, [settings])
  const saveTimeout = () => {
    const n = Number(timeoutMin)
    if (Number.isFinite(n) && n >= 1 && n <= 60 && settings && Math.round(n * 60_000) !== settings.watchTimeoutMs) void save({ watchTimeoutMs: Math.round(n * 60_000) })
  }
  const saveBudget = () => {
    const b = budget.trim() ? Number(budget) : null
    if (b === null || (Number.isFinite(b) && b > 0 && b <= 100)) void save({ watchBudgetUsd: b })
  }
  return (
    <Section
      title="Watches"
      hint="Scheduled scans that file work items on their own. Off by default: add items by hand or by pasting a link, and switch this on once the briefs you queue by hand have earned it."
    >
      <Row label="Run watches on a schedule" hint={settings?.watchesEnabled ? 'Due watches run every minute tick.' : 'The scheduler skips every watch. “Run now” on a watch still works.'}>
        <Switch.Root
          className="uiSwitch"
          checked={settings?.watchesEnabled ?? false}
          disabled={!settings}
          onCheckedChange={(on) => void save({ watchesEnabled: on })}
          aria-label="Run watches on a schedule"
        >
          <Switch.Thumb className="uiSwitchThumb" />
        </Switch.Root>
      </Row>
      <Row label="Default timeout" hint="Minutes a watch run may take before it is stopped and recorded as timed out. A watch can set its own.">
        <input className="setNum" inputMode="numeric" value={timeoutMin} disabled={!settings} onChange={(e) => setTimeoutMin(e.target.value)} onBlur={saveTimeout} aria-label="Default watch timeout in minutes" />
      </Row>
      <Row label="Default budget per run" hint="Dollars a watch run may spend before it stops. Blank = no cap. A watch can set its own.">
        <input className="setNum" inputMode="decimal" value={budget} placeholder="none" disabled={!settings} onChange={(e) => setBudget(e.target.value)} onBlur={saveBudget} aria-label="Default watch budget in dollars" />
      </Row>
      {error && <div className="msg error">{error}</div>}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Briefs — the daily cap, the default model, and the two prose files per kind.
// ---------------------------------------------------------------------------

function BriefsTab() {
  const { settings, error, save } = useWorkspaceSettings()
  const models = useModels()
  const [cap, setCap] = useState<string>('')
  useEffect(() => {
    if (settings) setCap(String(settings.briefsDailyCap))
  }, [settings])

  return (
    <>
      <Section
        title="Running briefs"
        hint="A brief is a playbook run against one work item that writes a markdown document beside it. Runs queue in order, one at a time, and stop at the cap — nothing runs until you queue it."
      >
        <Row label="Daily cap" hint="How many brief runs may start per day in this workspace. The tail of a batch fails with a clear reason rather than running past it.">
          <input
            className="setNum"
            type="number"
            min={1}
            max={500}
            value={cap}
            disabled={!settings}
            onChange={(e) => setCap(e.target.value)}
            onBlur={() => {
              const n = Number(cap)
              if (settings && Number.isInteger(n) && n >= 1 && n <= 500 && n !== settings.briefsDailyCap) void save({ briefsDailyCap: n })
              else if (settings) setCap(String(settings.briefsDailyCap))
            }}
          />
        </Row>
        <Row label="Default model" hint="What a brief runs on when the Create-brief dialog doesn’t pick one. Cheaper models are usually enough for reading.">
          <Select
            className="setSelect"
            aria-label="Default model"
            value={settings?.briefsDefaultModel ?? ''}
            disabled={!settings}
            onValueChange={(v) => void save({ briefsDefaultModel: v || null })}
          >
            <SelectItem value="">Claude Code default</SelectItem>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </Select>
        </Row>
        {settings?.briefsDefaultModel && !findModel(models, settings.briefsDefaultModel) && (
          <p className="hint">Default model “{settings.briefsDefaultModel}” is not in the probed list; it is passed through as-is.</p>
        )}
        {error && <div className="msg error">{error}</div>}
      </Section>
      <ProseFileSection
        title="Playbooks"
        hint="One markdown file per kind of work item — what to read, what to look for, the headings the brief should have. Edited here or in the file; a brief run pastes it into its first message."
        listUrl="/api/playbooks"
        fileUrl={(kind) => `/api/playbooks?kind=${encodeURIComponent(kind)}`}
      />
      <ProseFileSection
        title="Dispatch templates"
        hint="How a dispatched session opens, per kind. A tiny template: {{title}}, {{url}}, {{description}}, {{reason}}, {{note}}, and {{#brief}}…{{/brief}} when a brief exists."
        listUrl="/api/playbooks"
        fileUrl={(kind) => `/api/dispatch/template?kind=${encodeURIComponent(kind)}`}
      />
    </>
  )
}

/** A per-kind markdown file with a kind picker, a textarea and Save — playbooks and dispatch templates share it. */
function ProseFileSection({
  title,
  hint,
  listUrl,
  fileUrl,
}: {
  title: string
  hint: string
  listUrl: string
  fileUrl: (kind: string) => string
}) {
  const [kinds, setKinds] = useState<{ kind: string; custom: boolean }[]>([])
  const [kind, setKind] = useState('manual')
  const [body, setBody] = useState('')
  const [loaded, setLoaded] = useState('')
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetch(listUrl)
      .then((r) => r.json() as Promise<PlaybooksResponse>)
      .then((b) => {
        if (b.ok) setKinds(b.playbooks.map((p) => ({ kind: p.kind, custom: p.custom })))
      })
      .catch(() => {})
  }, [listUrl])

  useEffect(() => {
    setError(null)
    void fetch(fileUrl(kind))
      .then((r) => r.json() as Promise<PlaybookResponse>)
      .then((b) => {
        if (b.ok) {
          setBody(b.body)
          setLoaded(b.body)
          setPath(b.path ?? '')
        } else setError(b.error)
      })
      .catch((e) => setError(String(e)))
  }, [kind, fileUrl])

  async function saveFile() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(fileUrl(kind), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const b = (await res.json()) as PlaybookResponse
      if (b.ok) {
        setLoaded(b.body)
        setKinds((prev) => prev.map((k) => (k.kind === kind ? { ...k, custom: b.custom ?? k.custom } : k)))
      } else setError(b.error)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const dirty = body !== loaded
  return (
    <Section title={title} hint={hint}>
      <div className="setPlaybook">
        <div className="head">
          <Select className="setSelect" value={kind} onValueChange={setKind} aria-label="Kind">
            {(kinds.length ? kinds : [{ kind: 'manual', custom: false }]).map((k) => (
              <SelectItem key={k.kind} value={k.kind}>
                {KIND_LABEL[k.kind as keyof typeof KIND_LABEL] ?? k.kind}
                {k.custom ? ' · edited' : ''}
              </SelectItem>
            ))}
          </Select>
          <span className="spacer" />
          <button type="button" className="btn sm" disabled={!dirty || saving} onClick={() => void saveFile()}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} aria-label={`${title} for ${kind}`} />
        {path && <div className="path" title={path}>{path}</div>}
        {error && <div className="msg error">{error}</div>}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Appearance — theme and text size (per browser).
// ---------------------------------------------------------------------------

/** A pill of mutually-exclusive options — the same idiom as the inbox filter. */
function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const THEME_OPTS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function AppearanceTab() {
  const a = useAppearance()
  return (
    <>
      <Section title="Theme">
        <Row label="Colour theme" hint={`${resolveTheme(a).name}${a.mode === 'system' ? ' — following your operating system' : ''}.`}>
          <button type="button" className="btn" onClick={() => setSettingsTab('themes')}>
            Browse themes
          </button>
        </Row>
      </Section>
      <Section
        title="Scale"
        hint="Text size nudges just the reading text. To scale the whole interface, use your browser's zoom (⌘+ / ⌘−)."
      >
        <Row label="Text size" hint={`Body text is ${a.fontSize}px${a.fontSize === FONT_DEFAULT ? ' (default)' : ''}.`}>
          <div className="fontSlider">
            <span className="a sm" aria-hidden="true">A</span>
            <Slider.Root
              className="uiSlider"
              min={FONT_MIN}
              max={FONT_MAX}
              step={1}
              value={[a.fontSize]}
              onValueChange={([fontSize]) => writeAppearance({ fontSize })}
            >
              <Slider.Track className="uiSliderTrack">
                <Slider.Range className="uiSliderRange" />
              </Slider.Track>
              <Slider.Thumb className="uiSliderThumb" aria-label="Text size" />
            </Slider.Root>
            <span className="a lg" aria-hidden="true">A</span>
            <span className="val">{a.fontSize}px</span>
          </div>
        </Row>
      </Section>
      <Section title="Reset">
        <Row label="Back to defaults" hint="Triage Dark, default text size.">
          <button type="button" className="btn" onClick={() => writeAppearance(APPEARANCE_DEFAULTS)}>
            Reset
          </button>
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Themes — a gallery per scheme. The mode decides which pick is on screen.
// ---------------------------------------------------------------------------

function ThemesTab() {
  const a = useAppearance()
  const showing = resolveTheme(a)
  return (
    <>
      <Section title="Mode" hint="System follows your operating system’s light or dark setting and switches with it.">
        <Row label="Colour mode">
          <Segmented ariaLabel="Colour mode" value={a.mode} options={THEME_OPTS} onChange={(mode) => writeAppearance({ mode })} />
        </Row>
      </Section>
      <ThemeGallery scheme="dark" value={a.darkTheme} showing={showing} system={a.mode === 'system'} />
      <ThemeGallery scheme="light" value={a.lightTheme} showing={showing} system={a.mode === 'system'} />
    </>
  )
}

function ThemeGallery({
  scheme,
  value,
  showing,
  system,
}: {
  scheme: ThemeScheme
  value: string
  showing: Theme
  system: boolean
}) {
  const title = scheme === 'dark' ? 'Dark themes' : 'Light themes'
  const hint = system
    ? `Your ${scheme} pick shows whenever your operating system is in ${scheme} mode.`
    : showing.scheme === scheme
      ? 'Showing now. Pick one to switch.'
      : `Picking one switches to ${scheme} mode.`
  return (
    <Section title={title} hint={hint}>
      <RadioGroup.Root
        className="themeGrid"
        aria-label={title}
        value={value}
        onValueChange={(id) => {
          const theme = findTheme(id)
          if (theme) chooseTheme(theme)
        }}
      >
        {THEMES.filter((t) => t.scheme === scheme).map((t) => (
          <RadioGroup.Item key={t.id} value={t.id} className="themeCard" data-showing={t.id === showing.id || undefined}>
            <ThemePreview theme={t} />
            <span className="themeName">
              {t.name}
              {t.id === value && <Check size={13} aria-hidden="true" />}
            </span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </Section>
  )
}

/**
 * A thumbnail of the workbench in a theme's own colours — painted from its
 * palette, not the live tokens, so every card shows itself whatever is active.
 */
function ThemePreview({ theme }: { theme: Theme }) {
  const p = theme.palette
  const line = (w: string, color: string) => <i style={{ width: w, background: color }} />
  return (
    <span className="themePreview" style={{ background: p.canvas }} aria-hidden="true">
      <span className="rail" style={{ background: p.card, borderColor: `${p.ink}14` }}>
        {line('70%', p.ink)}
        {line('50%', p.ash)}
        {line('60%', p.ash)}
      </span>
      <span className="main">
        {line('56%', p.ink)}
        {line('84%', p.mute)}
        {line('68%', p.mute)}
        <span className="code" style={{ background: p.deep }}>
          {line('40%', p.purple)}
          {line('62%', p.green)}
        </span>
        <span className="foot">
          <span className="dots">
            {[p.red, p.yellow, p.green, p.blue].map((c, i) => (
              <b key={i} style={{ background: c }} />
            ))}
          </span>
          <span className="btnPill" style={{ background: p.ink }} />
        </span>
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Sessions — defaults for new sessions (per browser).
// ---------------------------------------------------------------------------

function SessionsTab() {
  const [d, setD] = useState<SessionDefaults>(() => readSessionDefaults())
  const models = useModels()
  const fastOk = modelSupportsFastMode(models, d.model)

  const update = (patch: Partial<SessionDefaults>) => {
    writeSessionDefaults(patch)
    setD((prev) => ({ ...prev, ...patch }))
  }

  return (
    <>
      <Section
        title="New session defaults"
        hint="What a fresh draft starts with. A session’s own prompt box can still change any of these for that session, and the last pick there becomes the new default."
      >
        <Row label="Model and effort" hint="Leave unset to follow Claude Code’s own default.">
          <ModelPopover model={d.model} effort={d.effort} onModelChange={(model, effort) => update({ model, effort })} />
        </Row>
        <Row
          label="Fast mode"
          hint={fastOk ? FAST_MODE_BLURB : 'The chosen model does not support fast mode.'}
        >
          <Switch.Root
            className="uiSwitch"
            checked={d.fastMode && fastOk}
            disabled={!fastOk}
            onCheckedChange={(on) => update({ fastMode: on })}
            aria-label="Fast mode for new sessions"
          >
            <Switch.Thumb className="uiSwitchThumb" />
          </Switch.Root>
        </Row>
        <Row label="Permissions" hint="How much a new session asks before acting. Shift+Tab cycles it in the prompt box.">
          <PermissionModePicker mode={d.permissionMode} onChange={(permissionMode) => update({ permissionMode })} />
        </Row>
      </Section>
      <Section title="Reset">
        <Row label="Forget these defaults" hint="New sessions go back to Claude Code’s defaults and ask every time.">
          <button
            type="button"
            className="btn"
            onClick={() => update({ model: undefined, effort: undefined, fastMode: false, permissionMode: undefined })}
          >
            Reset
          </button>
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Shortcuts — read-only for now.
// ---------------------------------------------------------------------------

function ShortcutsTab() {
  return (
    <Section title="Keys" hint="Single keys work outside text fields and while no dialog is open. ⌘K works everywhere.">
      <table className="setKeys">
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// About — the daemon.
// ---------------------------------------------------------------------------

function AboutTab({ onOpenSystem }: { onOpenSystem: (t: SystemTab) => void }) {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void fetch('/api/system')
      .then((r) => r.json() as Promise<SystemResponse>)
      .then((b) => (b.ok ? setStatus(b.status) : setError(b.error)))
      .catch((e) => setError(String(e)))
  }, [])

  return (
    <>
      <Section title="triage" hint="A local web UI over the Claude Agent SDK. Everything runs on this machine; the daemon answers only this Mac (and phones you pair under Phone) and holds no Slack or GitHub credentials.">
        {error && <div className="msg error">{error}</div>}
        {status && (
          <>
            <div className="setKv">
              <span className="k">version</span>
              <span className="v">{status.version}</span>
            </div>
            <div className="setKv">
              <span className="k">port</span>
              <span className="v">{status.port}</span>
            </div>
            <div className="setKv">
              <span className="k">workspace</span>
              <span className="v">{status.workspace}</span>
            </div>
            <div className="setKv">
              <span className="k">database</span>
              <span className="v" title={status.db}>{status.db}</span>
            </div>
            <div className="setKv">
              <span className="k">logs</span>
              <span className="v" title={status.logDir ?? undefined}>{status.logDir ?? 'in-memory only'}</span>
            </div>
            <div className="setKv">
              <span className="k">live sessions</span>
              <span className="v">{status.liveSessions}</span>
            </div>
          </>
        )}
        {!status && !error && <Loading />}
      </Section>
      <Section title="Under the hood" hint="The daemon’s status sheet, and the diagnostics tabs here.">
        <div className="setActions">
          <button type="button" className="btn" onClick={() => onOpenSystem('status')}>
            <Gauge size={13} aria-hidden="true" /> Status
          </button>
          <button type="button" className="btn" onClick={() => setSettingsTab('activity')}>
            <Activity size={13} aria-hidden="true" /> Activity
          </button>
          <button type="button" className="btn" onClick={() => setSettingsTab('logs')}>
            <ScrollText size={13} aria-hidden="true" /> Logs
          </button>
          <button type="button" className="btn ghost" onClick={() => setSettingsTab('connectors')}>
            <Plug size={13} aria-hidden="true" /> Connectors
          </button>
        </div>
      </Section>
    </>
  )
}
