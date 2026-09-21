#!/usr/bin/env node
/**
 * triage-dev POC server
 *
 * Serves the web UI on :5178 and drives the locally installed Claude Code
 * via @anthropic-ai/claude-agent-sdk.
 *
 * Sessions are persisted to SQLite (core/store): the row + an append-only
 * event log (the same events the UI renders; stream deltas excluded). The
 * Claude subprocess itself is ephemeral — a session with no live subprocess
 * is revived on the next user message via the SDK's `resume`, keyed by the
 * sdk_session_id captured from the init message. The agent's own memory of
 * the conversation lives in ~/.claude's transcript, not here; our event log
 * is for rendering, never for re-feeding the model.
 *
 * Workspaces (.docs/workspaces.md): one daemon, N isolated workspaces. Each
 * workspace has its own SQLite file, its own Claude auth backend (spawn env),
 * and its own runtime state — every map and cache that used to be a module
 * singleton lives on a WorkspaceRuntime. Every HTTP request and WS connection
 * is bound to exactly one workspace (?workspace= param, else the triage_ws
 * cookie, else the default), and broadcasts stay inside that boundary.
 *
 * The wire format lives in shared/protocol.ts and is shared with the frontend.
 */
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  query,
  createSdkMcpServer,
  tool,
  type Query,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { filePatch, repoRoot, snapshotTree, treeDiff, type TreeChange } from './git.js'
import type {
  ClientMessage,
  Connector,
  ConnectorsResponse,
  EffortLevel,
  FastModeDisabledReason,
  FastModeState,
  ModelOption,
  ModelsResponse,
  SlashCommandInfo,
  CommandsResponse,
  PermissionBehavior,
  PermissionMode,
  QuestionAnswers,
  SdkMessage,
  ServerMessage,
  SessionEvent,
  SessionStatus,
  SessionSummary,
  ImageAttachment,
  ToolEffect,
  Workspace,
  Artifact,
  ArtifactAuthor,
  ArtifactContentResponse,
  ArtifactInput,
  ArtifactResponse,
  ArtifactWithLinks,
  ArtifactsResponse,
  Link,
  LinkKind,
  LinkRole,
  LinksResponse,
  BriefJob,
  BriefJobsResponse,
  BriefResponse,
  BriefView,
  DispatchPreview,
  DispatchPreviewResponse,
  ItemImage,
  ItemImageEdit,
  ItemImagesResponse,
  PlaybookResponse,
  PlaybooksResponse,
  SessionKind,
  SettingsResponse,
  WorkspaceSettings,
  ChangedFile,
  SessionChanges,
  SessionChangesResponse,
  SessionDiffResponse,
  SessionTurnSummary,
} from '../shared/protocol.js'
import {
  MAX_IMAGES_PER_ITEM,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_INLINE_FILE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  MAX_MENTIONS_PER_MESSAGE,
  USAGE_WINDOWS,
  isArtifactAuthor,
  isImageMediaType,
  isLinkKind,
  isLinkRole,
  isMentionKind,
  isToolUseBlock,
  mentionToken,
} from '../shared/protocol.js'
import type {
  ActivityResponse,
  FileSearchResponse,
  Mention,
  ResolvedMention,
  InboxResponse,
  InboxSnapshot,
  ItemDetail,
  ItemDetailResponse,
  ItemEventsResponse,
  ItemListResponse,
  ItemStateResponse,
  LogLevel,
  LogsResponse,
  UsageResponse,
  SessionsUsageResponse,
  SessionSpend,
  UsageModelSlice,
  ManualItemInput,
  SystemResponse,
  SystemStatus,
  ManualItemResponse,
  PickFolderResponse,
  Project,
  ProjectsResponse,
  ReposResponse,
  SessionContext,
  SessionContextResponse,
  UpsertResponse,
  WatchDraftResponse,
  WatchPreviewStartResponse,
  WatchPreviewStatusResponse,
  WatchesResponse,
  WorkItem,
  WorkspaceResponse,
  WorkspacesResponse,
  WorkspaceVerifyResponse,
} from '../shared/protocol.js'
import type { StoredTurn } from '../core/store/types.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store, StoredSession, UpsertOutcome } from '../core/store/types.js'
import { buildInbox } from '../core/work/inbox.js'
import { BASE, rank } from '../core/work/score.js'
import { canonicalizeRef, canonicalizeRefs, linkByRefs } from '../core/work/link.js'
import type { ItemStatus } from '../core/work/state.js'
import type { Provenance, WorkItem as CoreWorkItem, WorkSource } from '../core/work/types.js'
import { fetchGitHub, fetchGitHubClosed, listAffiliatedRepos } from '../core/sources/github.js'
import {
  draftWatch,
  permalinkId,
  safeWhen,
} from '../core/sources/slack.js'
import { scanUsage } from '../core/usage/ledger.js'
import { summarize as summarizeUsage, summarizeBySession, summarizeModels } from '../core/usage/summary.js'
import { isDue } from '../core/watch/schedule.js'
import { cronFromCadence, isValidCron } from '../core/watch/cron.js'
import { WATCH_CONNECTORS, WATCH_OUTPUTS, type NewWatch, type Watch, type WatchCadence, type WatchConnector, type WatchOutput, type WatchPreviewResult, type WatchPreviewRow, type WatchRunStatus } from '../core/watch/types.js'
import { composeRunPrompt, MAX_ROWS_PER_RUN, runAllowedTools } from '../core/watch/connectors.js'
import { clearState, pkgVersion, TRIAGE_DIR, writeState } from './state.js'
import { initLogFile, log, logFilePath, logSubsystems, recentLogs } from './log.js'
import {
  apiKeyHint,
  dbFileFor,
  ensureWorkspaceDirs,
  loadRegistry,
  loginCommandFor,
  saveRegistry,
  slugify,
  spawnEnvFor,
  toAuthBackend,
  workspaceClaudeDir,
  workspaceDir,
  writeApiKey,
  type WorkspaceMeta,
} from './workspaces.js'
import { TerminalManager } from './terminals.js'
import { applyImageEdits, itemImageAttachments, readItemImage } from './itemImages.js'
import { FileIndexes, resolveFileMention } from './files.js'
import { ArtifactIndex, slug } from './artifacts.js'
import { TRIAGE_MCP_INSTRUCTIONS, triageSessionAppend } from '../shared/triageContext.js'
import { callTool as callMcpTool, PROTOCOL_VERSION as MCP_PROTOCOL_VERSION, TOOLS as MCP_TOOLS } from '../core/mcp/tools.js'
import {
  BRIEF_SYSTEM_APPEND,
  briefRelPath,
  composeBriefPrompt,
  isPlaybookName,
  listPlaybooks,
  readDispatchTemplate,
  readPlaybook,
  renderTemplate,
  seedDispatchTemplates,
  seedPlaybooks,
  writeDispatchTemplate,
  writePlaybook,
} from './briefs.js'

const PORT = Number(process.env.PORT || 5178)
const VERSION = pkgVersion()
const SERVER_STARTED = Date.now()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/**
 * Vite build output — see vite.config.ts. Absent until `npm run build`.
 * Two layouts: from source this file is <repo>/server/index.ts and the build
 * is <repo>/dist/web; in the published package it is <pkg>/dist/server/index.js
 * sitting next to <pkg>/dist/web.
 */
const WEB_DIR =
  path.basename(path.dirname(__dirname)) === 'dist'
    ? path.join(__dirname, '..', 'web')
    : path.join(__dirname, '..', 'dist', 'web')

const pExecFile = promisify(execFile)

// ---------------------------------------------------------------------------
// Async queue: lets us push user messages into the SDK's streaming input.
// ---------------------------------------------------------------------------
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T) {
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((res) => this.waiters.push(res))
      },
    }
  }
}

/**
 * A permission rule the SDK suggested, pinned to this session. Every variant
 * of PermissionUpdate carries a `destination`, so this is a blanket rewrite —
 * nothing an "Always allow" click produces may reach a settings file.
 */
const sessionScoped = (u: PermissionUpdate): PermissionUpdate => ({ ...u, destination: 'session' })

// ---------------------------------------------------------------------------
// Effect classifier — the heart of 'gated' mode.
//
// Before a tool runs, we place it on a blast-radius scale (read / local-write /
// external-write) so 'gated' can wave through reads and still stop on anything
// that writes. Two rules keep it safe:
//   1. Unknown ⇒ write. Only a call we can *prove* is a read runs unattended;
//      everything else prompts, so a newly connected tool is gated by default.
//   2. Any write verb wins over any read verb. A connector call is a read only
//      when its name signals a read and signals no write — so a mutating tool
//      can never sneak through on a "get"/"list" substring.
// Classification is by tool *name*, per tool, never per MCP server: Slack read
// and Slack send share one connector but must land on opposite sides.
// ---------------------------------------------------------------------------

/** Built-in tools whose only effect is reading. */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch'])
/** Our own MCP tools that only read (the inbox, the artifacts index) — never prompt for these. */
const TRIAGE_READ_TOOLS = new Set([
  'mcp__triage__list_work_items',
  'mcp__triage__get_work_item',
  'mcp__triage__get_session_context',
  'mcp__triage__get_workspace',
  'mcp__triage__list_artifacts',
  'mcp__triage__read_artifact',
])

// Verb tokens that mark a connector call's intent. Written as word sets and
// matched against the tokens of a tool's leaf name, so both `slack_read_channel`
// (snake) and `getJiraIssue` (camel) classify the same way.
const READ_VERBS = new Set([
  'read', 'search', 'list', 'get', 'fetch', 'lookup', 'view', 'query', 'describe', 'find', 'count', 'show', 'history', 'info',
])
const WRITE_VERBS = new Set([
  'send', 'post', 'create', 'update', 'edit', 'delete', 'remove', 'add', 'schedule', 'transition', 'resolve',
  'comment', 'upsert', 'write', 'set', 'assign', 'merge', 'close', 'reopen', 'archive', 'move', 'upload',
  'publish', 'reply', 'draft', 'star', 'pin', 'react', 'approve', 'complete', 'cancel',
])

/** Lowercased word tokens of a tool's leaf name (splits camelCase and snake_case). */
const wordsOf = (leaf: string): string[] => (leaf.match(/[A-Za-z][a-z]*/g) ?? []).map((w) => w.toLowerCase())

function classifyEffect(toolName: string): ToolEffect {
  // Our own inbox: reading it is harmless; every other triage tool writes local
  // SQLite (create/edit/upsert/resolve).
  if (TRIAGE_READ_TOOLS.has(toolName)) return 'read'
  if (toolName.startsWith('mcp__triage__')) return 'local-write'

  if (READ_TOOLS.has(toolName)) return 'read'
  // TodoWrite is the session's own scratch list — no effect past this session.
  if (toolName === 'TodoWrite') return 'read'

  // Connector (MCP) tools reach outside this machine unless they are plainly a
  // read. `mcp__<server>__<leaf>` — classify by the leaf's verbs (rule 2).
  if (toolName.startsWith('mcp__')) {
    const words = wordsOf(toolName.slice(toolName.lastIndexOf('__') + 2))
    const isRead = words.some((w) => READ_VERBS.has(w)) && !words.some((w) => WRITE_VERBS.has(w))
    return isRead ? 'read' : 'external-write'
  }

  // Everything else built in — Write/Edit/MultiEdit/NotebookEdit and Bash —
  // touches this machine. Bash can be read-only, but its command cannot be
  // classified safely from here, so it is a write and asks.
  return 'local-write'
}

// The permission modes the SDK understands and can be handed straight through.
// 'gated' and 'default' are absent: 'default' is the SDK's own baseline (pinning
// it would say nothing), and 'gated' is enforced by us with the SDK left at that
// baseline so every call reaches canUseTool, where classifyEffect decides.
type SdkPermissionMode = Exclude<PermissionMode, 'default' | 'gated'>
const SDK_MODES: SdkPermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions']
const sdkMode = (m: PermissionMode | null | undefined): SdkPermissionMode | undefined =>
  m && (SDK_MODES as PermissionMode[]).includes(m) ? (m as SdkPermissionMode) : undefined

// ---------------------------------------------------------------------------
// Workspace runtimes — everything that used to be a module singleton, one per
// workspace. Physical isolation: each runtime owns its own store (its own
// SQLite file), its own live sessions and WS clients, and its own caches, so
// nothing can bleed across the boundary by construction.
// ---------------------------------------------------------------------------
type ConnectorProbe = { probedAt: number; connectors: Connector[] }
type ModelProbe = { probedAt: number; models: ModelOption[] }
type CommandProbe = { probedAt: number; commands: SlashCommandInfo[] }

const registry = loadRegistry()

class WorkspaceRuntime {
  readonly store: Store
  /** full spawn env for this workspace's auth backend; undefined = inherit */
  env: Record<string, string> | undefined

  // session registry: every session lives in the store; a subset is live
  readonly rows = new Map<string, StoredSession>()
  readonly live = new Map<string, LiveSession>()
  readonly branches = new Map<string, string>() // session id → git branch (derived)
  /** WS clients bound to THIS workspace — broadcasts never cross the boundary */
  readonly clients = new Set<WebSocket>()

  // inbox
  inboxCache: InboxSnapshot | null = null
  inboxInFlight: Promise<InboxSnapshot> | null = null
  /** last GitHub source error, surfaced as an inbox notice until the next clean sync */
  githubNotice: string | null = null
  githubReconcileAt = 0
  githubReconcileInFlight: Promise<void> | null = null

  // watch runs
  readonly runQueue: string[] = []
  readonly runningWatches = new Set<string>()
  /** in-flight and recently finished dry runs, by ephemeral session id (never persisted) */
  readonly previews = new Map<string, WatchPreview>()
  activeRuns = 0

  // probes
  connectorCache: ConnectorProbe | null = null
  connectorInFlight: Promise<ConnectorProbe> | null = null
  modelCache: ModelProbe | null = null
  modelInFlight: Promise<ModelProbe> | null = null
  /** `/` command lists, keyed by folder — a project's own commands live under it */
  readonly commandCache = new Map<string, CommandProbe>()
  readonly commandInFlight = new Map<string, Promise<CommandProbe>>()
  /** commands this CLI binds to a real terminal; learned from a session's init */
  terminalCommands: string[] | null = null
  affiliatedCache: { at: number; repos: string[] } | null = null

  /**
   * The in-process triage MCP server a chat session gets. One instance per
   * session, never shared: the SDK connects each instance to exactly one
   * transport, so a second concurrent session handed the same object loses
   * its connect and lands `status: "failed"` in system/init — a chat with no
   * mcp__triage__* tools whenever another session in the workspace is live.
   */
  readonly triageMcp: () => ReturnType<typeof createSdkMcpServer>
  /** PTY shells opened from the web UI — run with this workspace's spawn env */
  readonly terminals: TerminalManager
  /** per-folder file listings behind the composer's `@` picker */
  readonly files = new FileIndexes()
  /** the workspace's markdown artifacts, indexed from its artifacts folder (.docs/next-version.md) */
  readonly artifacts: ArtifactIndex
  /** playbooks and dispatch templates — the two prose-customisable stages, as files */
  readonly playbookDir: string
  readonly dispatchDir: string
  /** screenshots attached to work items — bytes on disk, refs on the item */
  readonly attachmentsDir: string

  // brief runs (.docs/next-version.md, phase 2): one at a time per workspace
  briefActive: string | null = null
  briefPumping = false
  readonly briefTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly briefExtras = new Map<string, SessionExtras>()
  /** jobs whose run has called write_brief at least once */
  readonly briefWrote = new Set<string>()
  /** session id → the work item it was dispatched for or briefs (mirrors `links`) */
  readonly sessionItem = new Map<string, string>()

  // Session changes (.docs/session-diff-variations.md): sessions in one folder
  // share a working tree, so "what did *this* session change" is reconstructed
  // from the git trees either side of each of its turns.
  /** session id → its repo root, or null when its folder is not a repo (cached) */
  readonly repoRoots = new Map<string, string | null>()
  /** session id → the turn currently running, for the pre-tree and tool paths */
  readonly openTurns = new Map<string, OpenTurn>()
  /** `<sessionId>:<seq>` → that turn's file delta. Finished turns are immutable. */
  readonly turnDeltas = new Map<string, TreeChange[]>()

  constructor(public meta: WorkspaceMeta) {
    this.store = openSqliteStore(dbFileFor(meta.id, registry.defaultId))
    this.env = spawnEnvFor(meta)
    this.artifacts = new ArtifactIndex(path.join(workspaceDir(meta.id), 'artifacts'), this.store, () =>
      broadcast(this, { type: 'artifacts_changed' }),
    )
    void this.artifacts.ensure()
    this.playbookDir = path.join(workspaceDir(meta.id), 'playbooks')
    this.dispatchDir = path.join(workspaceDir(meta.id), 'dispatch')
    this.attachmentsDir = path.join(workspaceDir(meta.id), 'attachments')
    this.triageMcp = () => makeTriageMcp(this)
    this.terminals = new TerminalManager(
      (msg) => broadcast(this, msg),
      (level, msg) => log(level, 'terminal', msg, { workspace: meta.id }),
    )
  }

  /** Re-resolve the spawn env after an auth-backend or key change. */
  refreshEnv() {
    this.env = spawnEnvFor(this.meta)
  }
}

const runtimes = new Map<string, WorkspaceRuntime>()

const defaultRuntime = (): WorkspaceRuntime => runtimes.get(registry.defaultId)!

// Daemon-wide logs (one process, one log stream); workspace ids ride in fields.
initLogFile(path.join(TRIAGE_DIR, 'logs'))

/**
 * Spawn-time extras for special-purpose sessions (briefs): text appended to
 * Claude Code's own system prompt (it survives `resume`), and MCP servers
 * beyond the workspace's triage server.
 */
type SessionExtras = { systemAppend?: string; mcp?: Record<string, ReturnType<typeof createSdkMcpServer>> }

/** Tools a headless brief session never gets, whatever it asks (belt to the gate's braces). */
const BRIEF_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'AskUserQuestion']
/** The only shell a brief may run: `gh`/`git` read verbs, no chaining or redirection. */
const BRIEF_BASH_RE = /^\s*(gh\s+(pr|issue|api|search|run|repo)\s+(view|diff|checks|list|status|comments)\b|git\s+(log|show|diff|blame|status|branch|ls-files)\b)/
const SHELL_META_RE = /[;&|<>`$\\]|\$\(/
function briefBashAllowed(input: Record<string, unknown>): boolean {
  const cmd = typeof input.command === 'string' ? input.command : ''
  return BRIEF_BASH_RE.test(cmd) && !SHELL_META_RE.test(cmd)
}

// ---------------------------------------------------------------------------
// Live session: one running Claude subprocess bound to a stored session row.
// ---------------------------------------------------------------------------
class LiveSession {
  status: SessionStatus = 'starting'
  model?: string
  /** What fast mode is actually doing here, straight from the subprocess. */
  fastModeState?: FastModeState
  fastModeDisabledReason?: FastModeDisabledReason
  private seq: number
  private readonly input = new AsyncQueue<SDKUserMessage>()
  private readonly pendingPermissions = new Map<
    string,
    {
      input: Record<string, unknown>
      /** The SDK's own "don't ask again" rules, replayed on `allow_always`. */
      suggestions: PermissionUpdate[]
      resolve: (r: PermissionResult) => void
    }
  >()
  private readonly q: Query
  /** Whether this subprocess was spawned able to bypass permission checks. */
  private readonly bypassArmed: boolean

  constructor(
    readonly rt: WorkspaceRuntime,
    readonly row: StoredSession,
    lastSeq: number,
    resumeSdkSessionId: string | null,
    readonly extras: SessionExtras = {},
  ) {
    this.seq = lastSeq
    this.bypassArmed = row.permissionMode === 'bypassPermissions'
    this.q = query({
      prompt: this.input,
      options: {
        cwd: row.cwd,
        // Full Claude Code behavior: its system prompt + tools, and the
        // user's own settings/plugins/MCP connectors from ~/.claude.
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          // Brief sessions: the headless contract rides in the system prompt so
          // it survives `resume` (.docs/next-version.md).
          ...(extras.systemAppend ? { append: extras.systemAppend } : {}),
        },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        // The triage inbox as in-process tools, so a chat can list/create/edit
        // work items directly — same tool surface as the stdio shim external
        // Claude Code sessions get (server/mcp.ts). Scoped to this workspace.
        // Brief sessions add their own `write_brief` server on top.
        mcpServers: { triage: rt.triageMcp(), ...(extras.mcp ?? {}) },
        ...(row.kind === 'brief' ? { disallowedTools: BRIEF_DISALLOWED_TOOLS } : {}),
        // Workspace auth backend: api-key / config-dir spawn with overrides;
        // inherit passes nothing, exactly the pre-workspaces behavior.
        ...(rt.env ? { env: rt.env } : {}),
        // Omitted when the user never picked: Claude Code's own default is a
        // real choice (an org can move it), not a model we should pin here.
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
        // Fast mode: the same model at up to ~2.5x output speed, priced higher.
        // The SDK only honours it from the inline (flag) settings layer and
        // only when it is explicitly true — a user/project setting is ignored
        // in the Agent SDK ('sdk_opt_in_required'), so it is set at spawn here
        // and cleared, not set false, when turned off (see setFastMode).
        ...(row.fastMode ? { settings: { fastMode: true } } : {}),
        // How much this session asks. Only the SDK's own modes are passed; for
        // 'default' (its baseline) and 'gated' (ours, enforced in canUseTool)
        // the SDK is left at that baseline so every call reaches the gate.
        ...(sdkMode(row.permissionMode) ? { permissionMode: sdkMode(row.permissionMode) } : {}),
        // The SDK refuses 'bypassPermissions' without this explicit opt-in.
        ...(row.permissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        // Revival: replay the agent's own transcript into the new subprocess.
        ...(resumeSdkSessionId ? { resume: resumeSdkSessionId } : {}),
        // Still set under every mode: the permissive modes short-circuit the
        // calls they cover before this runs, and whatever still reaches here
        // is a call that mode decided a human should see.
        canUseTool: (toolName, toolInput, opts) =>
          this.requestPermission(toolName, toolInput, opts),
      },
    })
    void this.pump()
  }

  /**
   * Photograph the repo before this turn starts, so everything the turn does
   * lands between two trees we own. Best-effort: a folder that is not a repo,
   * or a git that fails, simply records nothing and the changes view says so.
   */
  private async beginTurn() {
    if (this.row.kind !== 'chat') return
    const root = await sessionRepoRoot(this.rt, this.row)
    if (!root) return
    // A turn already open means the user sent again mid-turn; the SDK folds
    // that into the running turn, so keep the original pre-tree.
    if (this.rt.openTurns.has(this.row.id)) return
    const preTree = await snapshotTree(root)
    if (!preTree) return
    const seq = (await this.rt.store.turns.lastSeq(this.row.id)) + 1
    const startedAt = Date.now()
    this.rt.openTurns.set(this.row.id, { seq, root, startedAt, touched: new Set() })
    await this.rt.store.turns.begin({ sessionId: this.row.id, seq, root, preTree, startedAt })
  }

  /** Close the open turn with the post-turn tree. Never throws into the pump. */
  private async endTurn() {
    const open = this.rt.openTurns.get(this.row.id)
    if (!open) return
    this.rt.openTurns.delete(this.row.id)
    try {
      const postTree = await snapshotTree(open.root)
      await this.rt.store.turns.end(this.row.id, open.seq, {
        postTree,
        endedAt: Date.now(),
        touched: [...open.touched],
      })
      broadcast(this.rt, { type: 'session_changed', sessionId: this.row.id })
    } catch (err) {
      log('warn', 'git', `snapshot after turn failed: ${errText(err)}`, { session: this.row.id })
    }
  }

  /** Remember which paths this turn's file-editing tools named. */
  private noteToolPaths(m: SdkMessage) {
    const open = this.rt.openTurns.get(this.row.id)
    if (!open || m.type !== 'assistant') return
    for (const b of m.message?.content ?? []) {
      if (!isToolUseBlock(b) || !EDIT_TOOLS.has(b.name)) continue
      const fp = (b.input as { file_path?: unknown })?.file_path
      if (typeof fp === 'string' && fp) open.touched.add(path.resolve(open.root, fp))
    }
  }

  private async pump() {
    try {
      for await (const msg of this.q) {
        const m = msg as unknown as SdkMessage
        // init and result messages carry what fast mode is really doing —
        // including why it is not serving, which is the only way the user
        // learns their toggle was overruled (wrong model, wrong plan, …).
        if (m.fast_mode_state !== undefined) this.noteFastMode(m)
        if (m.type === 'system' && m.subtype === 'init') {
          this.model = m.model
          // The key for `resume` — without it a stored session can't continue.
          if (m.session_id && m.session_id !== this.row.sdkSessionId) {
            this.row.sdkSessionId = m.session_id
            void this.rt.store.sessions.setSdkSessionId(this.row.id, m.session_id)
          }
          // What this CLI won't drive from a browser. Cwd-independent, so it
          // is kept on the workspace: the first session to start teaches the
          // draft tabs too. Set before the list is asked for, which reads it.
          if (m.terminal_slash_commands) this.rt.terminalCommands = m.terminal_slash_commands
          // The subprocess already knows what `/` offers in this folder —
          // take it rather than make the composer pay for its own probe.
          void this.refreshCommands()
          this.setStatus('idle')
        }
        // Skills can be discovered mid-run (the agent walks into a subdirectory
        // with its own). The SDK's contract is replace-don't-merge.
        if (m.type === 'system' && m.subtype === 'commands_changed' && m.commands) {
          noteCommands(this.rt, this.row.cwd, m.commands.map(toCommandInfo))
        }
        if (m.type === 'assistant' || m.type === 'user') this.setStatus('running')
        this.noteToolPaths(m)
        // stream deltas are broadcast live but not persisted (recoverable
        // from the committed assistant message, and the only high-volume thing)
        this.emit({ kind: 'sdk', message: m }, m.type !== 'stream_event')
        if (m.type === 'result') {
          this.setStatus('idle')
          void this.endTurn()
          void this.rt.store.sessions.touch(this.row.id)
          void refreshBranch(this.rt, this.row)
          // The turn may have created files — the next `@` search relists.
          this.rt.files.invalidate(this.row.cwd)
          // A brief run is one turn: its result is the run's end.
          if (this.row.kind === 'brief') void onBriefTurnDone(this.rt, this.row.id)
        }
      }
      this.setStatus('idle')
    } catch (err) {
      this.emit({ kind: 'error', message: String(err) }, true)
      this.setStatus('error')
    } finally {
      // The subprocess is gone; any unanswered prompt can never be answered.
      this.expirePendingPermissions()
      this.rt.live.delete(this.row.id)
      broadcastSessionList(this.rt)
      if (this.row.kind === 'brief') void onBriefSessionEnded(this.rt, this.row.id)
    }
  }

  /**
   * Switch model/effort for every turn from here on. `setModel` and the flag
   * settings layer both apply live, so an in-flight session doesn't restart.
   */
  async setModel(model: string | null, effort: EffortLevel | null) {
    await this.q.setModel(model ?? undefined)
    await this.q.applyFlagSettings({ effortLevel: effort })
  }

  /**
   * Turn fast mode on or off for every turn from here on. Off clears the key
   * from the flag layer rather than writing `false`: the SDK reads absence as
   * "not opted in", which is exactly what off means, and lets any lower-
   * precedence setting speak for itself again.
   */
  async setFastMode(on: boolean) {
    // The last verdict described the old setting; drop it rather than let the
    // UI read a stale "not serving" against a switch just flipped. The next
    // init or result message replaces it.
    this.fastModeState = undefined
    this.fastModeDisabledReason = undefined
    await this.q.applyFlagSettings({ fastMode: on ? true : null })
  }

  /** Ask this session's subprocess what `/` offers in its folder. */
  private async refreshCommands() {
    try {
      noteCommands(this.rt, this.row.cwd, (await this.q.supportedCommands()).map(toCommandInfo))
    } catch (err) {
      log('warn', 'commands', `supportedCommands failed: ${errText(err)}`, { session: this.row.id })
    }
  }

  /** Record the subprocess's own fast-mode verdict, broadcasting on a change. */
  private noteFastMode(m: SdkMessage) {
    const changed =
      m.fast_mode_state !== this.fastModeState ||
      m.fast_mode_disabled_reason !== this.fastModeDisabledReason
    this.fastModeState = m.fast_mode_state
    this.fastModeDisabledReason = m.fast_mode_disabled_reason
    if (changed) broadcastSessionList(this.rt)
  }

  async sendUserMessage(text: string, images?: ImageAttachment[], mentions?: Mention[]) {
    // Mentions are resolved now, against this session's folder, so the event
    // log records what the model was actually given (and why a file wasn't).
    const attached = mentions?.length ? await resolveMentions(this.rt, this.row.cwd, mentions) : null
    // Before the agent can touch anything: the tree this turn starts from.
    await this.beginTurn()
    this.emit({ kind: 'local_user', text, images, mentions: attached?.resolved }, true)
    this.setStatus('running')
    void this.rt.store.sessions.touch(this.row.id)
    // Images lead: the model reads them as context for the text that follows.
    // Attachments trail it, each in its own block, so the ask stays readable.
    const content = [
      ...(images ?? []).map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
      })),
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...(attached?.blocks ?? []).map((t) => ({ type: 'text' as const, text: t })),
    ]
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as SDKUserMessage
    this.input.push(msg)
  }

  private requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    opts: { title?: string; description?: string; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionResult> {
    const effect = classifyEffect(toolName)
    // Reading our own inbox is harmless in any mode — never prompt for it. Every
    // triage write (create/edit/upsert/resolve) still goes through the prompt.
    if (TRIAGE_READ_TOOLS.has(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    }
    // Brief sessions are headless (.docs/next-version.md): nobody is there to
    // answer a prompt, so the policy is fixed — reads and the brief's own write
    // tool run, narrow read-only gh/git commands run, everything else is denied.
    if (this.row.kind === 'brief') {
      const allowed =
        toolName === 'mcp__brief__write_brief' || effect === 'read' || (toolName === 'Bash' && briefBashAllowed(toolInput))
      return Promise.resolve(
        allowed
          ? { behavior: 'allow', updatedInput: toolInput }
          : {
              behavior: 'deny',
              message:
                'This is a headless brief session: only reads, read-only gh/git commands, and write_brief are allowed. Finish the brief with write_brief.',
            },
      )
    }
    // 'gated': reads and lookups run unattended; anything that writes — a file,
    // the shell, or an outward connector call — still surfaces a prompt. The
    // subprocess runs at the SDK default, so this is the one gate it can't skip.
    if (this.row.permissionMode === 'gated' && effect === 'read') {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    }
    const id = randomUUID()
    const suggestions = opts.suggestions ?? []
    return new Promise<PermissionResult>((resolve) => {
      this.pendingPermissions.set(id, { input: toolInput, suggestions, resolve })
      this.emit(
        {
          kind: 'permission_request',
          id,
          toolName,
          input: toolInput,
          title: opts.title,
          description: opts.description,
          canAlwaysAllow: suggestions.length > 0,
          effect,
        },
        true,
      )
    })
  }

  resolvePermission(id: string, behavior: PermissionBehavior, answers?: QuestionAnswers) {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return
    this.pendingPermissions.delete(id)
    if (behavior === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'Denied by the user in the triage web UI.' })
    } else if (answers) {
      // AskUserQuestion: the picked labels ride back in on the tool's input,
      // which is where the tool reads the user's answer from.
      pending.resolve({
        behavior: 'allow',
        updatedInput: { ...pending.input, answers },
      })
    } else {
      // 'allow_always' is 'allow' plus the SDK's suggested rules — re-homed to
      // 'session' first. The SDK suggests 'localSettings', which would write
      // the rule into the project's .claude on disk and outlive the session; a
      // button in a transcript is consent for this session, not a settings
      // edit. Widening the scope beyond that stays a deliberate act in
      // ~/.claude, where the user can see the whole list at once.
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        ...(behavior === 'allow_always' && pending.suggestions.length > 0
          ? { updatedPermissions: pending.suggestions.map(sessionScoped) }
          : {}),
      })
    }
    this.emit({ kind: 'permission_resolved', id, behavior, ...(answers ? { answers } : {}) }, true)
  }

  /**
   * Switch how much this session asks, for every turn from here on.
   *
   * Returns false when the running subprocess cannot take the switch — the
   * caller has already persisted it, so the fix is to end this subprocess and
   * let the next turn revive one built for the new mode. That is the case for
   * 'bypassPermissions': its opt-in is a spawn-time CLI flag, so a subprocess
   * started without it can never be talked into bypassing.
   */
  async setPermissionMode(mode: PermissionMode): Promise<boolean> {
    if (mode === 'bypassPermissions' && !this.bypassArmed) return false
    try {
      // 'gated' (and 'default') run the subprocess at the SDK's baseline; the
      // gate lives in requestPermission, which reads the live row's mode. The
      // row is already updated by the caller, so this switch takes effect at
      // once without a restart.
      await this.q.setPermissionMode(sdkMode(mode) ?? 'default')
      return true
    } catch {
      return false
    }
  }

  /**
   * End the subprocess without killing the session: closing the prompt stream
   * ends the SDK's iteration, and `pump`'s `finally` does the bookkeeping.
   * The next message revives it from the row, picking up whatever changed.
   */
  stop() {
    this.input.close()
  }

  private expirePendingPermissions() {
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'The session ended before this request was answered.' })
      this.emit({ kind: 'permission_resolved', id, behavior: 'expired' }, true)
    }
    this.pendingPermissions.clear()
  }

  async interrupt() {
    try {
      await this.q.interrupt()
    } catch (err) {
      this.emit({ kind: 'error', message: `interrupt failed: ${String(err)}` }, true)
    }
  }

  private setStatus(status: SessionStatus) {
    if (this.status === status) return
    this.status = status
    broadcastSessionList(this.rt)
  }

  private emit(event: SessionEvent, persist: boolean) {
    if (persist) {
      this.seq += 1
      this.rt.store.events.append(this.row.id, this.seq, event).catch((err) => {
        log('error', 'session', `failed to persist event for ${this.row.id}: ${err}`)
      })
    }
    broadcast(this.rt, { type: 'session_event', sessionId: this.row.id, event })
  }
}

// ---------------------------------------------------------------------------
// Session registry helpers — all per-workspace.
// ---------------------------------------------------------------------------
function summarize(rt: WorkspaceRuntime, row: StoredSession): SessionSummary {
  const l = rt.live.get(row.id)
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    status: l?.status ?? 'idle',
    updatedAt: row.updatedAt,
    // The user's pick wins: it is what the next turn runs on, and it is set
    // before the subprocess has reported anything.
    model: row.model ?? l?.model,
    effort: row.effort ?? undefined,
    fastMode: row.fastMode || undefined,
    fastModeState: l?.fastModeState,
    fastModeDisabledReason: l?.fastModeDisabledReason,
    permissionMode: row.permissionMode ?? undefined,
    pinned: row.pinned || undefined,
    branch: rt.branches.get(row.id),
    ...(row.kind !== 'chat' ? { kind: row.kind } : {}),
    ...(row.watchId ? { watchId: row.watchId } : {}),
    ...(rt.sessionItem.has(row.id) ? { itemId: rt.sessionItem.get(row.id) } : {}),
  }
}

/**
 * The chat session list: pinned first, then most recently active. Watch-run
 * sessions are real sessions but not chats — they are excluded here and reached
 * through the watch that owns them (.docs/watches-v2.md).
 */
function summaries(rt: WorkspaceRuntime): SessionSummary[] {
  return [...rt.rows.values()]
    .filter((r) => r.kind !== 'watch-run')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    .map((r) => summarize(rt, r))
}

/**
 * Delete a session for good: its subprocess, its in-memory state, and its
 * whole log. The subprocess is stopped first so nothing is still writing to a
 * row that is about to go.
 */
async function deleteSession(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  rt.live.get(sessionId)?.stop()
  rt.live.delete(sessionId)
  rt.rows.delete(sessionId)
  rt.branches.delete(sessionId)
  await rt.store.sessions.remove(sessionId)
  broadcast(rt, { type: 'session_deleted', sessionId })
  broadcastSessionList(rt)
}

async function refreshBranch(rt: WorkspaceRuntime, row: StoredSession) {
  try {
    const { stdout } = await pExecFile('git', ['-C', row.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim()
    if (branch && rt.branches.get(row.id) !== branch) {
      rt.branches.set(row.id, branch)
      broadcastSessionList(rt)
    }
  } catch {
    // not a git repo — no chip
  }
}

// ---------------------------------------------------------------------------
// Session changes — reconstructing what one session did to a shared worktree
// ---------------------------------------------------------------------------

type OpenTurn = { seq: number; root: string; startedAt: number; touched: Set<string> }

/** Tools whose `file_path` counts as this session naming a file itself. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** A session's repo root, resolved once per session and cached. */
async function sessionRepoRoot(rt: WorkspaceRuntime, row: StoredSession): Promise<string | null> {
  const hit = rt.repoRoots.get(row.id)
  if (hit !== undefined) return hit
  const root = await repoRoot(row.cwd)
  rt.repoRoots.set(row.id, root)
  return root
}

/** Working-tree snapshots are ~100 ms; a burst of requests shares one. */
const nowTrees = new Map<string, { at: number; tree: Promise<string | null> }>()
function currentTree(root: string): Promise<string | null> {
  const hit = nowTrees.get(root)
  if (hit && Date.now() - hit.at < 1500) return hit.tree
  const tree = snapshotTree(root)
  nowTrees.set(root, { at: Date.now(), tree })
  return tree
}

/** A turn's delta, memoised — the trees either side of a finished turn never move. */
async function turnDelta(
  rt: WorkspaceRuntime,
  root: string,
  t: StoredTurn,
  to: string | null,
  live: boolean,
): Promise<TreeChange[]> {
  if (!to) return []
  const key = `${t.sessionId}:${t.seq}`
  if (!live) {
    const hit = rt.turnDeltas.get(key)
    if (hit) return hit
  }
  const delta = await treeDiff(root, t.preTree, to)
  if (!live) rt.turnDeltas.set(key, delta)
  return delta
}

/** Do two turn windows overlap in time? An unfinished turn runs until now. */
const overlaps = (a: StoredTurn, b: StoredTurn): boolean =>
  a.startedAt <= (b.endedAt ?? Date.now()) && b.startedAt <= (a.endedAt ?? Date.now())

/**
 * What this session changed, and how sure we are about each file.
 *
 * Sessions share a working tree, so `git status` cannot answer this. Each of a
 * session's turns is bracketed by two trees, and the agent only edits while
 * its own turn runs — so the union of the per-turn deltas is this session's
 * file set, and anything another session moved outside those windows is simply
 * not in it. Within a window we can still be fooled by a *concurrent* session,
 * which is what `confidence` reports rather than hides.
 */
async function computeSessionChanges(rt: WorkspaceRuntime, row: StoredSession): Promise<SessionChanges> {
  const empty = { files: [], turns: [], insertions: 0, deletions: 0 }
  const root = await sessionRepoRoot(rt, row)
  if (!root) return { root: null, unavailable: 'This session is not running inside a git repository.', ...empty }

  const turns = await rt.store.turns.list(row.id)
  if (!turns.length) return { root, unavailable: 'No turns have run in this session yet.', ...empty }

  const now = await currentTree(root)
  if (!now) return { root, unavailable: 'Could not read the working tree.', ...empty }

  // Everything another session did to this repo since our baseline. Turns that
  // finished before we started cannot have polluted our own window.
  const since = turns[0].startedAt
  const foreign = (await rt.store.turns.othersInRoot(root, row.id)).filter((t) => (t.endedAt ?? Date.now()) >= since)

  // --- our own per-turn deltas: the file set, and which turn moved what -----
  const mine = new Map<string, { turns: number[]; ambiguous: boolean }>()
  const turnSummaries: SessionTurnSummary[] = []
  for (const [i, t] of turns.entries()) {
    const last = i === turns.length - 1
    const to = t.postTree ?? (last ? now : (turns[i + 1]?.preTree ?? null))
    const delta = await turnDelta(rt, root, t, to, t.postTree === null)
    const clashing = foreign.filter((f) => overlaps(t, f))
    for (const c of delta) {
      const e = mine.get(c.path) ?? { turns: [], ambiguous: false }
      e.turns.push(t.seq)
      // Only uncertain when someone else was running *and* no tool of ours
      // named the file during this turn.
      if (clashing.length && !t.touched.includes(path.join(root, c.path))) e.ambiguous = true
      mine.set(c.path, e)
    }
    turnSummaries.push({
      seq: t.seq,
      files: delta.length,
      insertions: delta.reduce((n, c) => n + c.insertions, 0),
      deletions: delta.reduce((n, c) => n + c.deletions, 0),
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      overlapped: [...new Set(clashing.map((c) => c.sessionId))].map((id) => sessionTitle(rt, id)),
    })
  }

  // --- which of those files another session also moved ----------------------
  const alsoBy = new Map<string, Set<string>>()
  for (const f of foreign) {
    const to = f.postTree ?? now
    const delta = await turnDelta(rt, root, f, to, f.postTree === null)
    for (const c of delta) {
      if (!mine.has(c.path)) continue
      const set = alsoBy.get(c.path) ?? new Set<string>()
      set.add(f.sessionId)
      alsoBy.set(c.path, set)
    }
  }

  // --- the numbers: net baseline → now, so a file edited twice counts once --
  const net = await treeDiff(root, turns[0].preTree, now)
  const touchedAbs = new Set(turns.flatMap((t) => t.touched))
  const files: ChangedFile[] = []
  for (const c of net) {
    const ours = mine.get(c.path)
    if (!ours) continue // moved in this folder, but never inside one of our turns
    const also = [...(alsoBy.get(c.path) ?? [])]
    files.push({
      path: c.path,
      status: c.status,
      insertions: c.insertions,
      deletions: c.deletions,
      isBinary: c.isBinary,
      touched: touchedAbs.has(path.join(root, c.path)),
      confidence: also.length ? 'shared' : ours.ambiguous ? 'ambiguous' : 'exact',
      alsoChangedBy: also.map((id) => sessionTitle(rt, id)),
      turns: ours.turns,
    })
  }

  return {
    root,
    files,
    turns: turnSummaries,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  }
}

const sessionTitle = (rt: WorkspaceRuntime, id: string): string => rt.rows.get(id)?.title ?? 'another session'

/** One file's patch, from this session's baseline to the working tree. */
async function sessionFilePatch(
  rt: WorkspaceRuntime,
  row: StoredSession,
  file: string,
): Promise<{ patch: string; truncated: boolean } | null> {
  const root = await sessionRepoRoot(rt, row)
  if (!root) return null
  const turns = await rt.store.turns.list(row.id)
  if (!turns.length) return null
  const now = await currentTree(root)
  if (!now) return null
  return filePatch(root, turns[0].preTree, now, file)
}

async function createSession(
  rt: WorkspaceRuntime,
  title: string,
  cwd: string,
  model: string | null,
  effort: EffortLevel | null,
  fastMode: boolean,
  permissionMode: PermissionMode | null,
  opts: { kind?: SessionKind } = {},
): Promise<StoredSession> {
  const row = await rt.store.sessions.create({
    id: randomUUID(),
    title,
    cwd,
    model,
    effort,
    fastMode,
    permissionMode,
    ...(opts.kind ? { kind: opts.kind } : {}),
  })
  rt.rows.set(row.id, row)
  rt.live.set(row.id, new LiveSession(rt, row, 0, null, extrasFor(rt, row)))
  void refreshBranch(rt, row)
  return row
}

/** The live subprocess for a session, starting one (with `resume`) if needed. */
// ---------------------------------------------------------------------------
// `@` mentions — resolved at send time into blocks the model reads
// ---------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… [truncated — ${s.length - n} more characters]` : s)

/** What a session last said, for a `@session:` stub — its final reply, else the last assistant text. */
async function lastReplyText(rt: WorkspaceRuntime, sessionId: string): Promise<string | null> {
  const last = await rt.store.events.lastSeq(sessionId)
  const events = await rt.store.events.read(sessionId, Math.max(0, last - 200))
  let assistant: string | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i].event
    if (ev.kind !== 'sdk') continue
    const m = ev.message as SdkMessage & { result?: unknown }
    if (m.type === 'result' && typeof m.result === 'string' && m.result) return m.result
    if (!assistant && m.type === 'assistant') {
      const text = (m.message?.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
      if (text) assistant = text
    }
  }
  return assistant
}

const attachmentTag = (kind: string, attrs: Record<string, string | number | undefined>, body?: string) => {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join('')
  return body === undefined ? `<attachment kind="${kind}"${a} />` : `<attachment kind="${kind}"${a}>\n${body}\n</attachment>`
}

/**
 * Turn the composer's mentions into what rides the message. Files are read
 * inside `cwd` (small text inlined, everything else passed as a path with a
 * note); items and sessions become short summaries. The returned `resolved`
 * list is what the event log keeps, so the transcript can show what landed.
 */
async function resolveMentions(
  rt: WorkspaceRuntime,
  cwd: string,
  mentions: Mention[],
): Promise<{ resolved: ResolvedMention[]; blocks: string[] }> {
  const resolved: ResolvedMention[] = []
  const blocks: string[] = []
  let budget = MAX_INLINE_TOTAL_BYTES
  const seen = new Set<string>()
  for (const m of mentions) {
    const key = `${m.kind}:${m.ref}`
    if (seen.has(key)) continue
    seen.add(key)
    if (m.kind === 'file') {
      const f = await resolveFileMention(cwd, m.ref)
      switch (f.kind) {
        case 'text': {
          if (f.bytes > budget) {
            const error = 'over the per-message inline budget'
            resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: false, error })
            blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes, note: `not inlined: ${error} — read it from disk` }))
            break
          }
          budget -= f.bytes
          resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: true })
          blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes }, f.text))
          break
        }
        case 'large': {
          const error = `too large to inline (${Math.round(f.bytes / 1024)} KB)`
          resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: false, error })
          blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes, note: `not inlined: ${error} — read the parts you need from disk` }))
          break
        }
        case 'binary': {
          resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: false, error: 'binary file' })
          blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes, note: 'binary file — not inlined' }))
          break
        }
        case 'dir': {
          const listing = f.entries.join('\n')
          budget -= listing.length
          resolved.push({ ...m, ref: f.rel, inlined: true })
          blocks.push(attachmentTag('directory', { path: f.rel, entries: f.entries.length }, listing))
          break
        }
        case 'error':
          resolved.push({ ...m, inlined: false, error: f.error })
          blocks.push(attachmentTag('file', { path: m.ref, note: `could not be attached: ${f.error}` }))
          break
      }
    } else if (m.kind === 'item') {
      const scored = rt.inboxCache?.items.find((i) => i.id === m.ref)
      const item = scored ?? (await rt.store.items.get(m.ref).catch(() => null))
      if (!item) {
        resolved.push({ ...m, inlined: false, error: 'not found' })
        blocks.push(attachmentTag('work_item', { id: m.ref, note: 'could not be attached: not found in this workspace' }))
        continue
      }
      const lines = [
        `title: ${item.title}`,
        `kind: ${item.kind} (${item.source})`,
        item.url && `url: ${item.url}`,
        item.repo && `where: ${item.repo}`,
        item.author && `author: ${item.author}`,
        item.status && `status: ${item.status}`,
        scored && `rank: ${scored.score} — ${scored.reason}`,
        item.why && `why: ${item.why}`,
        item.description && `description: ${item.description}`,
        item.refs?.length ? `refs: ${item.refs.join(', ')}` : undefined,
      ].filter((l): l is string => typeof l === 'string' && l.length > 0)
      resolved.push({ ...m, label: item.title, inlined: true })
      blocks.push(attachmentTag('work_item', { id: item.id }, lines.join('\n')))
    } else if (m.kind === 'session') {
      const row = rt.rows.get(m.ref)
      if (!row) {
        resolved.push({ ...m, inlined: false, error: 'not found' })
        blocks.push(attachmentTag('session', { id: m.ref, note: 'could not be attached: no such session in this workspace' }))
        continue
      }
      const sum = summarize(rt, row)
      const last = await lastReplyText(rt, row.id).catch(() => null)
      const lines = [
        `title: ${row.title}`,
        `folder: ${row.cwd}`,
        `status: ${sum.status}`,
        sum.branch && `branch: ${sum.branch}`,
        `last activity: ${new Date(row.updatedAt).toISOString()}`,
        row.sdkSessionId &&
          `claude session id: ${row.sdkSessionId} — its full transcript is under ~/.claude/projects, or \`claude --resume ${row.sdkSessionId}\` from that folder`,
      ].filter((l): l is string => typeof l === 'string' && l.length > 0)
      const body = lines.join('\n') + (last ? `\n\nlast reply:\n${clip(last, 4000)}` : '')
      resolved.push({ ...m, label: row.title, inlined: true })
      blocks.push(attachmentTag('session', { id: row.id }, body))
    } else if (m.kind === 'artifact') {
      const a = await rt.artifacts.read(m.ref).catch(() => null)
      if (!a) {
        resolved.push({ ...m, inlined: false, error: 'not found' })
        blocks.push(attachmentTag('artifact', { id: m.ref, note: 'could not be attached: no such artifact in this workspace' }))
        continue
      }
      const bytes = Buffer.byteLength(a.body, 'utf8')
      const attrs = { id: a.artifact.id, title: a.artifact.title, author: a.artifact.author, path: a.abs }
      if (bytes > MAX_INLINE_FILE_BYTES || bytes > budget) {
        const error = bytes > MAX_INLINE_FILE_BYTES ? `too large to inline (${Math.round(bytes / 1024)} KB)` : 'over the per-message inline budget'
        resolved.push({ ...m, label: a.artifact.title, bytes, inlined: false, error })
        blocks.push(attachmentTag('artifact', { ...attrs, bytes, note: `not inlined: ${error} — read it from disk` }))
        continue
      }
      budget -= bytes
      resolved.push({ ...m, label: a.artifact.title, bytes, inlined: true })
      blocks.push(attachmentTag('artifact', { ...attrs, bytes }, a.body))
    }
  }
  if (blocks.length > 0) {
    blocks.unshift('The user attached the following with @-mentions; the message above refers to them by these names.')
  }
  return { resolved, blocks }
}

/** A folder the `@` picker may list: a session's folder, a project, or anywhere under home. */
async function isSearchableRoot(rt: WorkspaceRuntime, root: string): Promise<boolean> {
  try {
    if (!(await stat(root)).isDirectory()) return false
  } catch {
    return false
  }
  const under = (base: string) => root === base || root.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
  if ([...rt.rows.values()].some((r) => r.cwd === root)) return true
  if ((await rt.store.projects.list()).some((p) => under(p.path))) return true
  return under(os.homedir())
}

async function getOrRevive(rt: WorkspaceRuntime, sessionId: string): Promise<LiveSession | null> {
  const existing = rt.live.get(sessionId)
  if (existing) return existing
  const row = rt.rows.get(sessionId)
  if (!row) return null
  const lastSeq = await rt.store.events.lastSeq(row.id)
  const revived = new LiveSession(rt, row, lastSeq, row.sdkSessionId, extrasFor(rt, row))
  rt.live.set(row.id, revived)
  broadcastSessionList(rt)
  return revived
}

/**
 * Boot: load stored sessions, and expire permission prompts orphaned by the
 * previous process (their subprocess died with it — Allow can never apply).
 */
async function loadSessions(rt: WorkspaceRuntime) {
  for (const row of await rt.store.sessions.list()) {
    rt.rows.set(row.id, row)
    void refreshBranch(rt, row)

    const events = await rt.store.events.read(row.id)
    const unresolved = new Map<string, true>()
    for (const e of events) {
      if (e.event.kind === 'permission_request') unresolved.set(e.event.id, true)
      if (e.event.kind === 'permission_resolved') unresolved.delete(e.event.id)
    }
    let seq = events.length ? events[events.length - 1].seq : 0
    for (const id of unresolved.keys()) {
      seq += 1
      await rt.store.events.append(row.id, seq, { kind: 'permission_resolved', id, behavior: 'expired' })
    }
  }
}

// ---------------------------------------------------------------------------
// Inbox: ranked work items from deterministic sources (core/work). No cron —
// the server IS the long-running process. Sync happens when the page is
// viewed and the cache is stale (stale-while-revalidate, the cache living in
// SQLite so a fresh server start still renders instantly), on explicit
// Refresh, and on a keep-warm interval while the server runs. A laptop that
// slept through the interval simply syncs on the next view.
// ---------------------------------------------------------------------------
const INBOX_TTL_MS = 5 * 60_000
const INBOX_KEEP_WARM_MS = 15 * 60_000
const SCHEDULER_TICK_MS = 60_000
const GITHUB_TTL_MS = 5 * 60_000
const GITHUB_LOOKBACK_MS = 14 * 86_400_000
/** how many watch runs may execute at once (avoid the top-of-hour stampede) */
const WATCH_CONCURRENCY = 2
const WATCH_TIMEOUT_MS = 240_000

const REPOS_KEY = 'github.repos'
const WATCHES_SEEDED_KEY = 'watches.seeded'

/** when the scheduler last ticked — daemon-wide, surfaced in the System status. */
let lastSchedulerTickAt: number | null = null

async function connectedRepos(rt: WorkspaceRuntime): Promise<string[]> {
  return (await rt.store.config.get<string[]>(REPOS_KEY)) ?? []
}

/** Is the claude.ai Slack connector connected, per the last connector probe? */
function slackConnected(rt: WorkspaceRuntime): boolean | null {
  if (!rt.connectorCache) return null // no probe yet
  return rt.connectorCache.connectors.some(
    (c) => c.source === 'claude.ai' && c.name === 'Slack' && c.status === 'connected',
  )
}

/**
 * GitHub reconciliation (.docs/watches-v2.md). GitHub is a deterministic source,
 * not an LLM scan, so it stays plain code — but it now writes into the SAME
 * durable store as everything else instead of being refetched-and-discarded
 * every view. Open PRs/issues are upserted (idempotent, newer-wins); a tracked
 * open item whose PR has since merged or closed is auto-done with actor:system
 * and evidence — recorded and reversible, never a silent vanish. Throttled; a
 * failure degrades to a notice and keeps whatever is already stored.
 */
async function reconcileGitHub(rt: WorkspaceRuntime, force = false): Promise<void> {
  if (rt.githubReconcileInFlight) return rt.githubReconcileInFlight
  if (!force && Date.now() - rt.githubReconcileAt < GITHUB_TTL_MS) return
  rt.githubReconcileInFlight = (async () => {
    try {
      const repos = await connectedRepos(rt)
      // Workspace isolation (.docs/workspaces.md): repo scope is per-workspace,
      // and an empty scope means NO GitHub items — not the whole account. An
      // account-wide search would mirror the same PRs into every workspace's
      // inbox, which is exactly the cross-workspace bleed workspaces exist to
      // prevent. You opt each workspace into the repos it should track.
      if (repos.length === 0) {
        rt.githubNotice = null
        rt.githubReconcileAt = Date.now()
        return
      }
      const now = Date.now()
      const open = await fetchGitHub(repos, now)
      for (const item of open) await rt.store.items.upsert(item)

      // Source-side completion: any tracked open/snoozed github item whose PR is
      // now merged/closed → done(system) with evidence.
      const closed = await fetchGitHubClosed(repos, new Date(now - GITHUB_LOOKBACK_MS).toISOString())
      if (closed.length > 0) {
        const byId = new Map(closed.map((c) => [c.id, c]))
        for (const it of await rt.store.items.listAll()) {
          if (it.source !== 'github') continue
          if (it.status !== 'open' && it.status !== 'snoozed') continue
          const c = byId.get(it.id)
          if (c) {
            const reason = c.state === 'merged' ? 'PR merged' : 'PR closed'
            await rt.store.items.transition(it.id, {
              status: 'done',
              actor: 'system',
              detail: { reason, evidence: c.url },
            })
            log('info', 'github', `auto-done: ${it.id} (${reason})`, { id: it.id, state: c.state, workspace: rt.meta.id })
          }
        }
      }
      rt.githubNotice = null
      rt.githubReconcileAt = Date.now()
      log('info', 'github', `reconciled: ${open.length} open, ${closed.length} closed/merged`, { workspace: rt.meta.id })
    } catch (err) {
      rt.githubNotice = `github: ${err instanceof Error ? err.message : String(err)}`
      log('error', 'github', err instanceof Error ? err.message : String(err), { workspace: rt.meta.id })
    } finally {
      rt.githubReconcileInFlight = null
    }
  })()
  return rt.githubReconcileInFlight
}

/**
 * Rebuild the open-inbox snapshot from the durable store: wake elapsed snoozes,
 * reconcile GitHub (throttled), then rank + link the open items. There is no
 * user-state overlay any more — status lives on each row, so this is a pure
 * fold over what the store already holds.
 */
function syncInbox(rt: WorkspaceRuntime): Promise<InboxSnapshot> {
  if (rt.inboxInFlight) return rt.inboxInFlight
  rt.inboxInFlight = (async () => {
    try {
      const now = Date.now()
      await rt.store.items.wakeSnoozed(now)
      await reconcileGitHub(rt)
      const scoped = new Set(await connectedRepos(rt))
      const items = scopeGitHub(await rt.store.items.list('open'), scoped)
      const notices: string[] = []
      if (rt.githubNotice) notices.push(rt.githubNotice)
      // Honest empty state: a workspace with no repos scoped pulls no GitHub —
      // say so, so "nothing here" is never mistaken for "the source is broken".
      if (scoped.size === 0) {
        notices.push('github: no repos scoped to this workspace — pick repos in the inbox’s repo filter to pull PRs and issues here')
      }
      if (slackConnected(rt) === false) {
        notices.push('slack: the claude.ai Slack connector is disconnected — reconnect it for Slack items to appear')
      } else if (slackConnected(rt) === true && (await watchesEnabled(rt))) {
        // Honest empty state: surface any watch that failed or has gone overdue,
        // so "nothing here" is never confused with "the scan never looked".
        for (const w of await rt.store.watches.list()) {
          if (!w.enabled) continue
          if (w.lastRunStatus === 'failed') {
            notices.push(`watch “${w.title}” last run failed${w.lastRunError ? `: ${w.lastRunError}` : ''}`)
          } else if (overdueWatch(w, now)) {
            notices.push(`watch “${w.title}” hasn’t completed a run recently — items from it may be missing`)
          }
        }
      }
      const { items: ranked } = buildInbox({ items, notices, now })
      rt.inboxCache = { syncedAt: now, items: ranked, notices }
      void rt.store.inbox.save(rt.inboxCache)
      return rt.inboxCache
    } finally {
      rt.inboxInFlight = null
    }
  })()
  return rt.inboxInFlight
}

/**
 * Drop GitHub items outside this workspace's repo scope (.docs/workspaces.md).
 * Repo scope is per-workspace and empty = none, so a workspace only ever shows
 * PRs/issues from the repos it opted into — even for rows ingested earlier under
 * a wider (or account-wide) scope. Non-destructive: nothing is mutated, so
 * re-scoping a repo makes its items reappear at once. Other sources pass through.
 */
function scopeGitHub<T extends { source: string; repo: string }>(items: T[], scoped: Set<string>): T[] {
  return items.filter((i) => i.source !== 'github' || scoped.has(i.repo))
}

/** Ranked items for a status tab other than the open inbox (read-only, no scan). */
async function listItemsByStatus(rt: WorkspaceRuntime, status: ItemStatus, now = Date.now()): Promise<InboxSnapshot['items']> {
  const scoped = new Set(await connectedRepos(rt))
  const items = scopeGitHub(await rt.store.items.list(status), scoped)
  return linkByRefs(rank(items, now))
}

// ---------------------------------------------------------------------------
// Watch runs (.docs/watches-v2.md): one run per watch, each a real session so
// its transcript is the run's receipt. A small queue caps concurrency and
// jitters starts so the top of the hour doesn't stampede; a per-watch in-flight
// guard turns "already running" into a recorded 'skipped', never a silent no-op.
// The output contract is TOOL CALLS: the run gets a permalink-shaped
// upsert_work_item that stamps identity, kind, and provenance, so a work item
// exists because a tool call created it — no JSON parsing, no cursor-advance-on-
// garbled-output bug. Cursors advance only on a successful run.
// ---------------------------------------------------------------------------
function sumTokens(usage: Record<string, unknown> | undefined): number {
  let tokens = 0
  const u = usage ?? {}
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    const v = u[k]
    if (typeof v === 'number') tokens += v
  }
  return tokens
}

/** A watch is overdue if no run has completed within a grace window past its cadence. */
function overdueWatch(w: Watch, now: number): boolean {
  const grace = w.cadence === 'hourly' ? 2 * 3_600_000 : w.cadence === 'daily' ? 26 * 3_600_000 : 8 * 86_400_000
  return now - (w.lastRunAt ?? w.createdAt) > grace
}

/** The daemon's live status for one workspace, for the System modal. */
/**
 * Where Claude Code keeps its transcripts. The user's own `~/.claude` (or
 * whatever `CLAUDE_CONFIG_DIR` points at), plus the private config dir of
 * every workspace on the `config-dir` auth backend — those sessions are the
 * user's spend too, and they log somewhere else.
 */
function claudeProjectRoots(): string[] {
  const roots = new Set<string>()
  roots.add(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'))
  for (const ws of loadRegistry().workspaces) {
    if (ws.authBackend === 'config-dir') roots.add(path.join(workspaceClaudeDir(ws.id), 'projects'))
  }
  return [...roots]
}

async function systemStatus(rt: WorkspaceRuntime): Promise<SystemStatus> {
  const now = Date.now()
  const watches = await rt.store.watches.list()
  const enabled = watches.filter((w) => w.enabled)
  return {
    version: VERSION,
    startedAt: SERVER_STARTED,
    uptimeMs: now - SERVER_STARTED,
    port: PORT,
    workspace: rt.meta.name,
    db: dbFileFor(rt.meta.id, registry.defaultId),
    liveSessions: rt.live.size,
    slackConnected: slackConnected(rt),
    connectorsProbedAt: rt.connectorCache?.probedAt ?? null,
    connectorCount: rt.connectorCache?.connectors.length ?? null,
    schedulerLastTickAt: lastSchedulerTickAt,
    runningWatches: rt.runningWatches.size,
    watchesEnabled: await watchesEnabled(rt),
    inboxSyncedAt: rt.inboxCache?.syncedAt ?? null,
    githubReconcileAt: rt.githubReconcileAt || null,
    githubNotice: rt.githubNotice,
    watches: {
      total: watches.length,
      enabled: enabled.length,
      overdue: enabled.filter((w) => overdueWatch(w, now)).length,
      failing: enabled.filter((w) => w.lastRunStatus === 'failed').length,
    },
    logDir: logFilePath(),
  }
}

async function runDueWatches(rt: WorkspaceRuntime, opts: { force?: boolean } = {}): Promise<void> {
  // The global switch (Settings → Sources) — off means the scheduler never runs a watch.
  if (!(await watchesEnabled(rt))) return
  if (slackConnected(rt) !== true) return
  const now = new Date()
  for (const w of await rt.store.watches.list()) {
    if (!w.enabled) continue
    if (!opts.force && !isDue(w, now)) continue
    if (rt.runningWatches.has(w.id)) {
      // a previous run is still going — record the skip rather than swallow it
      await rt.store.watches.recordRun(w.id, {
        lastRunAt: Date.now(),
        lastRunTokens: 0,
        lastRunMatches: 0,
        status: 'skipped',
        error: 'previous run still in progress',
      })
      log('warn', 'scheduler', `skipped ${w.title}: previous run still in progress`, { watchId: w.id, workspace: rt.meta.id })
      continue
    }
    if (!rt.runQueue.includes(w.id)) rt.runQueue.push(w.id)
  }
  pumpRunQueue(rt)
}

/**
 * Queue a single watch to run now (the per-watch "Run" button — a force run,
 * independent of cadence). Respects the in-flight guard so a double-click can't
 * start two runs of the same watch. Returns whether it queued or was already
 * running. Scheduled cadence runs continue independently via runDueWatches.
 */
function enqueueWatch(rt: WorkspaceRuntime, id: string): 'queued' | 'running' {
  if (rt.runningWatches.has(id)) return 'running'
  if (!rt.runQueue.includes(id)) rt.runQueue.push(id)
  pumpRunQueue(rt)
  return 'queued'
}

function pumpRunQueue(rt: WorkspaceRuntime): void {
  while (rt.activeRuns < WATCH_CONCURRENCY && rt.runQueue.length > 0) {
    const id = rt.runQueue.shift()!
    if (rt.runningWatches.has(id)) continue
    rt.runningWatches.add(id)
    rt.activeRuns += 1
    const jitter = Math.floor(Math.random() * 3_000)
    setTimeout(() => {
      runWatch(rt, id)
        .catch((err) => log('error', 'watch', `run crashed: ${err}`, { workspace: rt.meta.id }))
        .finally(() => {
          rt.activeRuns -= 1
          rt.runningWatches.delete(id)
          pumpRunQueue(rt)
        })
    }, jitter)
  }
}

/**
 * Identity for a filed item, derived from the link the scanner saw — never from
 * the watch. A Slack permalink → slack:<tail>; a GitHub PR/issue URL →
 * github:owner/repo#n; a Linear URL or key → linear:KEY-n. Anything else is
 * rejected: an id we cannot canonicalize cannot dedupe.
 */
function identityFromUrl(raw: string): { id: string; source: WorkSource; url: string; home: string } | null {
  const url = raw.trim()
  if (/\/archives\//.test(url)) return { id: permalinkId(url), source: 'slack', url, home: '' }
  const ref = canonicalizeRef(url)
  if (!ref) return null
  if (ref.startsWith('github:')) {
    const m = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref)
    if (!m) return null
    const href = url.startsWith('http') ? url : `https://github.com/${m[1]}/issues/${m[2]}`
    return { id: ref, source: 'github', url: href, home: m[1] }
  }
  if (ref.startsWith('linear:')) {
    const key = ref.slice('linear:'.length)
    const href = url.startsWith('http') ? url : `https://linear.app/issue/${key}`
    return { id: ref, source: 'linear', url: href, home: key.slice(0, key.indexOf('-')) }
  }
  if (ref.startsWith('web:')) return { id: ref, source: 'web', url, home: webHost(url) }
  return null
}

function webHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The upsert tool's arguments — shared by the real run and the dry run so the prompt fits both. */
const UPSERT_SHAPE = {
  url: z.string().describe('the canonical link: Slack permalink, Linear issue URL or key, GitHub PR/issue URL, or the web page URL'),
  title: z.string().describe('a one-line summary'),
  place: z.string().optional().describe('where it lives: "#channel", "@dm", a Linear team key, "owner/repo", or the site name'),
  from: z.string().optional().describe('the author or asker'),
  lastActivity: z.string().describe('ISO 8601 timestamp of the newest activity'),
  why: z.string().describe('one line: exactly what matched the instructions'),
  refs: z.array(z.string()).optional().describe('other GitHub PR/issue URLs or Linear keys in the content'),
}
const DIGEST_SHAPE = {
  title: z.string().describe('a short name for this edition, e.g. "AI news · 12 Sep"'),
  body: z.string().describe('the whole digest as markdown'),
  refs: z.array(z.string()).optional().describe('GitHub PR/issue URLs or Linear keys cited in the digest'),
}

/**
 * The per-run ingestion tool. Upsert-only, link-shaped: the scanner passes
 * what it can see (a link, title, why, timestamp, refs); the server derives
 * identity from the link and stamps kind and provenance (this watch + run). So
 * the model only ADDS candidates and annotates why — lifecycle stays in code.
 */
function makeScanMcp(rt: WorkspaceRuntime, watch: Watch, runId: string, onUpsert: () => void) {
  let count = 0
  if (watch.output === 'digest') return makeDigestMcp(rt, watch, runId, onUpsert)
  return createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    tools: [
      tool(
        'upsert_work_item',
        'Record ONE match as a work item. Call once per match; the server derives the id from the link and stamps provenance.',
        UPSERT_SHAPE,
        async (args) => {
          try {
            // Cost guard, enforced here not just in the prompt.
            if (count >= MAX_ROWS_PER_RUN) {
              return errResult(`row cap reached (${MAX_ROWS_PER_RUN}) — stop calling this tool`)
            }
            const ident = identityFromUrl(args.url)
            if (!ident) return errResult('url must be a Slack permalink, a Linear issue URL or key, or a GitHub PR/issue URL')
            count += 1
            const now = Date.now()
            const when = safeWhen(args.lastActivity, now)
            const refs = canonicalizeRefs(args.refs)
            const item: CoreWorkItem = {
              id: ident.id,
              source: ident.source,
              kind: watch.createsItems ? 'watch-hit' : 'fyi',
              title: args.title,
              url: ident.url,
              repo: args.place?.trim() || ident.home,
              author: args.from ?? '',
              peopleWaiting: 0,
              createdAt: when,
              updatedAt: when,
              ...(refs ? { refs } : {}),
            }
            const prov: Provenance = { watchId: watch.id, runId, at: now, why: args.why }
            const { outcome } = await rt.store.items.upsert(item, prov)
            onUpsert()
            rt.inboxCache = null
            log('info', 'watch', `filed (${outcome}): ${item.title}`, {
              id: item.id,
              watchId: watch.id,
              runId,
              place: item.repo,
              outcome,
              workspace: rt.meta.id,
            })
            return okResult('ok: recorded')
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
    ],
  })
}

/** The one file a digest watch rewrites: stable per watch, so writeAt updates in place. */
const digestRelPath = (watch: Watch): string => `reports/${slug(watch.title) || 'digest'}-${watch.id.slice(0, 8)}.md`

/**
 * The digest watch's write tool. One call per run: the server rewrites the
 * watch's report artifact in place, upserts the watch's single rolling item
 * (id `watch:<id>`) with a fresh timestamp — so a done item returns with the
 * "returned" marker — and links report → item. The model writes prose; code
 * owns identity, lifecycle and the link, as everywhere else.
 */
function makeDigestMcp(rt: WorkspaceRuntime, watch: Watch, runId: string, onWrite: () => void) {
  let written = false
  return createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    tools: [
      tool(
        'write_digest',
        'Save this run’s digest: ONE markdown report. Call exactly once with the whole document.',
        DIGEST_SHAPE,
        async (args) => {
          try {
            if (written) return errResult('the digest was already written this run — stop calling this tool')
            const title = args.title.trim() || `${watch.title} · ${new Date().toLocaleDateString()}`
            const refs = canonicalizeRefs(args.refs)
            const artifact = await rt.artifacts.writeAt(digestRelPath(watch), {
              title,
              body: args.body,
              author: 'model',
              ...(refs ? { refs } : {}),
            })
            const nowIso = new Date().toISOString()
            const item: CoreWorkItem = {
              id: `watch:${watch.id}`,
              source: 'watch',
              kind: 'digest',
              title,
              url: `#/artifact/${artifact.id}`,
              repo: watch.title,
              author: '',
              peopleWaiting: 0,
              createdAt: nowIso,
              updatedAt: nowIso,
              ...(refs ? { refs } : {}),
            }
            const prov: Provenance = { watchId: watch.id, runId, at: Date.now(), why: 'digest rewritten' }
            const { outcome, reopened } = await rt.store.items.upsert(item, prov)
            await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'item', toId: item.id, role: 'report' })
            written = true
            onWrite()
            rt.inboxCache = null
            log('info', 'watch', `digest written (${outcome}${reopened ? ', returned' : ''}): ${title}`, { id: item.id, watchId: watch.id, runId, artifact: artifact.path, workspace: rt.meta.id })
            return okResult(`ok: digest saved as ${artifact.path}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
    ],
  })
}

type WatchPreview = {
  id: string
  status: 'running' | 'ready' | 'failed'
  /** the transcript, minus stream deltas — replayed to late subscribers like a session's log */
  events: SessionEvent[]
  result?: WatchPreviewResult
  error?: string
  startedAt: number
}
const PREVIEW_TTL_MS = 15 * 60_000

type PreviewSpec = { instruction: string; connectors: WatchConnector[]; projectId?: string; model?: string; output: WatchOutput }

/**
 * Start a dry run of a watch as the form currently describes it. Same prompt,
 * tools and fences as a real run; the write tool only collects. The run is
 * streamed over the WebSocket under an ephemeral session id so the form can
 * show the transcript live, but nothing is persisted — no session row, no
 * events, no items, no artifact. The caller polls for the outcome.
 */
function startWatchPreview(rt: WorkspaceRuntime, spec: PreviewSpec): string {
  const pv: WatchPreview = { id: randomUUID(), status: 'running', events: [], startedAt: Date.now() }
  rt.previews.set(pv.id, pv)
  void runWatchPreview(rt, pv, spec)
  return pv.id
}

async function runWatchPreview(rt: WorkspaceRuntime, pv: WatchPreview, spec: PreviewSpec): Promise<void> {
  const emit = (event: SessionEvent, keep = true) => {
    if (keep) pv.events.push(event)
    broadcast(rt, { type: 'session_event', sessionId: pv.id, event })
  }
  const project = spec.projectId ? (await rt.store.projects.list()).find((p) => p.id === spec.projectId) ?? null : null
  const cwd = project?.path ?? os.homedir()
  const rows: WatchPreviewRow[] = []
  let digest: { title: string; body: string } | undefined
  const collector = createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    tools:
      spec.output === 'digest'
        ? [
            tool('write_digest', 'Save this run’s digest: ONE markdown report. Call exactly once with the whole document.', DIGEST_SHAPE, async (args) => {
              if (digest) return errResult('the digest was already written this run — stop calling this tool')
              digest = { title: args.title.trim() || 'Digest', body: args.body }
              return okResult('ok: digest recorded')
            }),
          ]
        : [
            tool('upsert_work_item', 'Record ONE match as a work item. Call once per match; the server derives the id from the link.', UPSERT_SHAPE, async (args) => {
              if (rows.length >= MAX_ROWS_PER_RUN) return errResult(`row cap reached (${MAX_ROWS_PER_RUN}) — stop calling this tool`)
              const ident = identityFromUrl(args.url)
              if (!ident) return errResult('url must be a Slack permalink, a Linear issue URL or key, a GitHub PR/issue URL, or a web page URL')
              if (rows.some((r) => r.id === ident.id)) return okResult('ok: already recorded')
              rows.push({
                id: ident.id,
                title: args.title,
                url: ident.url,
                place: args.place?.trim() || ident.home,
                from: args.from ?? '',
                lastActivity: safeWhen(args.lastActivity, Date.now()),
                why: args.why,
              })
              return okResult('ok: recorded')
            }),
          ],
  })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), WATCH_TIMEOUT_MS)
  let tokens = 0
  let costUsd: number | undefined
  let resultText = ''
  let sawResult = false
  try {
    const q = query({
      prompt: composeRunPrompt({
        instruction: spec.instruction,
        connectors: spec.connectors,
        project: project ? { name: project.name, path: project.path } : null,
        output: spec.output,
      }),
      options: {
        cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user'],
        includePartialMessages: true,
        allowedTools: runAllowedTools(spec.connectors, project !== null, spec.output),
        ...(spec.model ? { model: spec.model } : {}),
        mcpServers: { triage: collector },
        abortController: abort,
        ...(rt.env ? { env: rt.env } : {}),
      },
    })
    for await (const msg of q) {
      const m = msg as unknown as SdkMessage & { result?: string; usage?: Record<string, unknown>; total_cost_usd?: unknown }
      emit({ kind: 'sdk', message: m as SdkMessage }, m.type !== 'stream_event')
      if (m.type === 'result') {
        sawResult = true
        resultText = typeof m.result === 'string' ? m.result : ''
        tokens = sumTokens(m.usage)
        if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd
      }
    }
    if (resultText.includes('no-connector-tools')) {
      throw new Error(`no connector tools — connect ${spec.connectors.join(', ')} for Claude at claude.ai/settings/connectors`)
    }
    if (!sawResult) throw new Error(abort.signal.aborted ? 'the preview timed out' : 'the preview ended without a result')
    pv.result = { output: spec.output, rows, ...(digest ? { digest } : {}), tokens, ...(costUsd != null ? { costUsd } : {}), durationMs: Date.now() - pv.startedAt }
    pv.status = 'ready'
    log('info', 'watch', `preview: ${rows.length} row(s)${digest ? ', digest' : ''}, ${Math.round(tokens / 1000)}k tok`, { previewId: pv.id, workspace: rt.meta.id })
  } catch (err) {
    pv.error = err instanceof Error ? err.message : String(err)
    pv.status = 'failed'
    emit({ kind: 'error', message: pv.error })
    log('warn', 'watch', `preview failed: ${pv.error}`, { previewId: pv.id, workspace: rt.meta.id })
  } finally {
    clearTimeout(timer)
    setTimeout(() => rt.previews.delete(pv.id), PREVIEW_TTL_MS).unref()
  }
}

/**
 * Run one watch to completion as a headless session. Persists the transcript to
 * the event log (so it is observable like any session), advances the cursor only
 * on success, and records the run's status/tokens/matches on the watch row.
 */
async function runWatch(rt: WorkspaceRuntime, watchId: string): Promise<void> {
  const watch = await rt.store.watches.get(watchId)
  if (!watch) return
  const startedMs = Date.now()
  const startedIso = new Date(startedMs).toISOString()
  // An optional project gives the run a folder to read code in. A project that
  // has since been removed degrades to no project — the run still happens.
  const project = watch.projectId ? (await rt.store.projects.list()).find((p) => p.id === watch.projectId) ?? null : null
  const cwd = project?.path ?? os.homedir()
  const session = await rt.store.sessions.create({
    id: randomUUID(),
    title: `Watch · ${watch.title}`,
    cwd,
    kind: 'watch-run',
    watchId: watch.id,
  })
  rt.rows.set(session.id, session)
  log('info', 'watch', `run started: ${watch.title}`, { watchId: watch.id, runId: session.id, connectors: watch.connectors, project: project?.name, model: watch.model, cursor: watch.cursor, workspace: rt.meta.id })

  let seq = 0
  const emit = (event: SessionEvent, persist = true) => {
    if (persist) {
      seq += 1
      rt.store.events.append(session.id, seq, event).catch(() => {})
    }
    broadcast(rt, { type: 'session_event', sessionId: session.id, event })
  }

  let matches = 0
  let tokens = 0
  let costUsd: number | undefined
  let status: WatchRunStatus = 'failed'
  let error: string | undefined
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), WATCH_TIMEOUT_MS)
  const scanMcp = makeScanMcp(rt, watch, session.id, () => {
    matches += 1
  })

  try {
    const q = query({
      prompt: composeRunPrompt({
        instruction: watch.instruction,
        connectors: watch.connectors,
        cursor: watch.cursor,
        scope: watch.scope,
        project: project ? { name: project.name, path: project.path } : null,
        output: watch.output,
      }),
      options: {
        cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user'],
        allowedTools: runAllowedTools(watch.connectors, project !== null, watch.output),
        // The watch's own model when it pinned one; otherwise Claude Code's default.
        ...(watch.model ? { model: watch.model } : {}),
        mcpServers: { triage: scanMcp },
        abortController: abort,
        ...(rt.env ? { env: rt.env } : {}),
      },
    })
    let sawResult = false
    let resultText = ''
    for await (const msg of q) {
      const m = msg as unknown as SdkMessage & { result?: string; usage?: Record<string, unknown>; total_cost_usd?: unknown }
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
        session.sdkSessionId = m.session_id
        rt.store.sessions.setSdkSessionId(session.id, m.session_id).catch(() => {})
      }
      emit({ kind: 'sdk', message: m as SdkMessage }, m.type !== 'stream_event')
      if (m.type === 'result') {
        sawResult = true
        resultText = typeof m.result === 'string' ? m.result : ''
        tokens = sumTokens(m.usage)
        if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd
      }
    }
    if (resultText.includes('no-connector-tools') || resultText.includes('no-slack-tools')) {
      throw new Error(`no connector tools — connect ${watch.connectors.join(', ')} for Claude at claude.ai/settings/connectors`)
    }
    if (!sawResult) throw new Error('scan ended without a result')
    status = 'ok'
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    emit({ kind: 'error', message: error })
  } finally {
    clearTimeout(timer)
    await rt.store.watches.recordRun(watch.id, {
      // cursor advances ONLY on success — a failed/timed-out run must not skip its window
      ...(status === 'ok' ? { cursor: startedIso } : {}),
      lastRunAt: Date.now(),
      lastRunTokens: tokens,
      lastRunMatches: matches,
      status,
      sessionId: session.id,
      error,
    })
    // the run's own receipt, on its session row — powers the Activity view
    session.runStatus = status
    session.runMatches = matches
    session.runTokens = tokens
    session.runCostUsd = costUsd
    session.runError = error
    session.updatedAt = Date.now()
    await rt.store.sessions.recordWatchRun(session.id, { status, matches, tokens, costUsd, error })
    log(
      status === 'ok' ? 'info' : 'error',
      'watch',
      `run ${status}: ${watch.title}${status === 'ok' ? ` — ${matches} filed, ${Math.round(tokens / 1000)}k tok${costUsd != null ? `, $${costUsd.toFixed(2)}` : ''}` : ''}${error ? ` — ${error}` : ''}`,
      { watchId: watch.id, runId: session.id, status, matches, tokens, durationMs: Date.now() - startedMs, workspace: rt.meta.id, ...(error ? { error } : {}) },
    )
    if (status === 'ok') {
      rt.inboxCache = null
      void syncInbox(rt)
    }
    broadcastSessionList(rt)
  }
}

/**
 * Pre-installed watch templates (.docs/watches-v2.md): the old built-in Slack
 * rules, shipped as data and seeded as editable copies on first run. A user can
 * disable, edit, or duplicate them; a `templateId` marks the origin.
 */
const WATCH_TEMPLATES: Array<
  Pick<Watch, 'title' | 'instruction' | 'schedule' | 'cadence' | 'createsItems' | 'connectors'> & { templateId: string }
> = [
  {
    templateId: 'unread-dms',
    title: 'Unread DMs',
    connectors: ['slack'],
    instruction: 'Look through my unread Slack direct messages. File each unanswered one that asks something of me.',
    schedule: '0 * * * *',
    cadence: 'hourly',
    createsItems: true,
  },
  {
    templateId: 'mentions',
    title: 'Mentions',
    connectors: ['slack'],
    instruction: 'Find Slack messages where I am mentioned or tagged and my reply is still awaited. File each one.',
    schedule: '0 * * * *',
    cadence: 'hourly',
    createsItems: true,
  },
]

/**
 * Install any built-in template the user has never been offered — tracked per
 * template id, not by a single "seeded" flag. So the built-ins appear even when
 * the user already has custom watches (the old "seed only if empty" rule left
 * DBs that predated seeding with no built-ins at all), a template already
 * present is never duplicated, and one the user deleted is never re-added.
 * Per-workspace: each workspace's config table tracks its own seeding.
 */
async function seedWatchTemplates(rt: WorkspaceRuntime): Promise<void> {
  // The key used to hold a boolean; it now holds the list of seeded template ids.
  // A legacy boolean coerces to "none seeded yet" so the built-ins get installed.
  const raw = await rt.store.config.get<unknown>(WATCHES_SEEDED_KEY)
  const seeded = new Set<string>(Array.isArray(raw) ? (raw as string[]) : [])
  const watches = await rt.store.watches.list()
  const now = Date.now()
  for (const t of WATCH_TEMPLATES) {
    if (seeded.has(t.templateId)) continue
    // Already present (e.g. seeded by the older flag-based path)? Record, don't duplicate.
    if (!watches.some((w) => w.templateId === t.templateId)) {
      await rt.store.watches.create({
        id: randomUUID(),
        source: 'slack',
        title: t.title,
        scope: '',
        connectors: t.connectors,
        output: 'items',
        instruction: t.instruction,
        schedule: t.schedule,
        cadence: t.cadence,
        createsItems: t.createsItems,
        enabled: true,
        templateId: t.templateId,
        createdAt: now,
        updatedAt: now,
      })
    }
    seeded.add(t.templateId)
  }
  await rt.store.config.set(WATCHES_SEEDED_KEY, [...seeded])
}

// The minute tick (.docs/watches.md): due watches run, elapsed snoozes wake — in
// every workspace. No cron — the server is the long-running process; missed
// runs are simply due on the first tick after wake.
setInterval(() => {
  lastSchedulerTickAt = Date.now()
  for (const rt of runtimes.values()) {
    runDueWatches(rt).catch((err) => log('error', 'scheduler', `tick failed: ${err}`, { workspace: rt.meta.id }))
    rt.store.items
      .wakeSnoozed(Date.now())
      .then((woken) => {
        if (woken.length > 0) {
          rt.inboxCache = null
          log('info', 'scheduler', `woke ${woken.length} snoozed item(s)`, { ids: woken, workspace: rt.meta.id })
        }
      })
      .catch((err) => log('error', 'scheduler', `snooze wake failed: ${err}`, { workspace: rt.meta.id }))
  }
}, SCHEDULER_TICK_MS).unref()

// The repo picker's "available" list; slow-ish (paginated), so cached.
async function affiliatedRepos(rt: WorkspaceRuntime): Promise<string[]> {
  if (rt.affiliatedCache && Date.now() - rt.affiliatedCache.at < 10 * 60_000) return rt.affiliatedCache.repos
  const repos = await listAffiliatedRepos()
  rt.affiliatedCache = { at: Date.now(), repos }
  return repos
}

async function getInbox(rt: WorkspaceRuntime, force: boolean): Promise<InboxSnapshot> {
  if (!force && rt.inboxCache && Date.now() - rt.inboxCache.syncedAt < INBOX_TTL_MS) return rt.inboxCache
  return syncInbox(rt)
}

// Keep the caches warm while the server runs, so page loads are instant. A
// failed background sync keeps the previous snapshot; the next view retries.
setInterval(() => {
  for (const rt of runtimes.values()) {
    syncInbox(rt).catch((err) => log('error', 'inbox', `background sync failed: ${err}`, { workspace: rt.meta.id }))
  }
}, INBOX_KEEP_WARM_MS).unref()

// ---------------------------------------------------------------------------
// Connectors: what a session will actually load, learned the honest way — by
// spawning a throwaway query with the SAME options real sessions use and
// asking it via the mcpServerStatus() control request (no user message, no
// API turn). `claude mcp list` has no machine output, and the config files
// under ~/.claude are private formats; this is the SDK's own structured
// answer to "which servers connected". Per-workspace: two auth backends
// genuinely have different connectors, so each runtime probes with its own env.
// ---------------------------------------------------------------------------
const CLAUDE_AI_PREFIX = 'claude.ai '

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

function probeConnectors(rt: WorkspaceRuntime): Promise<ConnectorProbe> {
  // Concurrent requests share one probe — a probe is a whole subprocess.
  if (rt.connectorInFlight) return rt.connectorInFlight
  rt.connectorInFlight = (async () => {
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: input,
      options: {
        cwd: os.homedir(), // user-level view; no project .mcp.json in the way
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        ...(rt.env ? { env: rt.env } : {}),
      },
    })
    try {
      // Servers connect asynchronously; poll until none are pending (or the
      // budget runs out and we report the stragglers as they are).
      const deadline = Date.now() + 45_000
      let statuses = await q.mcpServerStatus()
      while (statuses.some((srv) => srv.status === 'pending') && Date.now() < deadline) {
        await sleep(1_000)
        statuses = await q.mcpServerStatus()
      }
      const connectors = statuses
        .map((srv): Connector =>
          srv.name.startsWith(CLAUDE_AI_PREFIX)
            ? { name: srv.name.slice(CLAUDE_AI_PREFIX.length), status: srv.status, source: 'claude.ai' }
            : { name: srv.name, status: srv.status, source: 'local' },
        )
        .sort((a, b) => a.name.localeCompare(b.name))
      rt.connectorCache = { probedAt: Date.now(), connectors }
      log('info', 'connectors', `probed: ${connectors.length} server(s), ${connectors.filter((c) => c.status === 'connected').length} connected`, { workspace: rt.meta.id })
      return rt.connectorCache
    } finally {
      input.close()
      void q.return(undefined).catch(() => {}) // dispose the subprocess
      rt.connectorInFlight = null
    }
  })()
  return rt.connectorInFlight
}

// ---------------------------------------------------------------------------
// Models: which models this workspace's Claude Code will actually run. Asked of
// the SDK (supportedModels()) rather than hardcoded — the catalog moves, an
// org policy can shrink it, and an api-key workspace may see a different list
// than a subscription one. Same throwaway-subprocess shape as the connector
// probe, and the answer is stable enough to cache for the process.
// ---------------------------------------------------------------------------
function probeModels(rt: WorkspaceRuntime): Promise<ModelProbe> {
  if (rt.modelInFlight) return rt.modelInFlight
  rt.modelInFlight = (async () => {
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: input,
      options: {
        cwd: os.homedir(),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        ...(rt.env ? { env: rt.env } : {}),
      },
    })
    try {
      const models = (await q.supportedModels()).map(
        (m): ModelOption => ({
          id: m.value,
          resolvedModel: m.resolvedModel,
          name: m.displayName,
          description: m.description,
          efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
          supportsFastMode: m.supportsFastMode,
        }),
      )
      rt.modelCache = { probedAt: Date.now(), models }
      log('info', 'models', `probed: ${models.length} model(s) available`, { workspace: rt.meta.id })
      return rt.modelCache
    } finally {
      input.close()
      void q.return(undefined).catch(() => {}) // dispose the subprocess
      rt.modelInFlight = null
    }
  })()
  return rt.modelInFlight
}

// ---------------------------------------------------------------------------
// Slash commands: what `/` offers in the composer. Asked of the SDK
// (supportedCommands()) like the model catalog, but keyed by *folder* rather
// than by workspace — a project's .claude/commands, .claude/skills and its
// plugins' skills only exist under that project.
//
// Two fill paths, and the cheap one covers the common case: a live session's
// subprocess already knows the list, so it hands it over at init for free and
// pushes a fresh one when skills are discovered mid-run. Only a draft tab —
// which has no subprocess yet — pays for a throwaway probe, and only on the
// first `/` typed against that folder.
// ---------------------------------------------------------------------------

/**
 * Commands whose UX is bound to a real terminal. The SDK tags these per
 * session (`terminal_slash_commands` on the init message) and tells remote
 * hosts to hide them — but the tag rides the message stream, so a probe with
 * no turn never sees it. Until this workspace has run one session, this list
 * stands in; the first init replaces it wholesale rather than merging, so a
 * stale guess here can only ever be wrong until a session starts.
 */
const TERMINAL_ONLY_FALLBACK = [
  'exit',
  'quit',
  'statusline',
  'vim',
  'ide',
  'terminal-setup',
  'install-github-app',
  'upgrade',
  'login',
  'logout',
]

/** The SDK's command shape is our wire shape; drop the empty optional. */
const toCommandInfo = (c: {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
}): SlashCommandInfo => ({
  name: c.name,
  description: c.description,
  argumentHint: c.argumentHint,
  ...(c.aliases?.length ? { aliases: c.aliases } : {}),
})

/** Hide what a browser can't drive, and give the picker a stable order. */
function usableCommands(rt: WorkspaceRuntime, commands: SlashCommandInfo[]): SlashCommandInfo[] {
  const hidden = new Set(rt.terminalCommands ?? TERMINAL_ONLY_FALLBACK)
  return commands.filter((c) => !hidden.has(c.name)).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Record what a subprocess reported for a folder and tell every composer
 * pointed at it. Replace, never merge: the SDK's `commands_changed` contract
 * is that the payload is the whole truth, and a command can be deleted.
 */
function noteCommands(rt: WorkspaceRuntime, cwd: string, commands: SlashCommandInfo[]): CommandProbe {
  // Keyed by the resolved folder, so a session's absolute cwd and a draft
  // tab's `~/Code/thing` are one entry rather than two.
  const key = expandHome(cwd)
  // The cache holds the subprocess's answer verbatim and `usableCommands`
  // runs on the way out, so the terminal set learned by a session starting
  // later still applies to a folder probed before it.
  const probe: CommandProbe = { probedAt: Date.now(), commands }
  rt.commandCache.set(key, probe)
  broadcast(rt, { type: 'commands_changed', cwd: key, commands: usableCommands(rt, commands) })
  return probe
}

/**
 * The list for a folder with no live session — one throwaway subprocess, the
 * same shape as the model probe, cached for the life of the process. Shared
 * per folder while in flight so a fast typist can't spawn two.
 */
function probeCommands(rt: WorkspaceRuntime, cwd: string): Promise<CommandProbe> {
  const running = rt.commandInFlight.get(cwd)  // callers pass the resolved folder
  if (running) return running
  const job = (async () => {
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: input,
      options: {
        cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        // The same sources a real session gets, or the probe would miss
        // exactly the project-local commands it is being asked about.
        settingSources: ['user', 'project', 'local'],
        ...(rt.env ? { env: rt.env } : {}),
      },
    })
    try {
      const probe = noteCommands(rt, cwd, (await q.supportedCommands()).map(toCommandInfo))
      log('info', 'commands', `probed ${probe.commands.length} command(s)`, { workspace: rt.meta.id })
      return probe
    } finally {
      input.close()
      void q.return(undefined).catch(() => {}) // dispose the subprocess
      rt.commandInFlight.delete(cwd)
    }
  })()
  rt.commandInFlight.set(cwd, job)
  return job
}

/**
 * A REAL auth check: one trivial headless turn with the workspace's env. The
 * model catalog (supportedModels) is static and "succeeds" on a bogus key, so
 * the verify step must actually reach the API to prove a key or login works.
 * Costs one minimal turn; only run for api-key / config-dir on explicit verify.
 */
async function probeAuth(rt: WorkspaceRuntime): Promise<{ ok: boolean; error?: string }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 90_000)
  try {
    const q = query({
      prompt: 'Reply with exactly: OK',
      options: {
        cwd: os.homedir(),
        maxTurns: 1,
        settingSources: [],
        allowedTools: [],
        abortController: abort,
        ...(rt.env ? { env: rt.env } : {}),
      },
    })
    for await (const msg of q) {
      const m = msg as unknown as SdkMessage & { subtype?: string; result?: string }
      if (m.type === 'result') {
        if (m.subtype === 'success') return { ok: true }
        return { ok: false, error: typeof m.result === 'string' && m.result ? m.result : `auth check failed (${m.subtype})` }
      }
    }
    return { ok: false, error: 'auth check ended without a result' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Workspace management — registry CRUD + the live runtime bookkeeping. Auth is
// spawn-time: changing a workspace's backend stops its live subprocesses (the
// next message revives them with the new env) and re-probes.
// ---------------------------------------------------------------------------
function wireWorkspace(meta: WorkspaceMeta): Workspace {
  return {
    id: meta.id,
    name: meta.name,
    color: meta.color,
    ...(meta.description ? { description: meta.description } : {}),
    authBackend: meta.authBackend,
    isDefault: meta.id === registry.defaultId,
    createdAt: meta.createdAt,
    ...(meta.authBackend === 'api-key' ? { apiKeyHint: apiKeyHint(meta.id) } : {}),
    ...(meta.authBackend === 'config-dir'
      ? { configDir: workspaceClaudeDir(meta.id), loginCommand: loginCommandFor(meta.id) }
      : {}),
  }
}

const wireWorkspaces = (): Workspace[] => registry.workspaces.map(wireWorkspace)

/**
 * "Which workspace am I bound to?" — the current workspace a caller resolved to
 * (chat via cookie/param, external shim via TRIAGE_WORKSPACE) plus the roster of
 * all workspaces so the caller can see what else exists and how to switch. The
 * one answer both the in-process tool and the stdio shim's get_workspace return.
 */
function workspaceInfo(rt: WorkspaceRuntime) {
  return {
    current: wireWorkspace(rt.meta),
    workspaces: registry.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      isDefault: w.id === registry.defaultId,
    })),
  }
}

/** Bring a runtime up: sessions, seeds, cached snapshot, background probes. */
async function initRuntime(rt: WorkspaceRuntime): Promise<void> {
  await loadSessions(rt)
  // Watches are off by default in 0.7 (.docs/next-version.md); seeding follows the switch.
  if (await watchesEnabled(rt)) await seedWatchTemplates(rt)
  await bootBriefs(rt)
  rt.inboxCache = await rt.store.inbox.load()
  probeConnectors(rt).catch((err) => log('error', 'connectors', `probe failed: ${err}`, { workspace: rt.meta.id }))
  probeModels(rt).catch((err) => log('error', 'models', `probe failed: ${err}`, { workspace: rt.meta.id }))
}

/** After an auth change: new env, fresh probes, and no subprocess on the old auth. */
function applyAuthChange(rt: WorkspaceRuntime): void {
  rt.refreshEnv()
  for (const s of rt.live.values()) s.stop() // next message revives with the new env
  rt.connectorCache = null
  rt.modelCache = null
  probeConnectors(rt).catch(() => {})
  probeModels(rt).catch(() => {})
  log('info', 'workspaces', `auth backend now ${rt.meta.authBackend}`, { workspace: rt.meta.id })
}

type WorkspacePatch = {
  name?: string
  color?: string
  description?: string
  authBackend?: 'inherit' | 'api-key' | 'config-dir'
  apiKey?: string
}

function workspacePatchFrom(raw: unknown): { patch: WorkspacePatch } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  const patch: WorkspacePatch = {}
  if (r.name !== undefined) {
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'name must be a non-empty string' }
    patch.name = r.name.trim()
  }
  if (r.color !== undefined) {
    if (typeof r.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(r.color)) return { error: 'color must be a hex color like "#7aa2f7"' }
    patch.color = r.color
  }
  if (r.description !== undefined) {
    if (typeof r.description !== 'string') return { error: 'description must be a string' }
    patch.description = r.description.trim()
  }
  if (r.authBackend !== undefined) {
    const backend = toAuthBackend(r.authBackend)
    if (!backend) return { error: 'authBackend must be inherit | api-key | config-dir' }
    patch.authBackend = backend
  }
  if (r.apiKey !== undefined) {
    if (typeof r.apiKey !== 'string' || !r.apiKey.trim()) return { error: 'apiKey must be a non-empty string' }
    patch.apiKey = r.apiKey.trim()
  }
  return { patch }
}

// ---------------------------------------------------------------------------
// HTTP: JSON API + the built SPA
// ---------------------------------------------------------------------------
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

/**
 * A form's worth of JSON. Routes that carry base64 screenshots pass a bigger
 * `limit` — a single macOS screenshot blows past 1MB once base64'd, and a
 * body that dies mid-upload reads to the user as "the network broke".
 */
function readJsonBody(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Which workspace a request belongs to: the ?workspace= param wins (explicit —
 * the MCP shim and scripts use it), then the triage_ws cookie (how the SPA
 * rides: cookies travel on every fetch and on the WS upgrade with zero
 * call-site churn), then the default. A stale id falls back to the default
 * rather than erroring — a deleted workspace must not brick the UI.
 */
function cookieWorkspace(req: http.IncomingMessage): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === 'triage_ws') return decodeURIComponent(v.join('='))
  }
  return undefined
}

function resolveRuntime(req: http.IncomingMessage, url: URL): WorkspaceRuntime {
  const qid = url.searchParams.get('workspace')
  if (qid) {
    const rt = runtimes.get(qid)
    if (rt) return rt
  }
  const cid = cookieWorkspace(req)
  if (cid) {
    const rt = runtimes.get(cid)
    if (rt) return rt
  }
  return defaultRuntime()
}

// ---------------------------------------------------------------------------
// Input validation — the HTTP surface is untrusted (vision principle 6):
// bodies are validated into domain shapes, and rejected rather than repaired.
// ---------------------------------------------------------------------------

const CADENCES = new Set<WatchCadence>(['hourly', 'daily', 'weekly'])
const ITEM_STATUSES = new Set<ItemStatus>(['open', 'done', 'snoozed', 'archived'])
const VALID_KINDS = new Set(Object.keys(BASE))
const VALID_SOURCES = new Set(['github', 'slack', 'linear', 'web'])
// upsert accepts only scanner sources; state/resolve accept manual items too.
const ITEM_ID_RE = /^(github|slack|linear|web):\S+$/
const ANY_ITEM_ID_RE = /^(github|slack|linear|web|manual):\S+$/
/** Item saves carry images inline: the per-image cap, base64-inflated, times the per-item cap. */
const MAX_ITEM_BODY_BYTES = Math.ceil(MAX_IMAGES_PER_ITEM * MAX_IMAGE_BYTES * 1.4) + 100_000

type WatchPatch = Partial<NewWatch> & { enabled?: boolean }

function watchPatchFrom(raw: unknown): { patch: WatchPatch } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  const patch: WatchPatch = {}
  if (r.title !== undefined) {
    if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'title must be a non-empty string' }
    patch.title = r.title.trim()
  }
  if (r.scope !== undefined) {
    // legacy place hint; empty clears it
    if (typeof r.scope !== 'string' || (r.scope.trim() && !/^[#@]\S+$/.test(r.scope.trim()))) return { error: 'scope must be "#channel", "@dm", or empty' }
    patch.scope = r.scope.trim()
  }
  if (r.connectors !== undefined) {
    if (!Array.isArray(r.connectors) || r.connectors.length === 0 || !r.connectors.every((c) => WATCH_CONNECTORS.includes(c as WatchConnector))) {
      return { error: `connectors must be a non-empty list of: ${WATCH_CONNECTORS.join(', ')}` }
    }
    patch.connectors = [...new Set(r.connectors as WatchConnector[])]
  }
  if (r.projectId !== undefined) {
    if (r.projectId !== null && typeof r.projectId !== 'string') return { error: 'projectId must be a string or null' }
    patch.projectId = r.projectId ? r.projectId : undefined
  }
  if (r.output !== undefined) {
    if (!WATCH_OUTPUTS.includes(r.output as WatchOutput)) return { error: `output must be one of: ${WATCH_OUTPUTS.join(', ')}` }
    patch.output = r.output as WatchOutput
  }
  if (r.model !== undefined) {
    // an alias or wire id as the model picker reports it; null/empty = default
    if (r.model !== null && (typeof r.model !== 'string' || r.model.length > 120)) return { error: 'model must be a string or null' }
    patch.model = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : undefined
  }
  if (r.instruction !== undefined) {
    if (typeof r.instruction !== 'string' || !r.instruction.trim()) return { error: 'instruction must be a non-empty string' }
    patch.instruction = r.instruction.trim()
  }
  if (r.cadence !== undefined) {
    if (!CADENCES.has(r.cadence as WatchCadence)) return { error: 'cadence must be hourly | daily | weekly' }
    patch.cadence = r.cadence as WatchCadence
  }
  if (r.schedule !== undefined) {
    if (typeof r.schedule !== 'string' || !isValidCron(r.schedule)) {
      return { error: 'schedule must be a valid 5-field cron expression, e.g. "0 9 * * *"' }
    }
    patch.schedule = r.schedule.trim()
  }
  if (r.windowStart !== undefined && r.windowStart !== null) {
    if (typeof r.windowStart !== 'string' || !/^\d{1,2}:\d{2}$/.test(r.windowStart)) return { error: 'windowStart must be "HH:MM"' }
    patch.windowStart = r.windowStart
  }
  if (r.windowDay !== undefined && r.windowDay !== null) {
    if (typeof r.windowDay !== 'number' || !Number.isInteger(r.windowDay) || r.windowDay < 0 || r.windowDay > 6) return { error: 'windowDay must be 0-6' }
    patch.windowDay = r.windowDay
  }
  if (r.createsItems !== undefined) {
    if (typeof r.createsItems !== 'boolean') return { error: 'createsItems must be a boolean' }
    patch.createsItems = r.createsItems
  }
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== 'boolean') return { error: 'enabled must be a boolean' }
    patch.enabled = r.enabled
  }
  return { patch }
}

/** A full ingested WorkItem, validated field by field. Rejects, never repairs. */
function workItemFrom(raw: unknown): { item: WorkItem } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ITEM_ID_RE.test(r.id)) return { error: 'id must look like "slack:...", "github:owner/repo#123", or "linear:KEY-123"' }
  const source = r.id.slice(0, r.id.indexOf(':'))
  if (r.source !== undefined && r.source !== source) return { error: `source must match the id prefix ("${source}")` }
  if (!VALID_SOURCES.has(source)) return { error: 'unknown source' }
  if (typeof r.kind !== 'string' || !VALID_KINDS.has(r.kind)) return { error: `kind must be one of: ${[...VALID_KINDS].join(', ')}` }
  if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'title must be a non-empty string' }
  if (typeof r.url !== 'string' || !r.url.startsWith('http')) return { error: 'url must be an http(s) URL' }
  if (typeof r.updatedAt !== 'string' || !Number.isFinite(Date.parse(r.updatedAt))) return { error: 'updatedAt must be an ISO 8601 timestamp' }
  const createdAt = typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) ? r.createdAt : r.updatedAt
  return {
    item: {
      id: r.id,
      source: source as WorkItem['source'],
      kind: r.kind as WorkItem['kind'],
      title: r.title.trim(),
      url: r.url,
      repo: typeof r.repo === 'string' ? r.repo : '',
      author: typeof r.author === 'string' ? r.author : '',
      peopleWaiting: typeof r.peopleWaiting === 'number' && r.peopleWaiting >= 0 ? Math.floor(r.peopleWaiting) : 0,
      createdAt,
      updatedAt: r.updatedAt,
      ...(typeof r.watchId === 'string' ? { watchId: r.watchId } : {}),
      ...(typeof r.why === 'string' && r.why ? { why: r.why } : {}),
      ...(canonicalizeRefs(r.refs) ? { refs: canonicalizeRefs(r.refs) } : {}),
    },
  }
}

/**
 * A manual to-do's fields, validated. Project (if given) must exist; url (if
 * given) must be http(s); priority (if given) is 1–4. Title is required on
 * create; with `{ partial: true }` (an edit) only the fields present are
 * validated and returned, so a caller can patch one field without resending
 * the rest.
 */
async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown): Promise<ManualItemInput>
async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown, opts: { partial: true }): Promise<Partial<ManualItemInput>>
async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown, opts: { partial?: boolean } = {}): Promise<Partial<ManualItemInput>> {
  if (typeof raw !== 'object' || raw === null) throw new Error('body must be a JSON object')
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title && !opts.partial) throw new Error('a work item needs a title')
  const input: Partial<ManualItemInput> = {}
  if (title) input.title = title
  if (typeof r.projectId === 'string' && r.projectId) {
    const projects = await rt.store.projects.list()
    if (!projects.some((p) => p.id === r.projectId)) throw new Error('unknown project')
    input.projectId = r.projectId
  }
  // `description` is the 0.7 name; `note` is accepted as the old one for one release.
  const desc = typeof r.description === 'string' ? r.description : typeof r.note === 'string' ? r.note : undefined
  if (desc !== undefined && desc.trim()) input.description = desc.trim()
  if (typeof r.url === 'string' && r.url.trim()) {
    if (!/^https?:\/\//.test(r.url.trim())) throw new Error('link must be an http(s) URL')
    input.url = r.url.trim()
  }
  // When the key is present, 0/null means "none" (0) so an edit can clear it;
  // when absent, priority is left untouched on update.
  if ('priority' in r) {
    const p = r.priority
    if (p === null || p === 0) input.priority = 0
    else if (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 4) input.priority = p
    else throw new Error('priority must be 1–4')
  }
  const images = itemImageEdits(r)
  if (images) input.images = images
  return input
}

/**
 * The `images` field of an item save: `{ id }` keeps an image the item already
 * holds, anything else is a new base64 upload, judged by the same rules as a
 * chat attachment. The list is the complete desired set — absent leaves the
 * item's images alone, `[]` drops them all. Unlike the socket's
 * `imageAttachments`, a bad entry is *refused*, not dropped: this is a form,
 * and a screenshot that silently vanishes on save is worse than an error.
 */
function itemImageEdits(raw: Record<string, unknown>): ItemImageEdit[] | undefined {
  const v = raw.images
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new Error('images must be a list')
  if (v.length > MAX_IMAGES_PER_ITEM) throw new Error(`up to ${MAX_IMAGES_PER_ITEM} images per item`)
  const out: ItemImageEdit[] = []
  for (const entry of v) {
    if (typeof entry !== 'object' || entry === null) throw new Error('each image must be an object')
    const e = entry as Record<string, unknown>
    if (typeof e.id === 'string' && e.id) {
      out.push({ id: e.id })
      continue
    }
    if (!isImageMediaType(e.mediaType)) throw new Error('images must be PNG, JPEG, GIF or WebP')
    if (typeof e.data !== 'string' || !e.data || !BASE64.test(e.data)) throw new Error('image data must be base64')
    if (base64Bytes(e.data) > MAX_IMAGE_BYTES)
      throw new Error(`each image must be under ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`)
    out.push({
      mediaType: e.mediaType,
      data: e.data,
      ...(typeof e.name === 'string' && e.name ? { name: e.name.slice(0, 200) } : {}),
    })
  }
  return out
}

/**
 * Write the item's new image set to disk and record the refs. Works for any
 * item, not just manual ones — a screenshot pasted onto a GitHub item's
 * description is the same thing.
 */
async function setItemImagesOp(rt: WorkspaceRuntime, id: string, edits: ItemImageEdit[]): Promise<ItemImage[]> {
  const item = await rt.store.items.get(id)
  if (!item) throw new Error('no such work item')
  const images = await applyImageEdits(rt.attachmentsDir, id, item.images ?? [], edits)
  await rt.store.items.setImages(id, images)
  rt.inboxCache = null
  return images
}

// ---------------------------------------------------------------------------
// Work-item operations — one core, three callers: the HTTP routes below, the
// in-process MCP server that web chats get (rt.triageMcp(), one per session), and the
// stdio shim (server/mcp.ts) which reaches them over HTTP. Every transport
// funnels through these functions, so list/create/edit/upsert/resolve behave
// identically no matter who calls them. Validation stays in workItemFrom/
// manualItemFrom — the single source of truth, never duplicated per transport.
// ---------------------------------------------------------------------------
async function listItemsOp(
  rt: WorkspaceRuntime,
  filter: { source?: string; kind?: string; status?: string } = {},
): Promise<InboxSnapshot['items']> {
  // 'open' is the live inbox (scanned + ranked + cached); any other status is
  // read straight from the durable store, same as the status tabs.
  const status = filter.status && filter.status !== 'open' ? filter.status : null
  if (status && !ITEM_STATUSES.has(status as ItemStatus)) throw new Error(`unknown status: ${status}`)
  let items = status ? await listItemsByStatus(rt, status as ItemStatus) : (await getInbox(rt, false)).items
  if (filter.source) items = items.filter((i) => i.source === filter.source)
  if (filter.kind) items = items.filter((i) => i.kind === filter.kind)
  return items
}

/**
 * One work item, whole. The counterpart to listItemsOp: that one answers "what
 * should I do next" and is therefore open-only and repo-scoped, this one
 * answers "tell me about this one" and filters nothing. Every neighbour it
 * returns carries an id and a title, so a reader handed an id — by a `linked`
 * sibling, by an old link, by the user — can always follow it one more hop.
 */
async function itemDetailOp(rt: WorkspaceRuntime, rawId: unknown): Promise<ItemDetail> {
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
  const item = await rt.store.items.get(id)
  if (!item) throw new Error('no such work item')

  const [all, links] = await Promise.all([rt.store.items.listAll(), rt.store.links.forTarget('item', id)])

  // Ref-siblings, transitively — the same component the inbox folds into one
  // card (core/work/link.ts), so detail and card never disagree about who is
  // related to whom. Unlike the card, this reaches items of any status.
  const byId = new Map(all.map((i) => [i.id, i]))
  const refsOf = (i: WorkItem) => [i.id, ...(i.refs ?? [])]
  const owners = new Map<string, string[]>()
  for (const i of all) {
    for (const ref of refsOf(i)) {
      const list = owners.get(ref)
      if (list) list.push(i.id)
      else owners.set(ref, [i.id])
    }
  }
  const seen = new Set([id])
  const queue = [id]
  while (queue.length) {
    const cur = byId.get(queue.shift()!)
    if (!cur) continue
    for (const ref of refsOf(cur)) {
      for (const other of owners.get(ref) ?? []) {
        if (seen.has(other)) continue
        seen.add(other)
        queue.push(other)
      }
    }
  }
  const linked = [...seen]
    .filter((sid) => sid !== id)
    .map((sid) => byId.get(sid)!)
    .map((i) => ({ id: i.id, title: i.title, source: i.source as string, url: i.url, repo: i.repo, status: i.status ?? 'open' }))

  const [artifacts, sessions] = await Promise.all([linkedArtifacts(rt, links), linkedSessions(rt, links)])

  // Ranked only when it happens to be in the cached open inbox: ranking means
  // a scan, and reading one item must never pay for one.
  const scored = rt.inboxCache?.items.find((i) => i.id === id)
  return {
    item,
    rank: scored ? { score: scored.score, group: scored.group, reason: scored.reason } : null,
    linked,
    artifacts,
    sessions,
  }
}

/** The artifacts among a set of incoming links, resolved to id/title/author/path. */
async function linkedArtifacts(rt: WorkspaceRuntime, links: Link[]): Promise<ItemDetail['artifacts']> {
  const rows = await Promise.all(
    links
      .filter((l) => l.fromKind === 'artifact')
      .map(async (l) => {
        const a = await rt.store.artifacts.get(l.fromId)
        return a ? { id: a.id, title: a.title, role: l.role, author: a.author, path: a.path } : null
      }),
  )
  return rows.filter((a): a is NonNullable<typeof a> => a !== null)
}

/** The sessions among a set of incoming links, resolved to id/title/kind. */
async function linkedSessions(rt: WorkspaceRuntime, links: Link[]): Promise<ItemDetail['sessions']> {
  const rows = await Promise.all(
    links
      .filter((l) => l.fromKind === 'session')
      .map(async (l) => {
        const row = rt.rows.get(l.fromId) ?? (await rt.store.sessions.get(l.fromId))
        return row ? { id: row.id, title: row.title, role: l.role, kind: row.kind, updatedAt: row.updatedAt } : null
      }),
  )
  return rows.filter((s): s is NonNullable<typeof s> => s !== null)
}

/**
 * What a session is allowed to know about itself. A session is spawned before
 * `create_session` links it to a work item, so its system prompt cannot name
 * the item — it can only point here (shared/triageContext.ts).
 */
async function sessionContextOp(rt: WorkspaceRuntime, rawId: unknown): Promise<SessionContext> {
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!id) throw new Error('need a session id')
  const row = rt.rows.get(id) ?? (await rt.store.sessions.get(id))
  if (!row) throw new Error('no such session')
  const [out, incoming] = await Promise.all([rt.store.links.forSource('session', id), rt.store.links.forTarget('session', id)])
  const itemLink = out.find((l) => l.toKind === 'item')
  const [item, artifacts] = await Promise.all([
    itemLink ? itemDetailOp(rt, itemLink.toId).catch(() => null) : Promise.resolve(null),
    linkedArtifacts(rt, incoming),
  ])
  return {
    workspace: { id: rt.meta.id, name: rt.meta.name, artifactsRoot: rt.artifacts.root },
    session: { id: row.id, title: row.title, kind: row.kind, cwd: row.cwd },
    item,
    artifacts,
  }
}

async function upsertItemOp(rt: WorkspaceRuntime, raw: unknown): Promise<UpsertOutcome> {
  const parsed = workItemFrom(raw)
  if ('error' in parsed) throw new Error(parsed.error)
  const { outcome } = await rt.store.items.upsert(parsed.item)
  if (outcome !== 'unchanged') rt.inboxCache = null
  return outcome
}

async function resolveItemOp(rt: WorkspaceRuntime, rawId: unknown): Promise<void> {
  const id = typeof rawId === 'string' ? rawId : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
  await rt.store.items.transition(id, { status: 'done', actor: 'agent' })
  rt.inboxCache = null
  log('info', 'inbox', `done: ${id} (by agent)`, { id, actor: 'agent', workspace: rt.meta.id })
}

async function createManualOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const { images, ...input } = await manualItemFrom(rt, raw)
  const id = `manual:${randomUUID()}`
  await rt.store.items.createManual({ id, ...input })
  // The item has to exist before its images can hang off it — the folder is
  // named after the id the line above minted.
  if (images?.length) await setItemImagesOp(rt, id, images)
  rt.inboxCache = null
  log('info', 'inbox', `manual item created: ${input.title ?? id}`, { id, workspace: rt.meta.id })
  return id
}

// Edits target manual (user-authored) items only. Scanned items are
// upsert-newer-wins, so a free-form edit would be clobbered by the next scan —
// reject those with a clear message rather than silently no-op'ing.
async function editManualOp(rt: WorkspaceRuntime, id: string, raw: unknown): Promise<void> {
  if (!id || !id.startsWith('manual:'))
    throw new Error('edit_work_item only edits manual items (id must start with "manual:")')
  const { images, ...patch } = await manualItemFrom(rt, raw, { partial: true })
  await rt.store.items.updateManual(id, patch)
  if (images) await setItemImagesOp(rt, id, images)
  rt.inboxCache = null
}

// The same tool surface every session gets in-process, matching the stdio
// shim's names/schemas one-for-one (server/mcp.ts) so a web chat and a local
// Claude Code session drive the inbox identically. Handlers call the ops above
// directly — no HTTP round-trip — against THIS workspace's store. Reads are
// auto-allowed in requestPermission; writes surface a permission prompt.
// --- artifacts + links (.docs/next-version.md, phase 1) ----------------------
//
// Same shape as the item ops: validation once, three callers (HTTP, the
// in-process MCP server, the stdio shim over HTTP). The index does the file
// work; these decide what may be written and by whom.

const HIDDEN_ITEM_STATUSES = new Set<ItemStatus>(['done', 'archived'])
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
type OkBody = { ok: true } | { ok: false; error: string }

/** Every artifact with its outgoing links; `hidden` marks the brief of a finished item. */
async function listArtifactsOp(rt: WorkspaceRuntime, all: boolean): Promise<ArtifactWithLinks[]> {
  await rt.artifacts.refresh()
  const [rows, links] = await Promise.all([rt.store.artifacts.list(), rt.store.links.list()])
  const bySource = new Map<string, Link[]>()
  for (const l of links) {
    if (l.fromKind !== 'artifact') continue
    const list = bySource.get(l.fromId) ?? []
    list.push(l)
    bySource.set(l.fromId, list)
  }
  const out: ArtifactWithLinks[] = []
  for (const a of rows) {
    const mine = bySource.get(a.id) ?? []
    let hidden = false
    for (const l of mine) {
      if (l.role !== 'brief' || l.toKind !== 'item') continue
      const item = await rt.store.items.get(l.toId).catch(() => null)
      if (item?.status && HIDDEN_ITEM_STATUSES.has(item.status)) hidden = true
    }
    if (hidden && !all) continue
    out.push({ ...a, links: mine, hidden })
  }
  return out
}

function linkTargetFrom(raw: unknown): { kind: LinkKind; id: string; role: LinkRole } {
  const l = (raw ?? {}) as Record<string, unknown>
  if (!isLinkKind(l.kind) || l.kind === 'artifact') throw new Error('link kind must be item or session')
  if (typeof l.id !== 'string' || !l.id) throw new Error('a link needs an id')
  if (!isLinkRole(l.role)) throw new Error('link role must be brief, report, context or dispatch')
  return { kind: l.kind, id: l.id, role: l.role }
}

/** Rejects, never repairs — like workItemFrom. */
function artifactInputFrom(raw: unknown, opts: { partial: boolean }): ArtifactInput {
  const r = (raw ?? {}) as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : undefined
  const body = typeof r.body === 'string' ? r.body : undefined
  if (!opts.partial && !title) throw new Error('title is required')
  if (title !== undefined && !title) throw new Error('title cannot be empty')
  if (title && title.length > 200) throw new Error('title is too long (200 characters max)')
  if (body !== undefined && body.length > 2_000_000) throw new Error('body is too large (2 MB max)')
  if (r.refs !== undefined && !Array.isArray(r.refs)) throw new Error('refs must be an array of strings')
  const refs = Array.isArray(r.refs) ? r.refs.filter((x): x is string => typeof x === 'string') : undefined
  if (r.author !== undefined && !isArtifactAuthor(r.author)) throw new Error('author must be human or model')
  if (r.links !== undefined && !Array.isArray(r.links)) throw new Error('links must be an array')
  const links = Array.isArray(r.links) ? r.links.map(linkTargetFrom) : undefined
  return {
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(refs ? { refs } : {}),
    ...(isArtifactAuthor(r.author) ? { author: r.author } : {}),
    ...(links ? { links } : {}),
  }
}

/** A link's endpoints must exist in this workspace — a dangling link is a bug, not data. */
async function assertLinkable(rt: WorkspaceRuntime, kind: LinkKind, id: string): Promise<void> {
  if (kind === 'item') {
    if (!(await rt.store.items.get(id))) throw new Error(`no work item ${id}`)
  } else if (kind === 'session') {
    if (!rt.rows.has(id)) throw new Error(`no session ${id}`)
  } else if (!(await rt.store.artifacts.get(id))) throw new Error(`no artifact ${id}`)
}

async function createArtifactOp(rt: WorkspaceRuntime, raw: unknown, defaultAuthor: ArtifactAuthor): Promise<Artifact> {
  const input = artifactInputFrom(raw, { partial: false })
  for (const l of input.links ?? []) await assertLinkable(rt, l.kind, l.id)
  const artifact = await rt.artifacts.create({
    title: input.title ?? 'Untitled',
    body: input.body ?? '',
    author: input.author ?? defaultAuthor,
    ...(input.refs ? { refs: input.refs } : {}),
  })
  for (const l of input.links ?? []) {
    await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: l.kind, toId: l.id, role: l.role })
  }
  log('info', 'artifacts', `created ${artifact.path}`, { id: artifact.id, author: artifact.author, workspace: rt.meta.id })
  return artifact
}

/**
 * Edit in place. `by` is who is asking: a human may edit anything; the model
 * may only rewrite what the model wrote — a human's note it can propose to,
 * never overwrite (.docs/next-version.md).
 */
async function updateArtifactOp(rt: WorkspaceRuntime, id: string, raw: unknown, by: ArtifactAuthor): Promise<Artifact> {
  const input = artifactInputFrom(raw, { partial: true })
  if (input.title === undefined && input.body === undefined && input.refs === undefined) throw new Error('nothing to change')
  const cur = await rt.store.artifacts.get(id)
  if (!cur) throw new Error('no such artifact')
  if (by === 'model' && cur.author !== 'model') {
    throw new Error('this artifact is human-authored — propose the change to the user instead of rewriting it')
  }
  const artifact = await rt.artifacts.update(id, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.refs !== undefined ? { refs: input.refs } : {}),
  })
  log('info', 'artifacts', `updated ${artifact.path}`, { id, by, workspace: rt.meta.id })
  return artifact
}

async function addLinkOp(rt: WorkspaceRuntime, raw: unknown): Promise<Link> {
  const l = (raw ?? {}) as Record<string, unknown>
  if (!isLinkKind(l.fromKind) || !isLinkKind(l.toKind)) throw new Error('fromKind and toKind must be artifact, item or session')
  if (typeof l.fromId !== 'string' || !l.fromId || typeof l.toId !== 'string' || !l.toId) throw new Error('need fromId and toId')
  if (!isLinkRole(l.role)) throw new Error('role must be brief, report, context or dispatch')
  await assertLinkable(rt, l.fromKind, l.fromId)
  await assertLinkable(rt, l.toKind, l.toId)
  return rt.store.links.add({ fromKind: l.fromKind, fromId: l.fromId, toKind: l.toKind, toId: l.toId, role: l.role })
}

/** Both directions, de-duplicated: everything that points at or from one entity. */
async function linksFor(rt: WorkspaceRuntime, kind: LinkKind, id: string): Promise<Link[]> {
  const [to, from] = await Promise.all([rt.store.links.forTarget(kind, id), rt.store.links.forSource(kind, id)])
  const seen = new Set<string>()
  return [...to, ...from].filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
}

/** Open a file in whatever the OS opens .md with — the server runs on the user's own machine. */
async function openInEditor(abs: string): Promise<void> {
  if (process.platform === 'darwin') await pExecFile('open', [abs])
  else if (process.platform === 'win32') await pExecFile('cmd', ['/c', 'start', '', abs])
  else await pExecFile('xdg-open', [abs])
}

// --- settings, briefs and dispatch (.docs/next-version.md, phase 2) ----------

const WATCHES_ENABLED_KEY = 'watches.enabled'
const BRIEFS_CAP_KEY = 'briefs.dailyCap'
const BRIEFS_MODEL_KEY = 'briefs.defaultModel'
const DEFAULT_BRIEF_CAP = 20
const BRIEF_TIMEOUT_MS = 300_000

/** The global watches switch. Off by default: 0.7 is pull-before-push. */
async function watchesEnabled(rt: WorkspaceRuntime): Promise<boolean> {
  return (await rt.store.config.get<boolean>(WATCHES_ENABLED_KEY)) === true
}

async function readSettings(rt: WorkspaceRuntime): Promise<WorkspaceSettings> {
  const cap = await rt.store.config.get<number>(BRIEFS_CAP_KEY)
  const model = await rt.store.config.get<string>(BRIEFS_MODEL_KEY)
  return {
    watchesEnabled: await watchesEnabled(rt),
    briefsDailyCap: typeof cap === 'number' && cap > 0 ? cap : DEFAULT_BRIEF_CAP,
    briefsDefaultModel: typeof model === 'string' && model ? model : null,
  }
}

async function writeSettings(rt: WorkspaceRuntime, raw: unknown): Promise<WorkspaceSettings> {
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.watchesEnabled !== undefined) {
    if (typeof r.watchesEnabled !== 'boolean') throw new Error('watchesEnabled must be a boolean')
    await rt.store.config.set(WATCHES_ENABLED_KEY, r.watchesEnabled)
    if (r.watchesEnabled) await seedWatchTemplates(rt)
    log('info', 'watch', `watches ${r.watchesEnabled ? 'enabled' : 'disabled'}`, { workspace: rt.meta.id })
  }
  if (r.briefsDailyCap !== undefined) {
    const n = r.briefsDailyCap
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 500) throw new Error('briefsDailyCap must be a whole number from 1 to 500')
    await rt.store.config.set(BRIEFS_CAP_KEY, n)
  }
  if (r.briefsDefaultModel !== undefined) {
    if (r.briefsDefaultModel !== null && typeof r.briefsDefaultModel !== 'string') throw new Error('briefsDefaultModel must be a string or null')
    await rt.store.config.set(BRIEFS_MODEL_KEY, r.briefsDefaultModel || null)
  }
  rt.inboxCache = null
  return readSettings(rt)
}

/** The folder an item's work lands in: its project, else the project whose repo it belongs to. */
async function projectFor(rt: WorkspaceRuntime, item: WorkItem): Promise<Project | null> {
  const projects = await rt.store.projects.list()
  return (
    (item.projectId ? projects.find((p) => p.id === item.projectId) : undefined) ??
    projects.find((p) => p.repo && p.repo === item.repo) ??
    null
  )
}

/** Record that a session works (dispatch) or documents (brief) an item; mirrored in memory for summaries. */
async function linkSessionToItem(rt: WorkspaceRuntime, sessionId: string, itemId: string, role: 'dispatch' | 'brief'): Promise<void> {
  if (!(await rt.store.items.get(itemId))) return
  await rt.store.links.add({ fromKind: 'session', fromId: sessionId, toKind: 'item', toId: itemId, role })
  rt.sessionItem.set(sessionId, itemId)
  broadcastSessionList(rt)
}

/** The artifact linked to an item as its brief, with the body on disk. */
async function currentBrief(rt: WorkspaceRuntime, itemId: string): Promise<{ artifact: Artifact; body: string } | null> {
  const links = await rt.store.links.forTarget('item', itemId)
  const l = links.find((x) => x.fromKind === 'artifact' && x.role === 'brief')
  if (!l) return null
  const a = await rt.artifacts.read(l.fromId)
  return a ? { artifact: a.artifact, body: a.body } : null
}

async function briefViewFor(rt: WorkspaceRuntime, itemId: string): Promise<BriefView> {
  const [job, item, cur, queued] = await Promise.all([
    rt.store.briefs.latestForItem(itemId),
    rt.store.items.get(itemId),
    currentBrief(rt, itemId),
    rt.store.briefs.list('queued'),
  ])
  const sourceMs = item ? Date.parse(item.updatedAt) : NaN
  // Stale is arithmetic, never a judgment: the source moved after the brief was written.
  const settled = !job || job.status === 'ready' || job.status === 'failed'
  const stale = !!cur && settled && Number.isFinite(sourceMs) && sourceMs > cur.artifact.updated
  const pos = job?.status === 'queued' ? queued.findIndex((q) => q.id === job.id) : -1
  return { job, stale, artifact: cur?.artifact ?? null, body: cur?.body ?? null, queuePosition: pos >= 0 ? pos : null }
}

const broadcastBrief = (rt: WorkspaceRuntime, job: BriefJob) => broadcast(rt, { type: 'brief_status', job })

/**
 * Spawn-time extras by session kind. Every session gets the same thing first —
 * who it is inside triage (shared/triageContext.ts): the workspace, its own
 * triage session id, the artifacts folder. That is the layer that is knowable
 * at spawn and true for the session's whole life; what *exists* right now is a
 * tool call, never a prompt. Brief sessions get the headless contract and their
 * write tool on top.
 */
function extrasFor(rt: WorkspaceRuntime, row: StoredSession): SessionExtras {
  const identity = triageSessionAppend(row.kind, {
    sessionId: row.id,
    workspaceId: rt.meta.id,
    workspaceName: rt.meta.name,
    artifactsRoot: rt.artifacts.root,
  })
  if (row.kind !== 'brief') return { systemAppend: identity }
  let e = rt.briefExtras.get(row.id)
  if (!e) {
    // Identity first: the headless contract's "change nothing" must be the last
    // word a brief run reads, not something the identity block then softens.
    e = { systemAppend: `${identity}\n${BRIEF_SYSTEM_APPEND}` }
    rt.briefExtras.set(row.id, e)
  }
  // The server is rebuilt per spawn, never cached: one instance connects to one
  // transport, so a revived run handed the old object would lose write_brief.
  return { ...e, mcp: { brief: makeBriefMcp(rt, row.id) } }
}

/**
 * The brief session's one write: the server picks the file (one per item),
 * writes the frontmatter, commits, links it as the item's brief. Looks the
 * job up by session at call time, so the same server serves every run and
 * iteration in that session.
 */
function makeBriefMcp(rt: WorkspaceRuntime, sessionId: string) {
  return createSdkMcpServer({
    name: 'brief',
    version: VERSION,
    tools: [
      tool(
        'write_brief',
        'Save the brief for this work item. Call exactly once, with the WHOLE document (it replaces any previous brief). The server chooses the file and links it to the item.',
        {
          title: z.string().describe('a short title — the verdict or the one-line summary'),
          body: z.string().describe('the full markdown body'),
          refs: z.array(z.string()).optional().describe('PR/issue URLs or Linear keys the brief cites'),
        },
        async (args) => {
          try {
            const job = await rt.store.briefs.forSession(sessionId)
            if (!job || job.status !== 'running') return errResult('no brief run is active in this session')
            const item = await rt.store.items.get(job.itemId)
            if (!item) return errResult('the work item no longer exists')
            const refs = [...(item.refs ?? []), ...(args.refs ?? [])]
            const artifact = await rt.artifacts.writeAt(briefRelPath(item.id), {
              title: args.title.trim() || item.title,
              body: args.body,
              author: 'model',
              ...(refs.length ? { refs } : {}),
            })
            await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'item', toId: item.id, role: 'brief' })
            await rt.store.briefs.update(job.id, { artifactId: artifact.id })
            rt.briefWrote.add(job.id)
            log('info', 'briefs', `brief written: ${item.title}`, { jobId: job.id, itemId: item.id, artifactId: artifact.id, workspace: rt.meta.id })
            return okResult(`ok: brief saved to ${artifact.path}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
    ],
  })
}

/** Queue briefs for items. An item already queued or running keeps its job; a ready one continues its session. */
async function enqueueBriefsOp(rt: WorkspaceRuntime, raw: unknown): Promise<BriefJob[]> {
  const r = (raw ?? {}) as Record<string, unknown>
  const ids = Array.isArray(r.itemIds) ? r.itemIds.filter((x): x is string => typeof x === 'string' && ANY_ITEM_ID_RE.test(x)) : []
  if (!ids.length) throw new Error('need itemIds')
  if (ids.length > 50) throw new Error('at most 50 items at once')
  const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : null
  const model = typeof r.model === 'string' && r.model ? r.model : null
  if (r.playbook !== undefined && !isPlaybookName(r.playbook)) throw new Error('playbook must be a kind name')
  const jobs: BriefJob[] = []
  for (const id of ids) {
    const item = await rt.store.items.get(id)
    if (!item) throw new Error(`no work item ${id}`)
    const latest = await rt.store.briefs.latestForItem(id)
    if (latest && (latest.status === 'queued' || latest.status === 'running')) {
      jobs.push(latest)
      continue
    }
    const job = await rt.store.briefs.create({ id: randomUUID(), itemId: id, playbook: (r.playbook as string | undefined) ?? item.kind, model, note })
    // A re-brief of a finished brief continues the session that wrote it — it already knows the item.
    if (latest?.status === 'ready' && latest.sessionId && rt.rows.has(latest.sessionId)) {
      await rt.store.briefs.update(job.id, { sessionId: latest.sessionId })
      job.sessionId = latest.sessionId
    }
    jobs.push(job)
    broadcastBrief(rt, job)
    log('info', 'briefs', `queued: ${item.title}`, { jobId: job.id, itemId: id, workspace: rt.meta.id })
  }
  pumpBriefQueue(rt)
  return jobs
}

/** "You missed X": a new job in the same session, carrying the feedback as its note. */
async function iterateBriefOp(rt: WorkspaceRuntime, raw: unknown): Promise<BriefJob> {
  const r = (raw ?? {}) as Record<string, unknown>
  const itemId = typeof r.itemId === 'string' ? r.itemId : ''
  const text = typeof r.text === 'string' ? r.text.trim() : ''
  if (!ANY_ITEM_ID_RE.test(itemId)) throw new Error('need an itemId')
  if (!text) throw new Error('say what to change')
  const latest = await rt.store.briefs.latestForItem(itemId)
  if (!latest || (latest.status !== 'ready' && latest.status !== 'failed')) throw new Error('no finished brief to iterate on yet')
  const job = await rt.store.briefs.create({ id: randomUUID(), itemId, playbook: latest.playbook, model: latest.model, note: text })
  if (latest.sessionId && rt.rows.has(latest.sessionId)) {
    await rt.store.briefs.update(job.id, { sessionId: latest.sessionId })
    job.sessionId = latest.sessionId
  }
  broadcastBrief(rt, job)
  pumpBriefQueue(rt)
  return job
}

function pumpBriefQueue(rt: WorkspaceRuntime): void {
  if (rt.briefActive || rt.briefPumping) return
  rt.briefPumping = true
  void (async () => {
    const [next] = await rt.store.briefs.list('queued')
    if (!next) return
    rt.briefActive = next.id
    try {
      await startBriefRun(rt, next)
    } catch (err) {
      await finishBrief(rt, next.id, 'failed', errText(err))
    }
  })()
    .catch((err) => log('error', 'briefs', `pump failed: ${err}`, { workspace: rt.meta.id }))
    .finally(() => {
      rt.briefPumping = false
    })
}

async function startBriefRun(rt: WorkspaceRuntime, job: BriefJob): Promise<void> {
  const settings = await readSettings(rt)
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  if ((await rt.store.briefs.countStartedSince(dayStart.getTime())) >= settings.briefsDailyCap) {
    throw new Error(`the daily cap of ${settings.briefsDailyCap} brief runs is reached — raise it in Settings → Briefs, or try tomorrow`)
  }
  const item = await rt.store.items.get(job.itemId)
  if (!item) throw new Error('the work item no longer exists')
  const playbook = await readPlaybook(rt.playbookDir, job.playbook)
  const existing = await currentBrief(rt, item.id)
  const reuse = job.sessionId ? rt.rows.get(job.sessionId) ?? null : null
  let row: StoredSession
  if (reuse) row = reuse
  else {
    const project = await projectFor(rt, item)
    row = await createSession(
      rt,
      `Brief · ${item.title.slice(0, 70)}`,
      project?.path ?? os.homedir(),
      job.model ?? settings.briefsDefaultModel,
      null,
      false,
      'gated',
      { kind: 'brief' },
    )
    await linkSessionToItem(rt, row.id, item.id, 'brief')
  }
  const startedAt = Date.now()
  await rt.store.briefs.update(job.id, { status: 'running', sessionId: row.id, startedAt, error: null })
  rt.briefWrote.delete(job.id)
  broadcastBrief(rt, { ...job, status: 'running', sessionId: row.id, startedAt, error: null })
  const live = await getOrRevive(rt, row.id)
  if (!live) throw new Error('could not start the brief session')
  rt.briefTimers.set(
    job.id,
    setTimeout(() => {
      void finishBrief(rt, job.id, 'failed', 'timed out after 5 minutes').then(() => {
        void live.interrupt()
        live.stop()
      })
    }, BRIEF_TIMEOUT_MS),
  )
  const scored = rt.inboxCache?.items.find((i) => i.id === item.id)
  const iteration = !!reuse && !!job.note && !!existing
  // Screenshots the human put on the item ride the first message as real
  // image blocks — a brief about a broken UI needs to see it.
  const images = await itemImageAttachments(rt.attachmentsDir, item.id, item.images)
  await live.sendUserMessage(
    composeBriefPrompt({
      item,
      reason: scored?.reason,
      playbookName: job.playbook,
      playbook: playbook.body,
      note: job.note,
      existing: existing?.body ?? null,
      iteration,
      imageCount: images?.length ?? 0,
    }),
    images,
  )
  log('info', 'briefs', `run started: ${item.title}${iteration ? ' (iteration)' : ''}`, {
    jobId: job.id,
    itemId: item.id,
    sessionId: row.id,
    playbook: job.playbook,
    workspace: rt.meta.id,
  })
}

async function finishBrief(rt: WorkspaceRuntime, jobId: string, status: 'ready' | 'failed', error?: string): Promise<void> {
  const job = await rt.store.briefs.get(jobId)
  const timer = rt.briefTimers.get(jobId)
  if (timer) clearTimeout(timer)
  rt.briefTimers.delete(jobId)
  rt.briefWrote.delete(jobId)
  if (job && (job.status === 'running' || job.status === 'queued')) {
    const finishedAt = Date.now()
    await rt.store.briefs.update(jobId, { status, error: error ?? null, finishedAt })
    broadcastBrief(rt, { ...job, status, error: error ?? null, finishedAt })
    // Nothing more to do in the subprocess; iteration revives it with `resume`.
    if (job.sessionId) rt.live.get(job.sessionId)?.stop()
    log(status === 'ready' ? 'info' : 'error', 'briefs', `run ${status}: ${job.itemId}${error ? ` — ${error}` : ''}`, {
      jobId,
      itemId: job.itemId,
      status,
      workspace: rt.meta.id,
      ...(error ? { error } : {}),
    })
  }
  if (rt.briefActive === jobId) rt.briefActive = null
  pumpBriefQueue(rt)
}

/** The run's turn ended: ready if write_brief landed, else the model finished without writing. */
async function onBriefTurnDone(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  const job = await rt.store.briefs.forSession(sessionId)
  if (!job || job.status !== 'running') return
  const wrote = rt.briefWrote.has(job.id)
  await finishBrief(rt, job.id, wrote ? 'ready' : 'failed', wrote ? undefined : 'the run finished without calling write_brief')
}

/** The subprocess died mid-run (crash, interrupt, auth): the job cannot complete. */
async function onBriefSessionEnded(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  const job = await rt.store.briefs.forSession(sessionId)
  if (!job || job.status !== 'running') return
  await finishBrief(rt, job.id, 'failed', 'the brief session ended before it finished')
}

/** Boot: seed the prose files, mirror session→item links, fail runs the old daemon took down, pump. */
async function bootBriefs(rt: WorkspaceRuntime): Promise<void> {
  await seedPlaybooks(rt.playbookDir).catch((err) => log('error', 'briefs', `could not seed playbooks: ${err}`, { workspace: rt.meta.id }))
  await seedDispatchTemplates(rt.dispatchDir).catch((err) => log('error', 'briefs', `could not seed dispatch templates: ${err}`, { workspace: rt.meta.id }))
  for (const l of await rt.store.links.list()) {
    if (l.fromKind === 'session' && l.toKind === 'item') rt.sessionItem.set(l.fromId, l.toId)
  }
  const failed = await rt.store.briefs.failAllRunning('the daemon restarted while this brief was running — re-brief to try again')
  if (failed.length) log('warn', 'briefs', `failed ${failed.length} run(s) interrupted by the restart`, { jobIds: failed, workspace: rt.meta.id })
  pumpBriefQueue(rt)
}

/** What a dispatched session opens with: the kind's template, the item, and the brief as a mention. */
async function dispatchPreviewOp(rt: WorkspaceRuntime, itemId: string): Promise<DispatchPreview> {
  const scored = rt.inboxCache?.items.find((i) => i.id === itemId)
  const item = scored ?? (await rt.store.items.get(itemId))
  if (!item) throw new Error('no such work item')
  const [project, brief, latest, tpl] = await Promise.all([
    projectFor(rt, item),
    currentBrief(rt, item.id),
    rt.store.briefs.latestForItem(item.id),
    readDispatchTemplate(rt.dispatchDir, item.kind),
  ])
  const mentions: Mention[] = [{ kind: 'item', ref: item.id, label: item.title }]
  if (brief) mentions.push({ kind: 'artifact', ref: brief.artifact.id, label: brief.artifact.title })
  const body = renderTemplate(tpl, {
    kind: item.kind,
    title: item.title,
    url: item.url || undefined,
    description: item.description,
    reason: scored?.reason,
    note: latest?.note ?? undefined,
    brief: !!brief,
    source: item.source !== 'manual',
  })
  // The item's screenshots are attached by the server when the draft is sent
  // (they never ride in localStorage), so the text says they are coming.
  const shots = item.images?.length ?? 0
  const note = shots ? `\n\n${shots} screenshot${shots === 1 ? '' : 's'} from this item ${shots === 1 ? 'is' : 'are'} attached to this message.` : ''
  // The mention tokens must appear in the text — the composer attaches only what the text names.
  const text = `${body}${note}\n\n${mentions.map(mentionToken).join(' ')}`
  return { title: item.title.slice(0, 80), cwd: project?.path ?? null, text, mentions }
}

const okResult = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const errResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

function makeTriageMcp(rt: WorkspaceRuntime) {
  return createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    // Always load triage's tools, never defer them behind tool search — and,
    // as a documented side effect, block session startup until this server is
    // connected (capped at the SDK's 5s connect timeout). Without it, when the
    // user has many ~/.claude connectors, triage loses the init connection race
    // ("connector storm") and lands `status: "failed"` in system/init, leaving
    // a chat with no mcp__triage__* tools so it falls back to the HTTP API.
    // triage is in-process and connects in ~ms, so this guarantees its tools
    // are present on turn 1 without slowing startup or dropping any connector.
    alwaysLoad: true,
    // What triage is, in the one place the SDK will show a model before it
    // picks a tool. Static by construction (shared/triageContext.ts) so it
    // caches, and shared verbatim with the stdio shim — one contract, two
    // transports, one explanation of it.
    instructions: TRIAGE_MCP_INSTRUCTIONS,
    tools: [
      tool(
        'list_work_items',
        'Read the ranked triage queue: work items with their score, group, and reason. Open items by default — pass status to read the done, snoozed or archived lists instead. Optional filters narrow by source or kind.',
        {
          status: z.enum(['open', 'snoozed', 'done', 'archived']).optional().describe('which list to read (default "open")'),
          source: z.enum(['github', 'slack', 'linear', 'manual']).optional().describe('only items from this source'),
          kind: z.string().optional().describe('only items of this kind, e.g. "watch-hit"'),
        },
        async (args) => {
          try {
            const items = await listItemsOp(rt, { source: args.source, kind: args.kind, status: args.status })
            return okResult(JSON.stringify(items, null, 2))
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'get_work_item',
        'Everything about one work item by id, at any status: the item, its rank if it is in the open inbox, the items sharing a ref with it, the artifacts linked to it (its brief and any context notes) and the sessions that worked it. Use this to follow an id from list_work_items, from a linked sibling, or from get_session_context.',
        { id: z.string().describe('a work-item id, e.g. "github:owner/repo#12" or "manual:<uuid>"') },
        async (args) => {
          try {
            return okResult(JSON.stringify(await itemDetailOp(rt, args.id), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'get_session_context',
        'What this session is: its workspace, the work item it was opened for (with that item\'s brief and notes), and the artifacts attached to it. Your own triage session id is in your system prompt. Call this before writing a note "here" — the ids it returns are what write_artifact\'s `links` needs.',
        { sessionId: z.string().describe('a triage session id — yours is named in your system prompt') },
        async (args) => {
          try {
            return okResult(JSON.stringify(await sessionContextOp(rt, args.sessionId), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'get_workspace',
        'Which triage workspace you are acting in: `current` (its id, name, whether it is the default, and its auth backend) plus `workspaces`, the full roster of ids to switch among. Everything you list/create/edit here lives in `current`. An external Claude Code session picks its workspace with the TRIAGE_WORKSPACE env var (an unknown id silently falls back to the default) — call this to confirm which one you actually landed in.',
        {},
        async () => {
          try {
            return okResult(JSON.stringify(workspaceInfo(rt), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'create_work_item',
        'Add a manual to-do to the inbox (a user-authored item). Title is required; description, url, priority (1–4), and projectId are optional.',
        {
          title: z.string().describe('what the to-do is'),
          description: z.string().optional().describe("the user's intent in a few sentences"),
          note: z.string().optional().describe('alias of description'),
          url: z.string().optional().describe('an http(s) link'),
          priority: z.number().int().min(1).max(4).optional(),
          projectId: z.string().optional().describe('an existing project id'),
        },
        async (args) => {
          try {
            const id = await createManualOp(rt, args)
            return okResult(`ok: created ${id}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'edit_work_item',
        'Edit a manual to-do by id (id must start with "manual:"). Only the fields you pass change; priority 0/null clears it.',
        {
          id: z.string().describe('the manual item id, e.g. "manual:<uuid>"'),
          title: z.string().optional(),
          description: z.string().optional(),
          note: z.string().optional().describe('alias of description'),
          url: z.string().optional(),
          priority: z.number().int().min(0).max(4).nullable().optional(),
          projectId: z.string().optional(),
        },
        async (args) => {
          try {
            const { id, ...patch } = args
            await editManualOp(rt, id, patch)
            return okResult(`ok: edited ${id}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'upsert_work_item',
        'Idempotently upsert one ingested work item (for scanners). Id-keyed, update-only-if-newer by updatedAt, user-state-preserving: repeated calls never create duplicates or clobber done/snoozed/dismissed state. Invalid items are rejected, never repaired.',
        {
          id: z.string().describe('stable id: "slack:...", "github:owner/repo#123", or "linear:KEY-123"'),
          kind: z.string().describe('item kind, e.g. "watch-hit", "mention", "fyi"'),
          title: z.string(),
          url: z.string(),
          updatedAt: z.string().describe('ISO 8601 — the upsert applies only if newer than what is stored'),
          repo: z.string().optional(),
          author: z.string().optional(),
          peopleWaiting: z.number().optional(),
          createdAt: z.string().optional(),
          watchId: z.string().optional(),
          why: z.string().optional(),
          refs: z.array(z.string()).optional(),
        },
        async (args) => {
          try {
            const outcome = await upsertItemOp(rt, args)
            return okResult(`ok: ${outcome}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'resolve_work_item',
        'Mark one work item done (by id). Subject to the re-arm rule: if the source updates afterwards, the item returns to the inbox.',
        { id: z.string() },
        async (args) => {
          try {
            await resolveItemOp(rt, args.id)
            return okResult('ok: done')
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      // Artifacts: the user's markdown notes and briefs beside the inbox
      // (.docs/next-version.md). Reads are auto-allowed; writes prompt like
      // every other triage write, and the model may only rewrite its own.
      tool(
        'list_artifacts',
        "List this workspace's artifacts — markdown notes and briefs kept beside the work items — with id, title, author (human|model), refs, path and links. Read one with read_artifact.",
        { all: z.boolean().optional().describe('include briefs of finished (done/archived) items, hidden by default') },
        async (args) => {
          try {
            const rows = await listArtifactsOp(rt, args.all === true)
            return okResult(JSON.stringify(rows.map(({ mtime, size, ...a }) => (void mtime, void size, a)), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'read_artifact',
        'Read one artifact by id: title, author, refs, its path on disk, and the full markdown body.',
        { id: z.string().describe('the artifact id from list_artifacts') },
        async (args) => {
          try {
            const a = await rt.artifacts.read(args.id)
            if (!a) return errResult('no such artifact')
            const head = [
              `title: ${a.artifact.title}`,
              `id: ${a.artifact.id}`,
              `author: ${a.artifact.author}`,
              `path: ${a.abs}`,
              a.artifact.refs.length ? `refs: ${a.artifact.refs.join(', ')}` : undefined,
            ].filter((l): l is string => typeof l === 'string')
            return okResult(`${head.join('\n')}\n\n${a.body}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'write_artifact',
        'Create a new artifact (a markdown note authored by you, the model) in the workspace, optionally linked to a work item or session as context. Returns its id. Use update_artifact to change it later.',
        {
          title: z.string().describe('a short title'),
          body: z.string().describe('the markdown body'),
          refs: z.array(z.string()).optional().describe('GitHub PR/issue URLs or Linear keys this note is about'),
          links: z
            .array(
              z.object({
                kind: z.enum(['item', 'session']),
                id: z.string(),
                role: z.enum(['brief', 'context', 'dispatch']),
              }),
            )
            .optional()
            .describe('attach to a work item or session; role is usually "context"'),
        },
        async (args) => {
          try {
            const a = await createArtifactOp(rt, args, 'model')
            return okResult(`ok: created ${a.id} at ${a.path}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'update_artifact',
        'Rewrite an artifact you (the model) authored, in place: any of title, body, refs. Human-authored artifacts are refused — propose the change to the user instead.',
        {
          id: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          refs: z.array(z.string()).optional(),
        },
        async (args) => {
          try {
            const { id, ...patch } = args
            const a = await updateArtifactOp(rt, id, patch, 'model')
            return okResult(`ok: updated ${a.path}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'link_artifact',
        'Link an existing artifact to a work item or session with a role ("context" for notes to read alongside; "brief" only for the document about an item).',
        {
          artifactId: z.string(),
          kind: z.enum(['item', 'session']),
          id: z.string(),
          role: z.enum(['brief', 'context', 'dispatch']),
        },
        async (args) => {
          try {
            const l = await addLinkOp(rt, { fromKind: 'artifact', fromId: args.artifactId, toKind: args.kind, toId: args.id, role: args.role })
            return okResult(`ok: linked ${l.id}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
    ],
  })
}

const NO_BUILD_HTML = `<!doctype html><meta charset="utf-8">
<title>triage — no build</title>
<body style="font:14px/1.6 system-ui;max-width:34em;margin:12vh auto;color:#dce3f0;background:#0d1017">
<h2 style="color:#e8b04b">No web build found</h2>
<p>This server is serving the production bundle from <code>dist/web</code>, which does not exist yet.</p>
<p>For development, run <code>npm run dev</code> and open the Vite URL it prints — it proxies
<code>/ws</code> and <code>/api</code> back here.</p>
<p>For a production-style run: <code>npm run build &amp;&amp; npm start</code>.</p>
</body>`

async function serveWeb(pathname: string, res: http.ServerResponse) {
  // Any path that is not a real asset falls back to index.html (SPA routing).
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resolved = path.resolve(WEB_DIR, rel)
  const candidate = resolved.startsWith(WEB_DIR + path.sep) ? resolved : path.join(WEB_DIR, 'index.html')

  for (const file of [candidate, path.join(WEB_DIR, 'index.html')]) {
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' })
      res.end(body)
      return
    } catch {
      // try the SPA fallback next
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(NO_BUILD_HTML)
}


/**
 * The MCP endpoint (streamable HTTP): the same contract the stdio shim serves
 * (core/mcp/tools.ts), reachable as a URL instead of a spawned process —
 * `http://localhost:5178/mcp` for a running daemon, `…:5188/mcp` in dev. No
 * per-session subprocess to spawn, resolve on PATH, or lose a connect race
 * with, which is most of what made MCP feel unreliable from outside triage.
 *
 * The workspace rides in the URL (`?workspace=<id>`), not an env var, and an
 * id that matches nothing is refused at `initialize` — the client shows the
 * server as failed instead of quietly filing work into the default inbox.
 */
const MCP_PATH = '/mcp'

/**
 * A browser can POST to localhost from any page it likes, so a local HTTP MCP
 * server must check where the request claims to come from (the MCP spec says
 * so for exactly this reason). Non-browser clients send no Origin at all.
 */
function localOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const h = new URL(origin).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
  } catch {
    return false
  }
}

/** Loopback into this daemon's own API, so one route table serves every door. */
function mcpApi(workspace: string | null): (path: string, body?: unknown, method?: string) => Promise<unknown> {
  return async (path, body, method) => {
    if (workspace) path += `${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(workspace)}`
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return (await res.json()) as unknown
  }
}

type McpRpc = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> }

/** One JSON-RPC message. Returns null for a notification (nothing to send back). */
async function mcpDispatch(msg: McpRpc, workspace: string | null, serverUrl: string): Promise<unknown | null> {
  const id = msg.id
  const ok = (result: unknown) => (id === undefined ? null : { jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } })
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'triage', version: VERSION },
        instructions: TRIAGE_MCP_INSTRUCTIONS,
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: MCP_TOOLS })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const { text, isError } = await callMcpTool(mcpApi(workspace), { serverUrl, requestedWorkspace: workspace }, name, args)
        return ok({ content: [{ type: 'text', text }], isError })
      } catch (err) {
        return ok({ content: [{ type: 'text', text: `failed: ${errText(err)}` }], isError: true })
      }
    }
    default:
      return msg.method ? fail(-32601, `method not found: ${msg.method}`) : fail(-32600, 'invalid request')
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === MCP_PATH) {
    if (!localOrigin(req.headers.origin)) {
      json(403, { error: 'cross-origin requests are not accepted on /mcp' })
      return
    }
    // No SSE stream is offered: every response is a plain JSON body, which the
    // spec covers by answering 405 to the stream methods.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      res.end(JSON.stringify({ error: 'POST a JSON-RPC message to /mcp' }))
      return
    }
    const wanted = url.searchParams.get('workspace')
    if (wanted && !runtimes.has(wanted)) {
      // Loud, at connect time: the alternative is filing work into the wrong
      // inbox for as long as it takes someone to notice.
      json(404, {
        error: `unknown workspace "${wanted}"`,
        known: [...runtimes.keys()],
        hint: 'the URL takes a workspace id, not its display name; drop the parameter to use the default',
      })
      return
    }
    let payload: unknown
    try {
      payload = await readJsonBody(req, 4_000_000)
    } catch (err) {
      json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${errText(err)}` } })
      return
    }
    const serverUrl = `http://localhost:${PORT}${MCP_PATH}`
    const batch = Array.isArray(payload) ? (payload as McpRpc[]) : [payload as McpRpc]
    const out = (await Promise.all(batch.map((m) => mcpDispatch(m, wanted, serverUrl)))).filter((r) => r !== null)
    if (out.length === 0) {
      res.writeHead(202)
      res.end()
      return
    }
    json(200, Array.isArray(payload) ? out : out[0])
    return
  }

  if (url.pathname === '/api/health') {
    // The CLI's "is triage running" probe — see server/state.ts. Daemon-wide.
    json(200, {
      app: 'triage',
      version: VERSION,
      pid: process.pid,
      port: PORT,
      db: dbFileFor(registry.defaultId, registry.defaultId),
      liveSessions: [...runtimes.values()].reduce((n, rt) => n + rt.live.size, 0),
      workspaces: runtimes.size,
    })
    return
  }

  if (url.pathname === '/api/git/branch') {
    // Which branch a folder has checked out — the draft composer shows it
    // beside the project before any session exists. Not a repo → null.
    const cwd = expandHome(url.searchParams.get('cwd') ?? '')
    try {
      const { stdout } = await pExecFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
      json(200, { ok: true, branch: stdout.trim() || null })
    } catch {
      json(200, { ok: true, branch: null })
    }
    return
  }

  // --- workspace management (daemon-wide, not workspace-scoped) --------------
  if (url.pathname === '/api/workspaces' && req.method === 'GET') {
    const body: WorkspacesResponse = {
      ok: true,
      workspaces: wireWorkspaces(),
      defaultId: registry.defaultId,
      onboarded: registry.onboarded,
    }
    json(200, body)
    return
  }
  if (url.pathname === '/api/workspaces' && req.method === 'POST') {
    let body: WorkspaceResponse
    try {
      const parsed = workspacePatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (!p.name) throw new Error('a workspace needs a name')
      let id = slugify(p.name)
      for (let n = 2; runtimes.has(id); n++) id = `${slugify(p.name)}-${n}`
      const meta: WorkspaceMeta = {
        id,
        name: p.name,
        color: p.color ?? '#7aa2f7',
        ...(p.description ? { description: p.description } : {}),
        authBackend: p.authBackend ?? 'inherit',
        createdAt: Date.now(),
      }
      ensureWorkspaceDirs(id)
      if (p.apiKey) writeApiKey(id, p.apiKey)
      registry.workspaces.push(meta)
      saveRegistry(registry)
      const rt = new WorkspaceRuntime(meta)
      runtimes.set(id, rt)
      await initRuntime(rt)
      log('info', 'workspaces', `created: ${meta.name}`, { workspace: id, authBackend: meta.authBackend })
      body = { ok: true, workspace: wireWorkspace(meta) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces' && req.method === 'PUT') {
    let body: WorkspaceResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      const parsed = workspacePatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (p.name) rt.meta.name = p.name
      if (p.color) rt.meta.color = p.color
      if (p.description !== undefined) rt.meta.description = p.description || undefined
      const authChanged = (p.authBackend && p.authBackend !== rt.meta.authBackend) || p.apiKey !== undefined
      if (p.authBackend) rt.meta.authBackend = p.authBackend
      if (p.apiKey) writeApiKey(id, p.apiKey)
      saveRegistry(registry)
      if (authChanged) applyAuthChange(rt)
      body = { ok: true, workspace: wireWorkspace(rt.meta) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces' && req.method === 'DELETE') {
    let body: WorkspacesResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      if (id === registry.defaultId) throw new Error('the default workspace cannot be deleted — make another workspace the default first')
      // Remove from the registry and stop the runtime. The directory (DB,
      // .env, claude/) stays on disk — never delete data, only unregister.
      for (const s of rt.live.values()) s.stop()
      for (const ws of rt.clients) ws.close()
      runtimes.delete(id)
      registry.workspaces = registry.workspaces.filter((w) => w.id !== id)
      saveRegistry(registry)
      await rt.store.close()
      log('info', 'workspaces', `removed: ${rt.meta.name} (files kept on disk)`, { workspace: id })
      body = { ok: true, workspaces: wireWorkspaces(), defaultId: registry.defaultId, onboarded: registry.onboarded }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces/default' && req.method === 'POST') {
    let body: WorkspacesResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!runtimes.has(id)) throw new Error('unknown workspace id')
      registry.defaultId = id
      saveRegistry(registry)
      body = { ok: true, workspaces: wireWorkspaces(), defaultId: registry.defaultId, onboarded: registry.onboarded }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces/onboarded' && req.method === 'POST') {
    registry.onboarded = true
    saveRegistry(registry)
    json(200, { ok: true })
    return
  }
  // A live probe with the workspace's own env — the creation modal's verify
  // step, and the settings dialog's "Check again". Clears the caches first so
  // the answer reflects the auth as configured right now.
  if (url.pathname === '/api/workspaces/verify' && req.method === 'POST') {
    let body: WorkspaceVerifyResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      rt.refreshEnv()
      rt.connectorCache = null
      rt.modelCache = null
      const [models, connectors, auth] = await Promise.all([
        probeModels(rt),
        probeConnectors(rt),
        // inherit is the machine's own login — already proven by daily use.
        rt.meta.authBackend === 'inherit' ? Promise.resolve({ ok: true as const }) : probeAuth(rt),
      ])
      body = {
        ok: true,
        models: models.models,
        connectors: connectors.connectors,
        slackConnected: slackConnected(rt) === true,
        authOk: auth.ok,
        ...('error' in auth && auth.error ? { authError: auth.error } : {}),
      }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }

  // --- everything below is scoped to one workspace ---------------------------
  const rt = resolveRuntime(req, url)

  // The workspace this request resolved to, singular and scoped — unlike the
  // daemon-wide /api/workspaces list. Backs get_workspace so a chat or the stdio
  // shim can answer "which workspace am I in?" (and the shim can tell whether its
  // TRIAGE_WORKSPACE matched or silently fell back to the default).
  if (url.pathname === '/api/workspace' && req.method === 'GET') {
    json(200, { ok: true, ...workspaceInfo(rt) })
    return
  }

  if (url.pathname === '/api/sessions') {
    json(200, summaries(rt))
    return
  }

  // What this session changed, and one file's patch. Session-scoped on
  // purpose: the question is "what did this agent do", not "what is dirty".
  {
    const m = /^\/api\/sessions\/([^/]+)\/(changes|diff)$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      const row = rt.rows.get(m[1]) ?? (await rt.store.sessions.get(m[1]))
      if (!row) {
        json(404, { ok: false, error: 'no such session' })
        return
      }
      if (m[2] === 'changes') {
        let body: SessionChangesResponse
        try {
          body = { ok: true, changes: await computeSessionChanges(rt, row) }
        } catch (err) {
          body = { ok: false, error: errText(err) }
        }
        json(body.ok ? 200 : 500, body)
        return
      }
      const file = url.searchParams.get('path') ?? ''
      let body: SessionDiffResponse
      try {
        if (!file) throw new Error('need a path')
        const got = await sessionFilePatch(rt, row, file)
        if (!got) throw new Error('no snapshots for this session')
        body = { ok: true, path: file, patch: got.patch, isBinary: got.patch.includes('Binary files'), truncated: got.truncated }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return
    }
  }

  // The composer's `@` picker: fuzzy file matches under one folder.
  if (url.pathname === '/api/files/search' && req.method === 'GET') {
    const root = expandHome(url.searchParams.get('root') ?? '')
    const q = url.searchParams.get('q') ?? ''
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 40, 1), 200)
    let body: FileSearchResponse
    if (!(await isSearchableRoot(rt, root))) {
      body = { ok: false, error: 'not a folder triage can list (a session folder, a project, or under your home)' }
    } else {
      try {
        body = { ok: true, root, ...(await rt.files.get(root).search(q, limit)) }
      } catch (err) {
        body = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/inbox') {
    let body: InboxResponse
    try {
      const snap = await getInbox(rt, url.searchParams.get('refresh') === '1')
      body = { ok: true, ...snap }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/repos') {
    let body: ReposResponse
    try {
      if (req.method === 'PUT') {
        const parsed = (await readJsonBody(req)) as { repos?: unknown } | null
        const repos = Array.isArray(parsed?.repos)
          ? parsed.repos.filter((r): r is string => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r))
          : []
        await rt.store.config.set(REPOS_KEY, repos)
        rt.inboxCache = null // scope changed — force a resync on the next view
      }
      body = { ok: true, connected: await connectedRepos(rt), available: await affiliatedRepos(rt) }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/projects') {
    let body: ProjectsResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        const parsed = (await readJsonBody(req)) as Partial<Project> | null
        const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
        const repo = typeof parsed?.repo === 'string' ? parsed.repo.trim() : ''
        const rawPath = typeof parsed?.path === 'string' ? parsed.path.trim() : ''
        if (!name || !rawPath) throw new Error('a project needs a name and a folder')
        if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not owner/name`)
        const resolved = expandHome(rawPath)
        const st = await stat(resolved).catch(() => null)
        if (!st?.isDirectory()) throw new Error(`folder not found: ${resolved}`)
        await rt.store.projects.create({ id: randomUUID(), name, repo, path: resolved })
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) await rt.store.projects.remove(id)
      }
      body = { ok: true, projects: await rt.store.projects.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return
  }
  if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
    let body: PickFolderResponse
    try {
      const picked = await pickNativeFolder()
      body = picked ? { ok: true, path: picked } : { ok: true, cancelled: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  if (url.pathname === '/api/watches') {
    let body: WatchesResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        const parsed = watchPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        const p = parsed.patch
        if (!p.title || !p.instruction || !p.connectors?.length) {
          throw new Error('a watch needs a title, instructions, and at least one connector')
        }
        if (p.projectId && !(await rt.store.projects.list()).some((pr) => pr.id === p.projectId)) {
          throw new Error('unknown project')
        }
        // Schedule is the source of truth; accept a legacy cadence as a fallback.
        const schedule = p.schedule ?? (p.cadence ? cronFromCadence(p.cadence, p.windowStart, p.windowDay) : '0 9 * * *')
        const now = Date.now()
        await rt.store.watches.create({
          id: randomUUID(),
          source: 'slack',
          title: p.title,
          scope: p.scope ?? '',
          connectors: p.connectors,
          projectId: p.projectId,
          model: p.model,
          output: p.output ?? 'items',
          instruction: p.instruction,
          schedule,
          cadence: p.cadence ?? 'daily',
          windowStart: p.windowStart,
          windowDay: p.windowDay,
          enabled: p.enabled ?? true,
          createsItems: p.createsItems ?? true,
          createdAt: now,
          updatedAt: now,
        })
        log('info', 'watch', `created: ${p.title}`, { connectors: p.connectors, schedule, workspace: rt.meta.id })
        // active on the next scheduler tick (never run → due immediately)
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        const existing = id ? await rt.store.watches.get(id) : null
        if (!id || !existing) throw new Error('unknown watch id')
        const parsed = watchPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        if (parsed.patch.projectId && !(await rt.store.projects.list()).some((pr) => pr.id === parsed.patch.projectId)) {
          throw new Error('unknown project')
        }
        await rt.store.watches.update(id, parsed.patch)
        log('info', 'watch', `updated: ${parsed.patch.title ?? existing.title}`, { watchId: id, workspace: rt.meta.id })
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) {
          // Never hard-delete the items: archive this watch's open/snoozed items
          // with a recorded reason, then drop the watch row (.docs/watches-v2.md).
          let archived = 0
          for (const it of await rt.store.items.listAll()) {
            const fromWatch = it.watchId === id || (it.foundBy ?? []).some((p) => p.watchId === id)
            if (fromWatch && (it.status === 'open' || it.status === 'snoozed')) {
              await rt.store.items.transition(it.id, { status: 'archived', actor: 'system', detail: { reason: 'watch deleted' } })
              archived += 1
            }
          }
          await rt.store.watches.remove(id)
          rt.inboxCache = null
          log('info', 'watch', `deleted watch ${id}; archived ${archived} item(s)`, { watchId: id, archived, workspace: rt.meta.id })
        }
      }
      body = { ok: true, watches: await rt.store.watches.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return
  }
  // Dry run of the form's current state (.docs/watches.md "Preview step"):
  // POST starts it and hands back an ephemeral session id to subscribe to for
  // the live transcript; GET polls its outcome. Nothing is written anywhere.
  if (url.pathname === '/api/watches/preview' && req.method === 'POST') {
    let body: WatchPreviewStartResponse
    try {
      const parsed = watchPatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (!p.instruction || !p.connectors?.length) throw new Error('a preview needs instructions and at least one integration')
      const previewId = startWatchPreview(rt, {
        instruction: p.instruction,
        connectors: p.connectors,
        projectId: p.projectId,
        model: p.model,
        output: p.output ?? 'items',
      })
      body = { ok: true, previewId }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/watches/preview' && req.method === 'GET') {
    const pv = rt.previews.get(url.searchParams.get('id') ?? '')
    const body: WatchPreviewStatusResponse = pv
      ? { ok: true, status: pv.status, ...(pv.result ? { result: pv.result } : {}), ...(pv.error ? { error: pv.error } : {}) }
      : { ok: false, error: 'unknown or expired preview' }
    json(body.ok ? 200 : 404, body)
    return
  }
  if (url.pathname === '/api/watches/draft' && req.method === 'POST') {
    let body: WatchDraftResponse
    try {
      const parsed = (await readJsonBody(req)) as { text?: unknown } | null
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
      if (!text) throw new Error('describe the watch in plain text first')
      const draft = await draftWatch(text, undefined, rt.env)
      if (!draft) throw new Error('could not parse that into a watch — fill the form manually')
      body = { ok: true, draft }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/items/state' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; status?: unknown; snoozeUntil?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      const statusV = parsed?.status as ItemStatus
      if (!ANY_ITEM_ID_RE.test(id) || !ITEM_STATUSES.has(statusV)) {
        throw new Error('need an item id and a status (open|done|snoozed|archived)')
      }
      const snoozeUntil = typeof parsed?.snoozeUntil === 'number' ? parsed.snoozeUntil : undefined
      if (statusV === 'snoozed' && !snoozeUntil) throw new Error('snoozed needs snoozeUntil (epoch ms)')
      // A recorded transition on the durable item — never a delete (.docs/watches-v2.md).
      await rt.store.items.transition(id, { status: statusV, actor: 'user', snoozeUntil })
      rt.inboxCache = null
      log('info', 'inbox', `${statusV}: ${id} (by user)`, { id, status: statusV, actor: 'user', workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Ranked items in a status tab other than the open inbox (done/snoozed/archived).
  if (url.pathname === '/api/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const s = url.searchParams.get('status')
      const status: ItemStatus = ITEM_STATUSES.has(s as ItemStatus) ? (s as ItemStatus) : 'open'
      body = { ok: true, items: await listItemsByStatus(rt, status) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // One item, whole and unfiltered — what the MCP tool get_work_item reads,
  // and what the stdio shim reaches for over HTTP.
  if (url.pathname === '/api/items/detail' && req.method === 'GET') {
    let body: ItemDetailResponse
    try {
      body = { ok: true, detail: await itemDetailOp(rt, url.searchParams.get('id') ?? '') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // What a session may know about itself: its workspace, its work item, its notes.
  if (url.pathname === '/api/sessions/context' && req.method === 'GET') {
    let body: SessionContextResponse
    try {
      body = { ok: true, context: await sessionContextOp(rt, url.searchParams.get('id') ?? '') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // The append-only transition log for one item (its timeline).
  if (url.pathname === '/api/items/events' && req.method === 'GET') {
    let body: ItemEventsResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      body = { ok: true, events: await rt.store.items.events(id) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Activity: watch runs (each a session) as a browsable history, newest first.
  if (url.pathname === '/api/activity' && req.method === 'GET') {
    let body: ActivityResponse
    try {
      const watchId = url.searchParams.get('watchId')
      const titles = new Map((await rt.store.watches.list()).map((w) => [w.id, w.title]))
      const runs = [...rt.rows.values()]
        .filter((r) => r.kind === 'watch-run' && (!watchId || r.watchId === watchId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200)
        .map((r) => ({
          sessionId: r.id,
          ...(r.watchId ? { watchId: r.watchId } : {}),
          watchTitle: (r.watchId && titles.get(r.watchId)) || r.title.replace(/^Watch · /, ''),
          status: r.runStatus,
          matches: r.runMatches,
          tokens: r.runTokens,
          ...(r.runCostUsd != null ? { costUsd: r.runCostUsd } : {}),
          startedAt: r.createdAt,
          finishedAt: r.updatedAt,
          ...(r.runError ? { error: r.runError } : {}),
        }))
      body = { ok: true, runs }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // Every item a watch has ever filed, any status — the watch page's Items tab.
  if (url.pathname === '/api/watches/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const all = await rt.store.items.listAll()
      const mine = all.filter((it) => it.watchId === id || (it.foundBy ?? []).some((p) => p.watchId === id))
      body = { ok: true, items: linkByRefs(rank(mine)) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // The items one run produced (provenance runId === sessionId).
  if (url.pathname === '/api/activity/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const runId = url.searchParams.get('runId') ?? ''
      const all = await rt.store.items.listAll()
      const mine = all.filter((it) => (it.foundBy ?? []).some((p) => p.runId === runId))
      body = { ok: true, items: linkByRefs(rank(mine)) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // Force-run one watch now (the per-watch Run button). The run appears under
  // Activity; scheduled cadence runs continue on their own.
  if (url.pathname === '/api/watches/run' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const w = await rt.store.watches.get(id)
      if (!w) throw new Error('unknown watch id')
      if (slackConnected(rt) !== true) throw new Error('the claude.ai Slack connector is not connected')
      enqueueWatch(rt, id)
      log('info', 'watch', `run requested: ${w.title}`, { watchId: id, workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Daemon status for the System modal (is it up, ticking, connected?).
  if (url.pathname === '/api/system' && req.method === 'GET') {
    let body: SystemResponse
    try {
      body = { ok: true, status: await systemStatus(rt) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // The daemon's recent activity log (filterable by level / subsystem / text).
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    const level = url.searchParams.get('level')
    const body: LogsResponse = {
      ok: true,
      entries: recentLogs({
        level: (level as LogLevel) || undefined,
        subsystem: url.searchParams.get('subsystem') || undefined,
        q: url.searchParams.get('q') || undefined,
      }),
      subsystems: logSubsystems(),
    }
    json(200, body)
    return
  }
  // What Claude Code has spent on this machine, read from its own transcripts.
  // Machine-wide on purpose: a session started in a terminal costs the same
  // money as one started here, and the user asked what they are spending.
  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const asked = Number(url.searchParams.get('days'))
    const days = USAGE_WINDOWS.includes(asked as (typeof USAGE_WINDOWS)[number]) ? asked : 30
    const now = Date.now()
    // From the start of the day `days - 1` ago, so "7 days" is seven columns.
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const since = start.getTime() - (days - 1) * 86_400_000
    const began = Date.now()
    let body: UsageResponse
    try {
      const { entries, files, reread } = await scanUsage(claudeProjectRoots(), since)
      const usage = summarizeUsage(entries, since, now)
      usage.scan = { files, reread, ms: Date.now() - began }
      body = { ok: true, usage }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  // What a set of sessions cost — the item page's per-item spend readout. The
  // caller names the sessions (it owns the item→session join); we map each to
  // the Claude session id captured at init and fold the ledger by that.
  if (url.pathname === '/api/usage/sessions' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200)
    const asked = Number(url.searchParams.get('days'))
    const days = USAGE_WINDOWS.includes(asked as (typeof USAGE_WINDOWS)[number]) ? asked : 30
    const now = Date.now()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const since = start.getTime() - (days - 1) * 86_400_000

    let body: SessionsUsageResponse
    try {
      const bySession: Record<string, SessionSpend> = {}
      let models: UsageModelSlice[] = []
      const totals = { cost: 0, tokens: 0, messages: 0, priced: true, sessions: 0 }
      if (ids.length > 0) {
        // Only the newest sdk_session_id survives a resume today, so a resumed
        // session's earlier spend is not reachable from here. Whatever is on
        // the row is what can be joined.
        const stored = await rt.store.sessions.list()
        const sdkIds = new Map<string, string>()
        for (const sess of stored) {
          if (ids.includes(sess.id) && sess.sdkSessionId) sdkIds.set(sess.id, sess.sdkSessionId)
        }
        if (sdkIds.size > 0) {
          const { entries } = await scanUsage(claudeProjectRoots(), since)
          const folded = summarizeBySession(entries)
          // The model split is over these sessions only, not the machine.
          const wanted = new Set(sdkIds.values())
          models = summarizeModels(entries.filter((e) => wanted.has(e.sessionId)))
          for (const [id, sdkId] of sdkIds) {
            const row = folded.get(sdkId)
            if (!row) continue
            bySession[id] = row
            totals.cost += row.cost
            totals.tokens += row.tokens
            totals.messages += row.messages
            if (!row.priced) totals.priced = false
            totals.sessions++
          }
        }
      }
      body = { ok: true, usage: { days, bySession, models, totals } }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  // Manual "scan now": force every due (and overdue) watch to run and refresh GitHub.
  if (url.pathname === '/api/scan' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      void reconcileGitHub(rt, true).then(() => {
        rt.inboxCache = null
        void syncInbox(rt)
      })
      void runDueWatches(rt, { force: true })
      log('info', 'scheduler', 'manual scan requested (all watches + GitHub)', { workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // The ingestion contract (.docs/watches.md): idempotent upsert + resolve,
  // shared by external scanners over HTTP and the MCP shim (server/mcp.ts).
  // User state is never written by upsert; resolve is a normal 'done'.
  if (url.pathname === '/api/items/upsert' && req.method === 'POST') {
    let body: UpsertResponse
    try {
      const outcome = await upsertItemOp(rt, await readJsonBody(req))
      body = { ok: true, outcome }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/items/resolve' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      await resolveItemOp(rt, parsed?.id)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Manual items — to-dos the user adds by hand. Create/edit/delete; they merge
  // into the inbox like any other source and share the done/snooze overlay.
  if (url.pathname === '/api/items/manual') {
    let body: ManualItemResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        await createManualOp(rt, await readJsonBody(req, MAX_ITEM_BODY_BYTES))
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        if (!id) throw new Error('need a manual item id')
        await editManualOp(rt, id, await readJsonBody(req, MAX_ITEM_BODY_BYTES))
      } else if (req.method === 'DELETE') {
        // Never hard-delete (.docs/watches-v2.md): "delete" archives the item,
        // recorded, so it survives in the Archived tab.
        const id = url.searchParams.get('id')
        if (id) {
          await rt.store.items.transition(id, { status: 'archived', actor: 'user', detail: { reason: 'deleted by user' } })
          rt.inboxCache = null
        }
      } else {
        throw new Error('unsupported method')
      }
      body = { ok: true }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return
  }
  // A user priority override for any item (source or manual). null clears it.
  if (url.pathname === '/api/items/priority' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; priority?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!id) throw new Error('need an item id')
      const raw = parsed?.priority
      let priority: number | null
      if (raw === null || raw === 0 || raw === undefined) priority = null
      else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 4) priority = raw
      else throw new Error('priority must be 1–4, or null/0 to clear')
      await rt.store.items.setPriority(id, priority)
      rt.inboxCache = null
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/models') {
    let body: ModelsResponse
    try {
      const probe =
        rt.modelCache && url.searchParams.get('refresh') !== '1' ? rt.modelCache : await probeModels(rt)
      body = { ok: true, probedAt: probe.probedAt, models: probe.models }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/commands') {
    let body: CommandsResponse
    try {
      const cwd = expandHome(url.searchParams.get('cwd') ?? os.homedir())
      const cached = url.searchParams.get('refresh') === '1' ? null : rt.commandCache.get(cwd)
      const probe = cached ?? (await probeCommands(rt, cwd))
      body = { ok: true, cwd, probedAt: probe.probedAt, commands: usableCommands(rt, probe.commands) }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/connectors') {
    let body: ConnectorsResponse
    try {
      const probe =
        rt.connectorCache && url.searchParams.get('refresh') !== '1'
          ? rt.connectorCache
          : await probeConnectors(rt)
      body = { ok: true, probedAt: probe.probedAt, connectors: probe.connectors }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // --- settings, briefs, playbooks, dispatch (.docs/next-version.md, phase 2) ---
  if (url.pathname === '/api/settings') {
    let body: SettingsResponse
    try {
      if (req.method === 'GET') body = { ok: true, settings: await readSettings(rt) }
      else if (req.method === 'PUT') body = { ok: true, settings: await writeSettings(rt, await readJsonBody(req)) }
      else throw new Error('method not allowed')
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/playbooks') {
    const kind = url.searchParams.get('kind')
    try {
      if (req.method === 'GET' && !kind) {
        const body: PlaybooksResponse = { ok: true, playbooks: await listPlaybooks(rt.playbookDir) }
        json(200, body)
      } else if (req.method === 'GET' && kind) {
        const p = await readPlaybook(rt.playbookDir, kind)
        const body: PlaybookResponse = { ok: true, kind, body: p.body, custom: p.custom, path: p.path }
        json(200, body)
      } else if (req.method === 'PUT' && kind) {
        const parsed = (await readJsonBody(req)) as { body?: unknown } | null
        if (typeof parsed?.body !== 'string') throw new Error('need a markdown body')
        await writePlaybook(rt.playbookDir, kind, parsed.body)
        const p = await readPlaybook(rt.playbookDir, kind)
        const body: PlaybookResponse = { ok: true, kind, body: p.body, custom: p.custom, path: p.path }
        json(200, body)
      } else throw new Error('need ?kind= (GET or PUT)')
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return
  }
  if (url.pathname === '/api/dispatch/template') {
    const kind = url.searchParams.get('kind') ?? ''
    try {
      if (!isPlaybookName(kind)) throw new Error('need ?kind=')
      if (req.method === 'PUT') {
        const parsed = (await readJsonBody(req)) as { body?: unknown } | null
        if (typeof parsed?.body !== 'string') throw new Error('need a template body')
        await writeDispatchTemplate(rt.dispatchDir, kind, parsed.body)
      }
      json(200, { ok: true, kind, body: await readDispatchTemplate(rt.dispatchDir, kind) })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return
  }
  if (url.pathname === '/api/dispatch/preview' && req.method === 'GET') {
    let body: DispatchPreviewResponse
    try {
      body = { ok: true, preview: await dispatchPreviewOp(rt, url.searchParams.get('itemId') ?? '') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/briefs' && req.method === 'GET') {
    const itemId = url.searchParams.get('itemId')
    try {
      if (itemId) {
        const body: BriefResponse = { ok: true, brief: await briefViewFor(rt, itemId) }
        json(200, body)
      } else {
        const body: BriefJobsResponse = { ok: true, jobs: await rt.store.briefs.latestPerItem() }
        json(200, body)
      }
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return
  }
  if (url.pathname === '/api/briefs' && req.method === 'POST') {
    let body: BriefJobsResponse
    try {
      body = { ok: true, jobs: await enqueueBriefsOp(rt, await readJsonBody(req)) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/briefs/iterate' && req.method === 'POST') {
    let body: BriefJobsResponse
    try {
      body = { ok: true, jobs: [await iterateBriefOp(rt, await readJsonBody(req))] }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if ((url.pathname === '/api/briefs/cancel' || url.pathname === '/api/briefs/promote') && req.method === 'POST') {
    let body: BriefJobsResponse
    try {
      const parsed = (await readJsonBody(req)) as { jobId?: unknown } | null
      const jobId = typeof parsed?.jobId === 'string' ? parsed.jobId : ''
      const job = jobId ? await rt.store.briefs.get(jobId) : null
      if (!job || job.status !== 'queued') throw new Error('only a queued brief can be cancelled or moved')
      if (url.pathname.endsWith('/cancel')) {
        await finishBrief(rt, job.id, 'failed', 'cancelled before it ran')
      } else {
        // To the head of the line: older than the oldest queued job.
        const [first] = await rt.store.briefs.list('queued')
        await rt.store.briefs.update(job.id, { createdAt: (first?.createdAt ?? job.createdAt) - 1 })
      }
      body = { ok: true, jobs: [(await rt.store.briefs.get(job.id)) ?? job] }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/items/description' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; description?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      const d = parsed?.description
      if (d !== null && d !== undefined && typeof d !== 'string') throw new Error('description must be a string')
      if (typeof d === 'string' && d.length > 5000) throw new Error('description is too long (5000 chars max)')
      await rt.store.items.setDescription(id, typeof d === 'string' && d.trim() ? d.trim() : null)
      rt.inboxCache = null
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Screenshots on an item. The list sent is the complete desired set: refs
  // to keep plus new base64 uploads, reconciled against what is on disk.
  if (url.pathname === '/api/items/images' && req.method === 'POST') {
    let body: ItemImagesResponse
    try {
      const parsed = (await readJsonBody(req, MAX_ITEM_BODY_BYTES)) as Record<string, unknown> | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      body = { ok: true, images: await setItemImagesOp(rt, id, itemImageEdits(parsed ?? {}) ?? []) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // The bytes behind one ref (`itemImageUrl`). Ids are uuids and files are
  // never rewritten in place, so this is safe to cache hard.
  if (url.pathname === '/api/items/image' && req.method === 'GET') {
    const itemId = url.searchParams.get('item') ?? ''
    const imageId = url.searchParams.get('image') ?? ''
    const item = ANY_ITEM_ID_RE.test(itemId) ? await rt.store.items.get(itemId).catch(() => null) : null
    const image = item?.images?.find((i) => i.id === imageId)
    if (!image) {
      json(404, { ok: false, error: 'no such image' })
      return
    }
    try {
      const bytes = await readItemImage(rt.attachmentsDir, itemId, image)
      res.writeHead(200, {
        'content-type': image.mediaType,
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=31536000, immutable',
      })
      res.end(bytes)
    } catch {
      json(404, { ok: false, error: 'the image file is missing' })
    }
    return
  }
  // --- artifacts + links (.docs/next-version.md, phase 1) ---------------------
  if (url.pathname === '/api/artifacts' && req.method === 'GET') {
    let body: ArtifactsResponse
    try {
      body = { ok: true, root: rt.artifacts.root, artifacts: await listArtifactsOp(rt, url.searchParams.get('all') === '1') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  if (url.pathname === '/api/artifacts/content' && req.method === 'GET') {
    let body: ArtifactContentResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const a = id ? await rt.artifacts.read(id) : null
      if (!a) throw new Error('no such artifact')
      body = { ok: true, artifact: a.artifact, body: a.body, links: await linksFor(rt, 'artifact', id), abs: a.abs }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 404, body)
    return
  }
  if (url.pathname === '/api/artifacts' && (req.method === 'POST' || req.method === 'PUT')) {
    let body: ArtifactResponse
    try {
      const parsed = await readJsonBody(req)
      if (req.method === 'POST') body = { ok: true, artifact: await createArtifactOp(rt, parsed, 'human') }
      else {
        const id = url.searchParams.get('id') ?? ''
        if (!id) throw new Error('need an artifact id')
        // The stdio shim edits as the model (`?by=model`) and is held to the model's rule.
        const by: ArtifactAuthor = url.searchParams.get('by') === 'model' ? 'model' : 'human'
        body = { ok: true, artifact: await updateArtifactOp(rt, id, parsed, by) }
      }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/artifacts' && req.method === 'DELETE') {
    let body: OkBody
    try {
      const id = url.searchParams.get('id') ?? ''
      if (!id) throw new Error('need an artifact id')
      await rt.artifacts.remove(id)
      log('info', 'artifacts', `removed ${id}`, { id, workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/artifacts/reindex' && req.method === 'POST') {
    let body: ArtifactsResponse
    try {
      await rt.artifacts.refresh(true)
      body = { ok: true, root: rt.artifacts.root, artifacts: await listArtifactsOp(rt, url.searchParams.get('all') === '1') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  // Open the file in the user's own editor — the server runs on their machine.
  if (url.pathname === '/api/artifacts/open' && req.method === 'POST') {
    let body: OkBody
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      const a = id ? await rt.artifacts.read(id) : null
      if (!a) throw new Error('no such artifact')
      await openInEditor(a.abs)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/links') {
    let body: LinksResponse
    try {
      if (req.method === 'GET') {
        const kind = url.searchParams.get('kind')
        const id = url.searchParams.get('id') ?? ''
        if (!isLinkKind(kind) || !id) throw new Error('need kind (artifact|item|session) and id')
        body = { ok: true, links: await linksFor(rt, kind, id) }
      } else if (req.method === 'POST') {
        body = { ok: true, links: [await addLinkOp(rt, await readJsonBody(req))] }
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') ?? ''
        if (!id) throw new Error('need a link id')
        await rt.store.links.remove(id)
        body = { ok: true, links: [] }
      } else throw new Error('method not allowed')
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  await serveWeb(url.pathname, res)
})

// ---------------------------------------------------------------------------
// WebSocket — each connection binds to one workspace at upgrade time
// (?workspace= param, else the triage_ws cookie, else the default), and only
// ever sees that workspace's sessions and events.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' })

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(rt: WorkspaceRuntime, msg: ServerMessage) {
  const data = JSON.stringify(msg)
  for (const ws of rt.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data)
}

function broadcastSessionList(rt: WorkspaceRuntime) {
  broadcast(rt, { type: 'sessions', sessions: summaries(rt) })
}

function expandHome(p: string): string {
  if (!p) return process.cwd()
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return path.resolve(p)
}

/**
 * Open the OS-native folder chooser on the machine running the server — which,
 * since triage is a localhost app, is the user's own desktop. Returns the picked
 * absolute path, or null when the user dismisses the dialog. The picker command
 * exits non-zero on cancel; we treat that as a cancel rather than an error.
 */
async function pickNativeFolder(): Promise<string | null> {
  const prompt = 'Select a project folder'
  let cmd: string
  let args: string[]
  if (process.platform === 'darwin') {
    cmd = 'osascript'
    args = ['-e', `POSIX path of (choose folder with prompt "${prompt}")`]
  } else if (process.platform === 'win32') {
    cmd = 'powershell'
    args = [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${prompt}'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }`,
    ]
  } else {
    // Linux/other: prefer zenity, fall back to kdialog. Neither is guaranteed.
    cmd = 'zenity'
    args = ['--file-selection', '--directory', `--title=${prompt}`]
  }
  try {
    const { stdout } = await pExecFile(cmd, args)
    const out = stdout.trim()
    return out ? out : null
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string }
    // A missing picker binary (ENOENT) is a real error worth surfacing; a
    // non-zero exit from a present picker is the user cancelling.
    if (e.code === 'ENOENT') {
      if (process.platform === 'linux') {
        try {
          const { stdout } = await pExecFile('kdialog', ['--getexistingdirectory', os.homedir()])
          const out = stdout.trim()
          return out ? out : null
        } catch (err2) {
          const e2 = err2 as NodeJS.ErrnoException
          if (e2.code === 'ENOENT') throw new Error('no folder picker found (install zenity or kdialog)')
          return null
        }
      }
      throw new Error(`folder picker not available (${cmd} not found)`)
    }
    return null
  }
}

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

const effort = (v: unknown): EffortLevel | undefined =>
  EFFORT_LEVELS.includes(v as EffortLevel) ? (v as EffortLevel) : undefined

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'gated']

/**
 * Unrecognized modes fall through to `undefined`, i.e. ask — a frame the
 * server does not understand must never widen what a session may do.
 */
const permissionMode = (v: unknown): PermissionMode | undefined =>
  PERMISSION_MODES.includes(v as PermissionMode) ? (v as PermissionMode) : undefined

/**
 * AskUserQuestion answers off the socket: a flat string→string map, or nothing.
 * Non-string values are dropped rather than passed through — this object is
 * merged into a tool's input.
 */
const questionAnswers = (v: unknown): QuestionAnswers | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: QuestionAnswers = {}
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
  return Object.keys(out).length > 0 ? out : undefined
}

/** Rough decoded size of a base64 payload, without decoding it. */
const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4)

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Image attachments off the socket. Anything malformed, oversized, or of an
 * unsupported media type is dropped rather than forwarded — these bytes go
 * both into the event log and up to the API.
 */
const imageAttachments = (v: unknown): ImageAttachment[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out: ImageAttachment[] = []
  for (const raw of v.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    if (typeof raw !== 'object' || raw === null) continue
    const a = raw as Record<string, unknown>
    if (!isImageMediaType(a.mediaType)) continue
    if (typeof a.data !== 'string' || !a.data || !BASE64.test(a.data)) continue
    if (base64Bytes(a.data) > MAX_IMAGE_BYTES) continue
    out.push({
      mediaType: a.mediaType,
      data: a.data,
      name: typeof a.name === 'string' && a.name ? a.name.slice(0, 200) : undefined,
    })
  }
  return out.length > 0 ? out : undefined
}

const mentionList = (v: unknown): Mention[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out: Mention[] = []
  for (const raw of v.slice(0, MAX_MENTIONS_PER_MESSAGE)) {
    if (typeof raw !== 'object' || raw === null) continue
    const m = raw as Record<string, unknown>
    if (!isMentionKind(m.kind)) continue
    if (typeof m.ref !== 'string' || !m.ref || m.ref.length > 1024) continue
    // Paths are resolved against the session folder later; an absolute path
    // or a `..` hop is refused here so the resolver only ever sees relatives.
    if (m.kind === 'file' && (path.isAbsolute(m.ref) || m.ref.split('/').includes('..'))) continue
    out.push({
      kind: m.kind,
      ref: m.ref,
      label: typeof m.label === 'string' && m.label ? m.label.slice(0, 200) : m.ref.slice(0, 200),
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * The socket is untrusted input (vision principle 6), so incoming frames are
 * validated into the ClientMessage union rather than cast into it.
 */
function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const model = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  switch (m.type) {
    case 'create_session':
      return {
        type: 'create_session',
        title: str(m.title),
        cwd: str(m.cwd),
        firstMessage: typeof m.firstMessage === 'string' ? m.firstMessage : undefined,
        images: imageAttachments(m.images),
        mentions: mentionList(m.mentions),
        model: model(m.model),
        effort: effort(m.effort),
        fastMode: m.fastMode === true,
        permissionMode: permissionMode(m.permissionMode),
        itemId: typeof m.itemId === 'string' && m.itemId ? m.itemId : undefined,
      }
    case 'set_model':
      return typeof m.sessionId === 'string'
        ? { type: 'set_model', sessionId: m.sessionId, model: model(m.model), effort: effort(m.effort) }
        : null
    case 'set_fast_mode':
      // Anything but an explicit true is off — the paid-for mode is the one
      // that has to be asked for exactly.
      return typeof m.sessionId === 'string'
        ? { type: 'set_fast_mode', sessionId: m.sessionId, fastMode: m.fastMode === true }
        : null
    case 'set_permission_mode': {
      const mode = permissionMode(m.mode)
      return typeof m.sessionId === 'string' && mode
        ? { type: 'set_permission_mode', sessionId: m.sessionId, mode }
        : null
    }
    case 'rename_session':
      return typeof m.sessionId === 'string'
        ? { type: 'rename_session', sessionId: m.sessionId, title: str(m.title) }
        : null
    case 'set_pinned':
      return typeof m.sessionId === 'string'
        ? { type: 'set_pinned', sessionId: m.sessionId, pinned: m.pinned === true }
        : null
    case 'delete_session':
      return typeof m.sessionId === 'string' ? { type: 'delete_session', sessionId: m.sessionId } : null
    case 'subscribe':
      return typeof m.sessionId === 'string' ? { type: 'subscribe', sessionId: m.sessionId } : null
    case 'user_message':
      return typeof m.sessionId === 'string'
        ? {
            type: 'user_message',
            sessionId: m.sessionId,
            text: str(m.text),
            images: imageAttachments(m.images),
            mentions: mentionList(m.mentions),
          }
        : null
    case 'permission_response':
      return typeof m.sessionId === 'string' && typeof m.requestId === 'string'
        ? {
            type: 'permission_response',
            sessionId: m.sessionId,
            requestId: m.requestId,
            // Anything unrecognized is a denial: the permissive readings are
            // the ones that have to be spelled out exactly.
            behavior:
              m.behavior === 'allow' ? 'allow' : m.behavior === 'allow_always' ? 'allow_always' : 'deny',
            answers: questionAnswers(m.answers),
          }
        : null
    case 'interrupt':
      return typeof m.sessionId === 'string' ? { type: 'interrupt', sessionId: m.sessionId } : null
    case 'terminal_create':
      return {
        type: 'terminal_create',
        cwd: typeof m.cwd === 'string' && m.cwd ? m.cwd : undefined,
        title: typeof m.title === 'string' && m.title ? m.title : undefined,
        command: typeof m.command === 'string' && m.command ? m.command : undefined,
      }
    case 'terminal_input':
      return typeof m.terminalId === 'string' && typeof m.data === 'string'
        ? { type: 'terminal_input', terminalId: m.terminalId, data: m.data }
        : null
    case 'terminal_resize':
      return typeof m.terminalId === 'string' && Number.isFinite(m.cols) && Number.isFinite(m.rows)
        ? { type: 'terminal_resize', terminalId: m.terminalId, cols: Number(m.cols), rows: Number(m.rows) }
        : null
    case 'terminal_subscribe':
      return typeof m.terminalId === 'string' ? { type: 'terminal_subscribe', terminalId: m.terminalId } : null
    case 'terminal_rename':
      return typeof m.terminalId === 'string'
        ? { type: 'terminal_rename', terminalId: m.terminalId, title: str(m.title) }
        : null
    case 'terminal_close':
      return typeof m.terminalId === 'string' ? { type: 'terminal_close', terminalId: m.terminalId } : null
    default:
      return null
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', `http://localhost:${PORT}`)
  const rt = resolveRuntime(req, url)
  rt.clients.add(ws)
  send(ws, {
    type: 'hello',
    sessions: summaries(rt),
    workspaceId: rt.meta.id,
    workspaces: wireWorkspaces(),
    onboarded: registry.onboarded,
    terminals: rt.terminals.list(),
  })

  ws.on('message', async (raw) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      return
    }
    const msg = parseClientMessage(parsed)
    if (!msg) return

    try {
      switch (msg.type) {
        case 'create_session': {
          const cwd = expandHome(msg.cwd)
          const title = msg.title.trim() || `Session ${rt.rows.size + 1}`
          const row = await createSession(
            rt,
            title,
            cwd,
            msg.model ?? null,
            msg.effort ?? null,
            msg.fastMode === true,
            msg.permissionMode ?? null,
          )
          // Dispatched from an item: the link is what the item page shows as "sessions".
          if (msg.itemId) await linkSessionToItem(rt, row.id, msg.itemId, 'dispatch').catch(() => {})
          send(ws, { type: 'session_created', session: summarize(rt, row) })
          broadcastSessionList(rt)
          // A dispatch opens with the item's screenshots attached — the draft
          // composer never carries the bytes, the server reads them off disk.
          const dispatched = msg.itemId ? await rt.store.items.get(msg.itemId).catch(() => null) : null
          const fromItem = dispatched
            ? await itemImageAttachments(rt.attachmentsDir, dispatched.id, dispatched.images)
            : undefined
          const images = [...(fromItem ?? []), ...(msg.images ?? [])].slice(0, MAX_IMAGES_PER_MESSAGE)
          if (msg.firstMessage?.trim() || images.length || msg.mentions?.length)
            void rt.live
              .get(row.id)
              ?.sendUserMessage(msg.firstMessage?.trim() ?? '', images.length ? images : undefined, msg.mentions)
          break
        }
        case 'set_model': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.model = msg.model ?? null
          row.effort = msg.effort ?? null
          await rt.store.sessions.setModel(row.id, row.model, row.effort)
          // A session with no subprocess picks the choice up from its row when
          // it is revived; a live one is switched in place.
          await rt.live.get(row.id)?.setModel(row.model, row.effort)
          broadcastSessionList(rt)
          break
        }
        case 'set_fast_mode': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.fastMode = msg.fastMode
          await rt.store.sessions.setFastMode(row.id, row.fastMode)
          // Same shape as set_model: the row is what a revival reads, and a
          // live subprocess is switched in place.
          await rt.live.get(row.id)?.setFastMode(row.fastMode)
          broadcastSessionList(rt)
          break
        }
        case 'set_permission_mode': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.permissionMode = msg.mode
          await rt.store.sessions.setPermissionMode(row.id, msg.mode)
          // Same shape as set_model: the row is the source of truth for a
          // revival, and a live subprocess is switched in place where it can
          // be. Where it cannot (arming a bypass needs a spawn-time flag), the
          // subprocess is retired so the next turn brings up one that can.
          const session = rt.live.get(row.id)
          if (session && !(await session.setPermissionMode(msg.mode))) session.stop()
          broadcastSessionList(rt)
          break
        }
        case 'rename_session': {
          const row = rt.rows.get(msg.sessionId)
          const title = msg.title.trim()
          // An empty title would leave a nameless row in the sidebar; the old
          // one stays instead.
          if (!row || !title) break
          row.title = title
          await rt.store.sessions.rename(row.id, title)
          broadcastSessionList(rt)
          break
        }
        case 'set_pinned': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.pinned = msg.pinned
          await rt.store.sessions.setPinned(row.id, msg.pinned)
          broadcastSessionList(rt)
          break
        }
        case 'delete_session': {
          if (!rt.rows.has(msg.sessionId)) break
          await deleteSession(rt, msg.sessionId)
          break
        }
        case 'subscribe': {
          if (!rt.rows.has(msg.sessionId)) {
            // a dry run streams under an ephemeral id; its transcript lives in memory
            const pv = rt.previews.get(msg.sessionId)
            if (pv) send(ws, { type: 'history', sessionId: msg.sessionId, events: pv.events })
            break
          }
          const events = await rt.store.events.read(msg.sessionId)
          send(ws, { type: 'history', sessionId: msg.sessionId, events: events.map((e) => e.event) })
          break
        }
        case 'user_message': {
          if (!msg.text.trim() && !msg.images?.length && !msg.mentions?.length) break
          const session = await getOrRevive(rt, msg.sessionId)
          void session?.sendUserMessage(msg.text.trim(), msg.images, msg.mentions)
          break
        }
        case 'permission_response': {
          rt.live.get(msg.sessionId)?.resolvePermission(msg.requestId, msg.behavior, msg.answers)
          break
        }
        case 'interrupt': {
          void rt.live.get(msg.sessionId)?.interrupt()
          break
        }
        case 'terminal_create': {
          const terminal = rt.terminals.create({
            cwd: msg.cwd ? expandHome(msg.cwd) : undefined,
            title: msg.title,
            command: msg.command,
            env: rt.env,
          })
          // The creator hears first so it can switch to the new tab; the list
          // broadcast (already sent by the manager) brings everyone else along.
          send(ws, { type: 'terminal_created', terminal })
          break
        }
        case 'terminal_input': {
          rt.terminals.write(msg.terminalId, msg.data)
          break
        }
        case 'terminal_resize': {
          rt.terminals.resize(msg.terminalId, msg.cols, msg.rows)
          break
        }
        case 'terminal_subscribe': {
          if (rt.terminals.get(msg.terminalId)) {
            send(ws, { type: 'terminal_history', terminalId: msg.terminalId, data: rt.terminals.history(msg.terminalId) })
          }
          break
        }
        case 'terminal_rename': {
          rt.terminals.rename(msg.terminalId, msg.title)
          break
        }
        case 'terminal_close': {
          rt.terminals.close(msg.terminalId)
          break
        }
      }
    } catch (err) {
      send(ws, { type: 'error', message: String(err) })
    }
  })

  ws.on('close', () => rt.clients.delete(ws))
})

// Boot: one runtime per registered workspace, each with its own store, seeds,
// cached snapshot, and background probes.
for (const meta of registry.workspaces) runtimes.set(meta.id, new WorkspaceRuntime(meta))
for (const rt of runtimes.values()) await initRuntime(rt)

// The wss wraps the http server and re-emits its errors, so the handler has
// to sit on both — an unhandled 'error' on either one crashes with a raw stack.
for (const emitter of [server, wss]) emitter.on('error', onListenError)
function onListenError(err: NodeJS.ErrnoException) {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `triage: port ${PORT} is already in use — \`triage status\` shows whether it's another triage; ` +
        `otherwise pick a port with \`triage --port ${PORT + 1}\``,
    )
    process.exit(1)
  }
  throw err
}
server.listen(PORT, () => {
  log('info', 'server', `triage v${VERSION} started on :${PORT} (${runtimes.size} workspace${runtimes.size === 1 ? '' : 's'}, default: ${registry.defaultId})`)
  // Record where we are so `triage stop/status` can find a --port server.
  writeState({ pid: process.pid, port: PORT, version: VERSION, startedAt: new Date().toISOString() }).catch(
    (err) => console.error('[state] could not write server.json:', err),
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('info', 'server', `received ${sig} — shutting down`)
    for (const rt of runtimes.values()) rt.terminals.killAll()
    clearState(process.pid).finally(() => process.exit(0))
  })
}
