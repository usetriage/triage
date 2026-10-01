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
import { mkdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { exec, execFile } from 'node:child_process'
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
  type McpServerConfig,
  type HookCallback,
  type McpServerStatus,
  type Options,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { currentBranch, filePatch, repoRoot, snapshotTree, treeDiff, treePatch, worktreeChanges, worktreePatch, type TreeChange } from './git.js'
import type {
  ClientMessage,
  RemoteStatus,
  Connector,
  ConnectorScope,
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
  ProjectChanges,
  ProjectFileResponse,
  SaveProjectFileResponse,
  WorkingChangesResponse,
  WorkingDiffResponse,
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
  ItemUrlsResponse,
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
  SaveTeamResponse,
  StartTeamResponse,
  TeamLibraryResponse,
  TeamMembership,
  TeamRunDetail,
  TeamRunInfo,
  TeamRunResponse,
  TeamStage,
  TeamStep,
  TaskCard,
  AgentCan,
} from '../shared/protocol.js'
import { DEFAULT_TEAM_BUDGET_USD } from '../shared/protocol.js'
import {
  MANAGER_DISALLOWED,
  TEAM_MESSAGE_BUDGET,
  TeamLibrary,
  agentAppend,
  agentFrom,
  checkRoster,
  disallowedFor,
  draftAgentFrom,
  frameTeamMessage,
  isLibraryName,
  managerAppend,
  managerFrom,
  budgetFrom,
  runSpent,
  builtinToolsFor,
  buildMessage,
  checkerMessage,
  detectChecks,
  fixMessage,
  MAX_FIX_ROUNDS,
  pipelineAgentAppend,
  pipelineManagerAppend,
  renderCard,
  reportMessage,
  isCheckCommand,
  type StoredTeamRun,
} from './teams.js'
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
import { decide, humanSpan, intervalOf, isCatchUpSpec, lookbackMs, parseCatchUp, scheduleOf, type SkipReason } from '../core/watch/schedule.js'
import { cronFromCadence, isValidCron } from '../core/watch/cron.js'
import {
  DEFAULT_WATCH_TIMEOUT_MS,
  MAX_WATCH_TIMEOUT_MS,
  WATCH_NOTIFY,
  WATCH_OUTPUTS,
  type NewWatch,
  type Watch,
  type WatchCadence,
  type WatchConnector,
  type WatchNotify,
  type WatchOutput,
  type WatchPreviewResult,
  type WatchPreviewRow,
  type WatchRunStatus,
  type WatchRunTrigger,
} from '../core/watch/types.js'
import { composeRunPrompt, MAX_ROWS_PER_RUN } from '../core/watch/connectors.js'
import {
  grantLabel,
  grantsFrom,
  grantsFromLegacy,
  mcpGrants,
  mcpToolName,
  presetGrant,
  RESERVED_SERVER,
  runAllowedTools,
  runBaseTools,
  serverLabel,
  type LegacyConnector,
  type WatchToolGrant,
} from '../core/watch/tools.js'
import { fenceDecision, fenceFor, type Fence } from '../core/watch/fence.js'
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
import { NgrokTunnel } from './tunnel.js'
import {
  accessOf,
  bonjourName,
  codesAllowed,
  lanAddresses,
  loadRemote,
  newToken,
  pairCookie,
  pairPageHtml,
  isLoopbackAddress,
  livePairCode,
  tryPairCode,
  type PairCode,
  sameOrigin,
  saveRemote,
  tokenMatches,
  type Access,
} from './remote.js'
import { launchAgentInstalled } from './launchd.js'
import { applyImageEdits, itemImageAttachments, readItemImage } from './itemImages.js'
import { FileIndexes, readProjectFile, resolveFileMention, writeProjectFile } from './files.js'
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
/** Phone access (server/remote.ts): off until switched on in Settings → Phone. */
let remote = loadRemote()
/** The 6-digit code Settings → Phone shows; memory only — a restart just mints another. */
let pairCode: PairCode | null = null
/** Phone access from anywhere — the user's ngrok, run while access and "Anywhere" are both on. */
const tunnel = new NgrokTunnel((): void => {
  const s = tunnel.status
  if (s.state === 'up') log('info', 'remote', `tunnel up at ${s.url}`)
  else if (s.state === 'error') log('warn', 'remote', `tunnel failed: ${s.error}`)
})
function syncTunnel() {
  if (remote.enabled && remote.tunnel) tunnel.start(PORT)
  else tunnel.stop()
}
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
const pExec = promisify(exec)

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
  readonly runQueue: QueuedRun[] = []
  readonly runningWatches = new Set<string>()
  /** in-flight and recently finished dry runs, by ephemeral session id (never persisted) */
  readonly previews = new Map<string, WatchPreview>()
  activeRuns = 0

  // probes
  connectorCache: ConnectorProbe | null = null
  connectorInFlight: Promise<ConnectorProbe> | null = null
  /** connector probes per project folder (its project + local MCP servers), for the watch picker */
  readonly folderProbes = new Map<string, ConnectorProbe>()
  readonly folderProbeInFlight = new Map<string, Promise<ConnectorProbe>>()
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

  // Teams (server/teams.ts): agents and teams are files; runs persist under `team_runs`.
  readonly teamLibrary: TeamLibrary
  readonly teamRuns = new Map<string, StoredTeamRun>()
  /** session id → its run and which member it is, mirrored from `teamRuns` */
  readonly sessionTeam = new Map<string, { runId: string; member: string }>()
  /** run id → messages between members since the user last spoke to the team */
  readonly teamMessages = new Map<string, number>()
  /** sessions whose next spawn starts a fresh Claude session (a checker's clean context) */
  readonly freshNext = new Set<string>()

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
    this.teamLibrary = new TeamLibrary(workspaceDir(meta.id))
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
type SessionExtras = {
  systemAppend?: string
  mcp?: Record<string, ReturnType<typeof createSdkMcpServer>>
  /** tools the subprocess never gets (a team role's policy) */
  disallowedTools?: string[]
  /** extra inline (flag-layer) settings, e.g. a team member's compaction window */
  settings?: Record<string, unknown>
  /** hard stop for this subprocess: the SDK ends the query past it (a team's remaining budget) */
  maxBudgetUsd?: number
  /** the only built-in tools the subprocess gets (a team member's lean toolset) */
  tools?: string[]
  /** load only the MCP servers passed here — none of the user's other connectors or plugins */
  strictMcpConfig?: boolean
  /** plain MCP server configs passed through (e.g. the user's chrome-devtools for a browser-allowed agent) */
  externalMcp?: Record<string, Record<string, unknown>>
}

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
  /** The subprocess's cumulative cost at its last result — turn cost is the difference. */
  private costSeen = 0
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
        mcpServers: {
          triage: rt.triageMcp(),
          ...(extras.mcp ?? {}),
          ...((extras.externalMcp ?? {}) as Record<string, McpServerConfig>),
        },
        ...(extras.tools ? { tools: extras.tools } : {}),
        ...(extras.strictMcpConfig ? { strictMcpConfig: true } : {}),
        ...(row.kind === 'brief' || extras.disallowedTools?.length
          ? { disallowedTools: [...(row.kind === 'brief' ? BRIEF_DISALLOWED_TOOLS : []), ...(extras.disallowedTools ?? [])] }
          : {}),
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
        ...(row.fastMode || extras.settings
          ? { settings: { ...(extras.settings ?? {}), ...(row.fastMode ? { fastMode: true } : {}) } }
          : {}),
        // A team member's backstop: the SDK stops the query mid-turn past it,
        // where our own accounting (per result) would only notice afterwards.
        ...(extras.maxBudgetUsd ? { maxBudgetUsd: extras.maxBudgetUsd } : {}),
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
          // Team spend: total_cost_usd is cumulative for this subprocess, so
          // the turn's cost is the difference from the last result it sent.
          if (this.rt.sessionTeam.has(this.row.id)) {
            const cost = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null
            const delta = cost === null ? 0 : Math.max(0, cost - this.costSeen)
            if (cost !== null) this.costSeen = cost
            void noteTeamSpend(this.rt, this.row.id, delta, m.subtype)
          }
        }
      }
      this.setStatus('idle')
    } catch (err) {
      this.emit({ kind: 'error', message: String(err) }, true)
      this.setStatus('error')
    } finally {
      // The subprocess is gone; any unanswered prompt can never be answered.
      this.expirePendingPermissions()
      // A fresh-context replacement may already hold the slot; only clear our own.
      if (this.rt.live.get(this.row.id) === this) this.rt.live.delete(this.row.id)
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

  /** A pending permission prompt is waiting on the user. */
  get waiting(): boolean {
    return this.pendingPermissions.size > 0
  }

  async sendUserMessage(text: string, images?: ImageAttachment[], mentions?: Mention[], opts: { from?: string } = {}) {
    // Mentions are resolved now, against this session's folder, so the event
    // log records what the model was actually given (and why a file wasn't).
    const attached = mentions?.length ? await resolveMentions(this.rt, this.row.cwd, mentions) : null
    // Before the agent can touch anything: the tree this turn starts from.
    await this.beginTurn()
    this.emit({ kind: 'local_user', text, images, mentions: attached?.resolved, ...(opts.from ? { from: opts.from } : {}) }, true)
    // The user speaking to any member resets the team's message budget.
    const team = this.rt.sessionTeam.get(this.row.id)
    if (team && !opts.from) this.rt.teamMessages.delete(team.runId)
    // A teammate's message is framed for the model; the transcript keeps the raw text and a badge.
    const modelText = opts.from && text ? frameTeamMessage(opts.from, text) : text
    this.setStatus('running')
    void this.rt.store.sessions.touch(this.row.id)
    // Images lead: the model reads them as context for the text that follows.
    // Attachments trail it, each in its own block, so the ask stays readable.
    const content = [
      ...(images ?? []).map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
      })),
      ...(modelText ? [{ type: 'text' as const, text: modelText }] : []),
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
    // Team members: talking to a teammate never prompts, and an agent that runs
    // commands but can't edit (a reviewer) runs read-only git/gh unattended.
    // (The manager has no shell at all — its disallowed tools, since the user's
    // own allow rules skip this gate.)
    const team = this.rt.sessionTeam.get(this.row.id)
    if (team) {
      // triage's own team tools (messaging, the stage submissions) never prompt — they only record and route.
      if (toolName.startsWith('mcp__team__')) return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
      const run = this.rt.teamRuns.get(team.runId)
      const agent = run?.agents.find((a) => a.name === team.member)
      if (agent && !agent.can.includes('edit') && toolName === 'Bash' && briefBashAllowed(toolInput)) {
        return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
      }
      // The project's own checks (the same commands the checks stage runs) never need a click.
      if (agent?.can.includes('run') && toolName === 'Bash' && run?.checkCmds && isCheckCommand(String(toolInput.command ?? ''), run.checkCmds)) {
        return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
      }
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
      if (this.pendingPermissions.size === 1) broadcastSessionList(this.rt)
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
    if (this.pendingPermissions.size === 0) broadcastSessionList(this.rt)
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

  /** Write a line of triage's own into this transcript (a team paused, a stage began). */
  notice(text: string) {
    this.emit({ kind: 'notice', text }, true)
  }

  private emit(event: SessionEvent, persist: boolean) {
    if (persist) {
      this.seq += 1
      this.rt.store.events.append(this.row.id, this.seq, event).catch((err) => {
        log('error', 'session', `failed to persist event for ${this.row.id}: ${err}`)
      })
    }
    broadcast(this.rt, { type: 'session_event', sessionId: this.row.id, event, at: Date.now() })
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
    ...(teamMembership(rt, row.id) ? { team: teamMembership(rt, row.id) } : {}),
    ...(l?.waiting ? { waiting: true } : {}),
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
  const team = rt.sessionTeam.get(sessionId)
  if (team) {
    rt.sessionTeam.delete(sessionId)
    const run = rt.teamRuns.get(team.runId)
    if (run) {
      run.members = run.members.filter((m) => m.sessionId !== sessionId)
      if (!run.members.length) rt.teamRuns.delete(run.id)
      await saveTeamRuns(rt)
    }
  }
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
/** One project's uncommitted work, for the Changes rail. Never throws: a broken repo is a row, not a 500. */
async function projectChanges(project: Project): Promise<ProjectChanges> {
  const empty: ProjectChanges = { project, isRepo: false, branch: null, files: [], insertions: 0, deletions: 0 }
  if (!(await repoRoot(project.path))) return empty
  try {
    const [files, branch] = await Promise.all([worktreeChanges(project.path), currentBranch(project.path)])
    return {
      ...empty,
      isRepo: true,
      branch,
      files,
      insertions: files.reduce((n, f) => n + f.insertions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    }
  } catch (err) {
    return { ...empty, isRepo: true, error: errText(err) }
  }
}

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
  opts: { kind?: SessionKind; spawn?: boolean } = {},
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
  // spawn: false = a row only; the first message starts it (getOrRevive).
  if (opts.spawn !== false) rt.live.set(row.id, new LiveSession(rt, row, 0, null, extrasFor(rt, row)))
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
        item.urls?.length ? `links: ${item.urls.join(', ')}` : undefined,
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
  // A fresh start: end the old subprocess and begin a new Claude session instead
  // of resuming — the transcript page continues, the model's history doesn't.
  const fresh = rt.freshNext.delete(sessionId)
  const existing = rt.live.get(sessionId)
  if (existing && !fresh) return existing
  const row = rt.rows.get(sessionId)
  if (!row) return null
  if (existing) existing.stop()
  const lastSeq = await rt.store.events.lastSeq(row.id)
  const revived = new LiveSession(rt, row, lastSeq, fresh ? null : row.sdkSessionId, extrasFor(rt, row))
  rt.live.set(row.id, revived)
  if (fresh && row.sdkSessionId) revived.notice('fresh context — this member starts from the brief, not its earlier history')
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
const WATCH_TIMEOUT_KEY = 'watches.defaultTimeoutMs'
const WATCH_BUDGET_KEY = 'watches.defaultBudgetUsd'
const FOLDER_PROBE_TTL_MS = 10 * 60_000

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
  const grace = 2 * (intervalOf(scheduleOf(w), now) ?? 86_400_000) + 3_600_000
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
      failing: enabled.filter((w) => w.lastRunStatus === 'failed' || w.lastRunStatus === 'timeout').length,
      configErrors: watches.filter((w) => w.configError).length,
    },
    launchAgent: launchAgentInstalled(),
    logDir: logFilePath(),
  }
}

/** One run waiting for a slot in the queue. Waiting keeps its slot: the due
 * rule's clock only moves when the run actually starts. */
type QueuedRun = { id: string; trigger: WatchRunTrigger; slot: number }

/**
 * Is every MCP server this watch uses up, per the latest probes? Only a server
 * the probe positively reports broken (needs auth, failed, disabled) blocks a
 * run — a server missing from a stale probe gets the benefit of the doubt, and
 * a run that truly can't reach it fails loudly with no-connector-tools.
 */
function watchReady(rt: WorkspaceRuntime, w: Watch, project: Project | null): true | string {
  const probes = [rt.connectorCache, project ? rt.folderProbes.get(project.path) : undefined].filter(
    (p): p is ConnectorProbe => p != null,
  )
  if (!probes.length) return true
  for (const g of mcpGrants(w.tools)) {
    const found = probes.flatMap((p) => p.connectors).find((c) => c.server === g.source.server)
    if (found && (found.status === 'needs-auth' || found.status === 'failed' || found.status === 'disabled')) {
      return `${serverLabel(g.source.server)} ${found.status}`
    }
  }
  return true
}

const SKIP_TEXT: Record<SkipReason, string> = {
  overlap: 'previous run still in progress',
  window: 'missed slot older than the catch-up window',
  connector: 'a connector is not available',
}

/** Record a skipped slot as a run receipt and move the due rule's clock. */
async function recordSkip(rt: WorkspaceRuntime, w: Watch, reason: SkipReason, detail?: string): Promise<void> {
  const now = Date.now()
  await rt.store.watches.markRunStarted(w.id, { startedAt: now })
  const error = `skipped (${reason}): ${detail ?? SKIP_TEXT[reason]}`
  await rt.store.watches.recordRun(w.id, { lastRunAt: now, lastRunTokens: 0, lastRunMatches: 0, status: 'skipped', error })
  log('warn', 'scheduler', `${w.title}: ${error}`, { watchId: w.id, reason, workspace: rt.meta.id })
}

/**
 * The scheduler tick for one workspace (watch-spec.md, item 3): decide per
 * watch, record skips, queue due runs oldest slot first.
 */
async function runDueWatches(rt: WorkspaceRuntime, now = Date.now()): Promise<void> {
  // The global switch (Settings → Sources) — off means the scheduler never runs a watch.
  if (!(await watchesEnabled(rt))) return
  const projects = await rt.store.projects.list()
  for (const w of await rt.store.watches.list()) {
    if (!w.enabled || w.configError) continue
    if (rt.runQueue.some((q) => q.id === w.id)) continue // waiting already; keeps its slot
    const project = projects.find((p) => p.id === w.projectId) ?? null
    const d = decide({
      schedule: scheduleOf(w),
      lastRunStartedAt: w.lastRunStartedAt,
      now,
      tickMs: SCHEDULER_TICK_MS,
      running: rt.runningWatches.has(w.id),
      ready: watchReady(rt, w, project),
      catchUp: parseCatchUp(w.catchUpWindow, w.output),
    })
    if (d.action === 'idle') continue
    if (d.action === 'skip') {
      await recordSkip(rt, w, d.reason, d.detail)
      continue
    }
    rt.runQueue.push({ id: w.id, trigger: d.trigger, slot: d.slot })
  }
  pumpRunQueue(rt)
}

/**
 * Queue a single watch to run now (the per-watch "Run" button — a manual run,
 * independent of the schedule). Respects the in-flight guard so a double-click
 * can't start two runs of the same watch.
 */
function enqueueWatch(rt: WorkspaceRuntime, id: string): 'queued' | 'running' {
  if (rt.runningWatches.has(id)) return 'running'
  if (!rt.runQueue.some((q) => q.id === id)) rt.runQueue.push({ id, trigger: 'manual', slot: Date.now() })
  pumpRunQueue(rt)
  return 'queued'
}

function pumpRunQueue(rt: WorkspaceRuntime): void {
  // oldest slot first, as wakecron does; the rest keep their slot for later
  rt.runQueue.sort((a, b) => a.slot - b.slot)
  while (rt.activeRuns < WATCH_CONCURRENCY && rt.runQueue.length > 0) {
    const run = rt.runQueue.shift()!
    if (rt.runningWatches.has(run.id)) continue
    rt.runningWatches.add(run.id)
    rt.activeRuns += 1
    // The due rule's clock moves when the run starts — now, not after the
    // jitter — so a tick in between can't see a stale slot and skip it.
    const startedAt = Date.now()
    void rt.store.watches.markRunStarted(run.id, { startedAt, trigger: run.trigger })
    const jitter = run.trigger === 'manual' ? 0 : Math.floor(Math.random() * 3_000)
    setTimeout(() => {
      runWatch(rt, run, startedAt)
        .catch((err) => log('error', 'watch', `run crashed: ${err}`, { workspace: rt.meta.id }))
        .finally(() => {
          rt.activeRuns -= 1
          rt.runningWatches.delete(run.id)
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
function makeScanMcp(rt: WorkspaceRuntime, watch: Watch, runId: string, onUpsert: (outcome: UpsertOutcome) => void) {
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
            const { outcome, reopened } = await rt.store.items.upsert(item, prov)
            onUpsert(outcome)
            rt.inboxCache = null
            log('info', 'watch', `filed (${outcome}): ${item.title}`, {
              id: item.id,
              watchId: watch.id,
              runId,
              place: item.repo,
              outcome,
              workspace: rt.meta.id,
            })
            // Stateless runs need to hear about repeats (watch-spec.md, item 4).
            if (outcome === 'inserted') return okResult(`new: filed ${item.id}`)
            if (reopened) return okResult(`already filed; it was done and has returned to the inbox: ${item.id}`)
            const status = (await rt.store.items.get(item.id))?.status ?? 'open'
            return okResult(
              status === 'open'
                ? `already filed and open: ${item.id}. Do not count it as new; move on to the next candidate.`
                : `already filed, ${status}: ${item.id}`,
            )
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
function makeDigestMcp(rt: WorkspaceRuntime, watch: Watch, runId: string, onWrite: (outcome: UpsertOutcome) => void) {
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
            onWrite(outcome)
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

/** What a run (real or dry) is made of: the watch as saved, or the form as it stands. */
type RunSpec = {
  instruction: string
  tools: WatchToolGrant[]
  project: Project
  model?: string
  output: WatchOutput
  schedule: string
  scope?: string
}

type PreviewSpec = Omit<RunSpec, 'project'> & { projectId: string }

// ---------------------------------------------------------------------------
// Folder MCP servers (watch-spec.md, item 1): the `project` servers in a
// folder's .mcp.json and the user's private `local` servers for that folder
// (in Claude's own config). Read by triage and passed explicitly — never by
// loading the project's settings, which would also load its hooks, and hooks
// are shell commands that would run unattended.
// ---------------------------------------------------------------------------

type FolderMcp = { servers: Record<string, McpServerConfig>; scopes: Map<string, 'project' | 'local'> }

/** `${VAR}` / `${VAR:-default}` in .mcp.json strings, from the run's environment. */
function expandEnv(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === 'string') return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k: string, d?: string) => env[k] ?? d ?? '')
  if (Array.isArray(v)) return v.map((x) => expandEnv(x, env))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x, env)]))
  return v
}

async function readJsonFile(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function folderMcpServers(rt: WorkspaceRuntime, cwd: string): Promise<FolderMcp> {
  const env = { ...process.env, ...(rt.env ?? {}) }
  const out: FolderMcp = { servers: {}, scopes: new Map() }
  const add = (raw: unknown, scope: 'project' | 'local') => {
    if (!raw || typeof raw !== 'object') return
    for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) {
      if (!cfg || typeof cfg !== 'object') continue
      out.servers[name] = expandEnv(cfg, env) as McpServerConfig
      out.scopes.set(name, scope)
    }
  }
  const project = await readJsonFile(path.join(cwd, '.mcp.json'))
  add(project?.mcpServers, 'project')
  const configDir = rt.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  const claudeJson = await readJsonFile(configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json'))
  const perFolder = (claudeJson?.projects as Record<string, { mcpServers?: unknown }> | undefined)?.[cwd]
  add(perFolder?.mcpServers, 'local') // private per-folder servers win over the shared file, as in Claude Code
  delete out.servers.triage // our own in-process server owns that name
  return out
}

/**
 * Local-scope MCP servers the user configured for other folders (names only,
 * never their config). A watch runs in one folder, so these aren't usable
 * here — but listing them tells the user which project to pick instead.
 */
async function localServersElsewhere(rt: WorkspaceRuntime, cwd: string, here: Connector[]): Promise<Array<{ name: string; folder: string }>> {
  const configDir = rt.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  const claudeJson = await readJsonFile(configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json'))
  const projects = (claudeJson?.projects ?? {}) as Record<string, { mcpServers?: Record<string, unknown> }>
  const have = new Set(here.map((c) => c.server))
  const out: Array<{ name: string; folder: string }> = []
  for (const [folder, p] of Object.entries(projects)) {
    if (folder === cwd || !p?.mcpServers || typeof p.mcpServers !== 'object') continue
    for (const name of Object.keys(p.mcpServers)) if (!have.has(name)) out.push({ name, folder })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.folder.localeCompare(b.folder))
}

/** A PreToolUse hook: the fence, deciding every tool call the run makes. */
function fenceHook(fence: Fence): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const d = fenceDecision(fence, input.tool_name, input.tool_input)
    if (d.allow) return {}
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } }
  }
}

/** The workspace's default run limits, under a watch's own. */
async function watchLimits(rt: WorkspaceRuntime, w: { timeoutMs?: number; maxBudgetUsd?: number }): Promise<{ timeoutMs: number; maxBudgetUsd?: number }> {
  const s = await readSettings(rt)
  const budget = w.maxBudgetUsd ?? s.watchBudgetUsd ?? undefined
  return { timeoutMs: w.timeoutMs ?? s.watchTimeoutMs, ...(budget != null ? { maxBudgetUsd: budget } : {}) }
}

/**
 * The prompt and SDK options every watch run shares, real or dry. Same prompt,
 * same fence: built-in tools limited to what the grants need, the allowlist so
 * granted tools never prompt, `dontAsk` so nothing else ever does, and the
 * PreToolUse fence so nothing else ever runs — whatever the user's own global
 * allow rules say. Runs work in the project folder and nowhere else.
 */
async function watchQuery(
  rt: WorkspaceRuntime,
  spec: RunSpec,
  triage: McpServerConfig,
  abort: AbortController,
  extra: { maxBudgetUsd?: number; includePartialMessages?: boolean } = {},
): Promise<{ prompt: string; options: Options }> {
  const folder = await folderMcpServers(rt, spec.project.path)
  const granted = new Set(mcpGrants(spec.tools).map((g) => g.source.server))
  const folderServers = Object.fromEntries(Object.entries(folder.servers).filter(([name]) => granted.has(name)))
  // Servers the user has connected but this watch wasn't granted still load
  // from their settings; take their tools out of the run's context entirely
  // (the fence would deny them anyway). Known from the latest probes.
  // A run right after boot can beat the first probe; wait for it (a few seconds, no API turn).
  const home = rt.connectorCache ?? (await probeConnectors(rt).catch(() => null))
  const known = [...(rt.folderProbes.get(spec.project.path)?.connectors ?? []), ...(home?.connectors ?? [])]
  const ungranted = [...new Set(known.map((c) => c.server))].filter((srv) => !granted.has(srv) && srv !== RESERVED_SERVER)
  const disallowedTools = ungranted.map((srv) => mcpToolName(srv, '').replace(/__$/, ''))
  const now = Date.now()
  const prompt = composeRunPrompt({
    instruction: spec.instruction,
    tools: spec.tools,
    project: { name: spec.project.name, path: spec.project.path },
    output: spec.output,
    lookbackMs: lookbackMs(spec.schedule, now),
    nowIso: new Date(now).toISOString(),
    ...(spec.scope ? { scope: spec.scope } : {}),
  })
  const options: Options = {
    cwd: spec.project.path,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user'],
    tools: runBaseTools(spec.tools),
    allowedTools: runAllowedTools(spec.tools, spec.output),
    ...(disallowedTools.length ? { disallowedTools } : {}),
    permissionMode: 'dontAsk',
    hooks: { PreToolUse: [{ hooks: [fenceHook(fenceFor(spec.tools, spec.output, spec.project.path))] }] },
    ...(spec.model ? { model: spec.model } : {}),
    ...(extra.maxBudgetUsd != null ? { maxBudgetUsd: extra.maxBudgetUsd } : {}),
    ...(extra.includePartialMessages ? { includePartialMessages: true } : {}),
    mcpServers: { ...folderServers, triage },
    abortController: abort,
    ...(rt.env ? { env: rt.env } : {}),
  }
  return { prompt, options }
}

/** The project a watch runs in, checked: a removed project or a missing folder is an error, never a fallback. */
async function watchProject(rt: WorkspaceRuntime, projectId: string): Promise<Project> {
  const project = (await rt.store.projects.list()).find((p) => p.id === projectId)
  if (!project) throw new Error('project removed — pick another project for this watch')
  const st = await stat(project.path).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`folder not found: ${project.path}`)
  return project
}

const noConnectorError = (tools: WatchToolGrant[]) =>
  `no connector tools — connect ${tools.map(grantLabel).join(', ')} for Claude (claude.ai/settings/connectors, or the project's MCP config)`

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
    broadcast(rt, { type: 'session_event', sessionId: pv.id, event, at: Date.now() })
  }
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
              if (rows.some((r) => r.id === ident.id)) return okResult(`already filed and open: ${ident.id}. Do not count it as new; move on to the next candidate.`)
              const existing = await rt.store.items.get(ident.id).catch(() => null)
              rows.push({
                id: ident.id,
                title: args.title,
                url: ident.url,
                place: args.place?.trim() || ident.home,
                from: args.from ?? '',
                lastActivity: safeWhen(args.lastActivity, Date.now()),
                why: args.why,
              })
              return okResult(existing ? `already filed, ${existing.status}: ${ident.id}` : `new: filed ${ident.id}`)
            }),
          ],
  })
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let tokens = 0
  let costUsd: number | undefined
  let resultText = ''
  let sawResult = false
  try {
    const project = await watchProject(rt, spec.projectId)
    const limits = await watchLimits(rt, {})
    timer = setTimeout(() => abort.abort(), limits.timeoutMs)
    const { prompt, options } = await watchQuery(rt, { ...spec, project }, collector, abort, { ...limits, includePartialMessages: true })
    const q = query({ prompt, options })
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
    if (resultText.includes('no-connector-tools')) throw new Error(noConnectorError(spec.tools))
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
    if (timer) clearTimeout(timer)
    setTimeout(() => rt.previews.delete(pv.id), PREVIEW_TTL_MS).unref()
  }
}

/** A macOS notification about a finished run, per the watch's notify setting. */
function notifyRun(rt: WorkspaceRuntime, w: Watch, status: WatchRunStatus, detail?: string): void {
  if (process.platform !== 'darwin' || w.notify === 'never') return
  const failed = status === 'failed' || status === 'timeout'
  if (w.notify === 'on_failure' && !failed) return
  if (!failed && status !== 'ok') return
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const text = failed ? `${w.title} ${status === 'timeout' ? 'timed out' : 'failed'}${detail ? `: ${detail.slice(0, 120)}` : ''}` : `${w.title}: ${detail ?? 'ok'}`
  execFile('osascript', ['-e', `display notification ${q(text)} with title ${q('triage')}`], (err) => {
    if (err) log('warn', 'watch', `notification failed: ${err.message}`, { watchId: w.id, workspace: rt.meta.id })
  })
}

/**
 * Run one watch to completion as a headless session. Persists the transcript to
 * the event log (so it is observable like any session) and records the run's
 * receipt on the watch row and its own session row. Stateless (watch-spec.md,
 * item 4): nothing from this run feeds the next one's prompt.
 */
async function runWatch(rt: WorkspaceRuntime, run: QueuedRun, startedMs: number): Promise<void> {
  const watch = await rt.store.watches.get(run.id)
  if (!watch) return
  const projectRow = (await rt.store.projects.list()).find((p) => p.id === watch.projectId) ?? null
  if (!projectRow) {
    // The project went away: pause with a config error, never fall back to another folder.
    await rt.store.watches.patchState(watch.id, { enabled: false, configError: 'project removed — pick another project for this watch' })
    await rt.store.watches.recordRun(watch.id, { lastRunAt: Date.now(), lastRunTokens: 0, lastRunMatches: 0, status: 'skipped', trigger: run.trigger, error: 'skipped: the watch has no project' })
    log('warn', 'watch', `paused ${watch.title}: its project was removed`, { watchId: watch.id, workspace: rt.meta.id })
    return
  }
  const session = await rt.store.sessions.create({
    id: randomUUID(),
    title: `Watch · ${watch.title}`,
    cwd: projectRow.path,
    kind: 'watch-run',
    watchId: watch.id,
    runTrigger: run.trigger,
  })
  rt.rows.set(session.id, session)
  await rt.store.watches.markRunStarted(watch.id, { startedAt: startedMs, trigger: run.trigger, sessionId: session.id })
  broadcastSessionList(rt)
  log('info', 'watch', `run started: ${watch.title} (${run.trigger})`, { watchId: watch.id, runId: session.id, tools: watch.tools.map(grantLabel), project: projectRow.name, model: watch.model, workspace: rt.meta.id })

  let seq = 0
  const emit = (event: SessionEvent, persist = true) => {
    if (persist) {
      seq += 1
      rt.store.events.append(session.id, seq, event).catch(() => {})
    }
    broadcast(rt, { type: 'session_event', sessionId: session.id, event })
  }

  let matches = 0
  let newCount = 0
  let tokens = 0
  let costUsd: number | undefined
  let status: WatchRunStatus = 'failed'
  let error: string | undefined
  let timedOut = false
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const scanMcp = makeScanMcp(rt, watch, session.id, (outcome) => {
    matches += 1
    if (outcome === 'inserted') newCount += 1
  })

  try {
    const project = await watchProject(rt, watch.projectId)
    const limits = await watchLimits(rt, watch)
    timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, limits.timeoutMs)
    const { prompt, options } = await watchQuery(
      rt,
      { instruction: watch.instruction, tools: watch.tools, project, model: watch.model, output: watch.output, schedule: scheduleOf(watch), scope: watch.scope },
      scanMcp,
      abort,
      limits,
    )
    const q = query({ prompt, options })
    let sawResult = false
    let resultText = ''
    let resultSubtype = ''
    for await (const msg of q) {
      const m = msg as unknown as SdkMessage & { result?: string; subtype?: string; usage?: Record<string, unknown>; total_cost_usd?: unknown }
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
        session.sdkSessionId = m.session_id
        rt.store.sessions.setSdkSessionId(session.id, m.session_id).catch(() => {})
      }
      emit({ kind: 'sdk', message: m as SdkMessage }, m.type !== 'stream_event')
      if (m.type === 'result') {
        sawResult = true
        resultText = typeof m.result === 'string' ? m.result : ''
        resultSubtype = typeof m.subtype === 'string' ? m.subtype : ''
        tokens = sumTokens(m.usage)
        if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd
      }
    }
    if (resultSubtype === 'error_max_budget_usd') throw new Error(`budget cap reached ($${limits.maxBudgetUsd?.toFixed(2)})`)
    if (resultText.includes('no-connector-tools') || resultText.includes('no-slack-tools')) throw new Error(noConnectorError(watch.tools))
    if (!sawResult) throw new Error('scan ended without a result')
    status = 'ok'
  } catch (err) {
    if (timedOut) {
      status = 'timeout'
      error = `timed out after ${humanSpan((await watchLimits(rt, watch)).timeoutMs)}`
    } else {
      error = err instanceof Error ? err.message : String(err)
    }
    emit({ kind: 'error', message: error })
  } finally {
    if (timer) clearTimeout(timer)
    await rt.store.watches.recordRun(watch.id, {
      lastRunAt: Date.now(),
      lastRunTokens: tokens,
      lastRunMatches: matches,
      lastRunNew: newCount,
      status,
      trigger: run.trigger,
      sessionId: session.id,
      error,
    })
    // the run's own receipt, on its session row — powers the Activity view
    session.runStatus = status
    session.runMatches = matches
    session.runNew = newCount
    session.runTokens = tokens
    session.runCostUsd = costUsd
    session.runError = error
    session.updatedAt = Date.now()
    await rt.store.sessions.recordWatchRun(session.id, { status, matches, newCount, tokens, costUsd, error })
    log(
      status === 'ok' ? 'info' : 'error',
      'watch',
      `run ${status}: ${watch.title}${status === 'ok' ? ` — ${newCount} new, ${matches - newCount} already filed, ${Math.round(tokens / 1000)}k tok${costUsd != null ? `, $${costUsd.toFixed(2)}` : ''}` : ''}${error ? ` — ${error}` : ''}`,
      { watchId: watch.id, runId: session.id, status, trigger: run.trigger, matches, newCount, tokens, durationMs: Date.now() - startedMs, workspace: rt.meta.id, ...(error ? { error } : {}) },
    )
    notifyRun(rt, watch, status, status === 'ok' ? `${newCount} new` : error)
    if (status === 'ok') {
      rt.inboxCache = null
      void syncInbox(rt)
    }
    broadcastSessionList(rt)
  }
}

/**
 * Boot: a watch run still without a final status died with the previous
 * process. Mark it interrupted — on its session and, when it was the watch's
 * latest run, on the watch — instead of leaving it "running" forever. No
 * retry: the next run's look-back window overlaps the lost one.
 */
async function markInterruptedRuns(rt: WorkspaceRuntime): Promise<void> {
  const error = 'interrupted: triage stopped during the run'
  for (const row of rt.rows.values()) {
    if (row.kind !== 'watch-run' || row.runStatus) continue
    const events = await rt.store.events.read(row.id)
    const seq = events.length ? events[events.length - 1].seq : 0
    await rt.store.events.append(row.id, seq + 1, { kind: 'error', message: error })
    await rt.store.sessions.recordWatchRun(row.id, { status: 'interrupted', matches: row.runMatches ?? 0, tokens: row.runTokens ?? 0, error })
    row.runStatus = 'interrupted'
    row.runError = error
    const w = row.watchId ? await rt.store.watches.get(row.watchId) : null
    if (w && w.lastRunSessionId === row.id) {
      await rt.store.watches.recordRun(w.id, { lastRunAt: row.updatedAt, lastRunTokens: 0, lastRunMatches: 0, status: 'interrupted', sessionId: row.id, error })
    }
    log('warn', 'watch', `marked interrupted: ${row.title}`, { runId: row.id, watchId: row.watchId, workspace: rt.meta.id })
  }
}

/**
 * Pre-installed watch templates (.docs/watches-v2.md): the old built-in Slack
 * rules, shipped as data and seeded as editable copies on first run. A user can
 * disable, edit, or duplicate them; a `templateId` marks the origin.
 */
const WATCH_TEMPLATES: Array<
  Pick<Watch, 'title' | 'instruction' | 'schedule' | 'cadence' | 'createsItems' | 'tools'> & { templateId: string }
> = [
  {
    templateId: 'unread-dms',
    title: 'Unread DMs',
    tools: [presetGrant('claude.ai Slack')!],
    instruction: 'Look through my unread Slack direct messages. File each unanswered one that asks something of me.',
    schedule: '0 * * * *',
    cadence: 'hourly',
    createsItems: true,
  },
  {
    templateId: 'mentions',
    title: 'Mentions',
    tools: [presetGrant('claude.ai Slack')!],
    instruction: 'Find Slack messages where I am mentioned or tagged and my reply is still awaited. File each one.',
    schedule: '0 * * * *',
    cadence: 'hourly',
    createsItems: true,
  },
]

const NEEDS_PROJECT = 'pick the project this watch runs in'

/**
 * Every watch runs in a project folder (watch-spec.md, item 2) and there is no
 * fallback folder. A watch without one — saved before the rule, its project
 * since removed, or left in the retired scratch project — pauses with a config
 * error until the user picks a project. It never runs somewhere else.
 */
async function migrateWatchProjects(rt: WorkspaceRuntime): Promise<void> {
  // Retire the scratch projects a dev build created, and their folders if still empty.
  for (const p of await rt.store.projects.retireBuiltin()) {
    await rmdir(p.path).catch(() => {}) // only succeeds on an empty folder
    log('info', 'watch', `removed the retired scratch project ${p.path}`, { workspace: rt.meta.id })
  }
  const projects = await rt.store.projects.list()
  for (const w of await rt.store.watches.list()) {
    if (w.projectId && projects.some((p) => p.id === w.projectId)) continue
    if (w.configError && !w.enabled) continue
    await rt.store.watches.patchState(w.id, { projectId: null, enabled: false, configError: NEEDS_PROJECT })
    log('info', 'watch', `paused "${w.title}": it has no project — pick one to run it`, { watchId: w.id, workspace: rt.meta.id })
  }
}

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
        tools: t.tools,
        // Templates can't guess a folder: they arrive paused, asking for a project.
        projectId: '',
        configError: NEEDS_PROJECT,
        output: 'items',
        notify: 'on_failure',
        consecutiveFailures: 0,
        instruction: t.instruction,
        schedule: t.schedule,
        cadence: t.cadence,
        createsItems: t.createsItems,
        enabled: false,
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

const SCOPES: ConnectorScope[] = ['claudeai', 'user', 'local', 'project', 'plugin', 'managed']

/** One server as the SDK reports it → our Connector, tools and all (watch-spec.md, item 1). */
function toConnector(srv: McpServerStatus, scopeOverride?: ConnectorScope): Connector {
  const claudeAi = srv.name.startsWith(CLAUDE_AI_PREFIX)
  const scope: ConnectorScope =
    scopeOverride ?? (claudeAi ? 'claudeai' : SCOPES.includes(srv.scope as ConnectorScope) ? (srv.scope as ConnectorScope) : 'unknown')
  return {
    name: claudeAi ? srv.name.slice(CLAUDE_AI_PREFIX.length) : srv.name,
    server: srv.name,
    status: srv.status,
    source: claudeAi ? 'claude.ai' : 'local',
    scope,
    ...(srv.error ? { error: srv.error } : {}),
    tools: (srv.tools ?? []).map((t) => {
      const full = t.name.startsWith('mcp__') ? t.name : mcpToolName(srv.name, t.name)
      return {
        name: full.slice(full.lastIndexOf('__') + 2),
        fullName: full,
        ...(t.description ? { description: t.description.slice(0, 400) } : {}),
        ...(t.annotations?.readOnly !== undefined ? { readOnly: t.annotations.readOnly } : {}),
        ...(t.annotations?.destructive !== undefined ? { destructive: t.annotations.destructive } : {}),
      }
    }),
  }
}

/**
 * Probe which MCP servers connect. With no folder: the user-level view
 * (Settings), from the home folder. With a folder: exactly what a watch run in
 * that folder loads — the user's servers plus the folder's project and local
 * servers, passed explicitly (never by loading the project's settings/hooks).
 */
function probeConnectors(rt: WorkspaceRuntime, cwd?: string): Promise<ConnectorProbe> {
  // Concurrent requests share one probe — a probe is a whole subprocess.
  const inFlight = cwd ? rt.folderProbeInFlight.get(cwd) : rt.connectorInFlight
  if (inFlight) return inFlight
  const run = (async () => {
    const input = new AsyncQueue<SDKUserMessage>()
    const folder = cwd ? await folderMcpServers(rt, cwd) : null
    const q = query({
      prompt: input,
      options: cwd
        ? {
            cwd,
            systemPrompt: { type: 'preset', preset: 'claude_code' },
            settingSources: ['user'],
            mcpServers: folder!.servers,
            ...(rt.env ? { env: rt.env } : {}),
          }
        : {
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
        .map((srv) => toConnector(srv, folder?.scopes.get(srv.name)))
        .sort((a, b) => a.name.localeCompare(b.name))
      const probe: ConnectorProbe = { probedAt: Date.now(), connectors }
      if (cwd) rt.folderProbes.set(cwd, probe)
      else rt.connectorCache = probe
      log('info', 'connectors', `probed${cwd ? ` ${cwd}` : ''}: ${connectors.length} server(s), ${connectors.filter((c) => c.status === 'connected').length} connected`, { workspace: rt.meta.id })
      return probe
    } finally {
      input.close()
      void q.return(undefined).catch(() => {}) // dispose the subprocess
      if (cwd) rt.folderProbeInFlight.delete(cwd)
      else rt.connectorInFlight = null
    }
  })()
  if (cwd) rt.folderProbeInFlight.set(cwd, run)
  else rt.connectorInFlight = run
  return run
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
  await markInterruptedRuns(rt)
  await migrateWatchProjects(rt)
  // Watches are off by default in 0.7 (.docs/next-version.md); seeding follows the switch.
  if (await watchesEnabled(rt)) await seedWatchTemplates(rt)
  await bootBriefs(rt)
  await rt.teamLibrary.seed().catch((err) => log('error', 'teams', `could not seed agents and teams: ${err}`, { workspace: rt.meta.id }))
  await loadTeamRuns(rt)
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
const MAX_URLS_PER_ITEM = 20

type WatchPatch = Partial<NewWatch> & { enabled?: boolean; runOnceNow?: boolean }

const LEGACY_CONNECTORS: LegacyConnector[] = ['web', 'slack', 'linear', 'github']

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
  if (r.tools !== undefined) {
    const parsed = grantsFrom(r.tools)
    if ('error' in parsed) return { error: parsed.error }
    patch.tools = parsed.grants
  } else if (r.connectors !== undefined) {
    // legacy clients: the four fixed integrations → grants
    if (!Array.isArray(r.connectors) || r.connectors.length === 0 || !r.connectors.every((c) => LEGACY_CONNECTORS.includes(c as LegacyConnector))) {
      return { error: `connectors must be a non-empty list of: ${LEGACY_CONNECTORS.join(', ')}` }
    }
    patch.tools = grantsFromLegacy([...new Set(r.connectors as LegacyConnector[])])
  }
  if (r.projectId !== undefined) {
    // required: every watch runs in a project folder (watch-spec.md, item 2)
    if (typeof r.projectId !== 'string' || !r.projectId) return { error: 'projectId is required — pick the project this watch runs in' }
    patch.projectId = r.projectId
  }
  if (r.catchUpWindow !== undefined) {
    if (r.catchUpWindow !== null && !isCatchUpSpec(r.catchUpWindow)) return { error: 'catchUpWindow must be "never", "unlimited", or a duration like "6h", or null' }
    patch.catchUpWindow = r.catchUpWindow as string | null
  }
  if (r.timeoutMs !== undefined) {
    const t = r.timeoutMs
    if (t !== null && (typeof t !== 'number' || !Number.isInteger(t) || t < 30_000 || t > MAX_WATCH_TIMEOUT_MS)) {
      return { error: `timeoutMs must be null or whole milliseconds from 30000 to ${MAX_WATCH_TIMEOUT_MS}` }
    }
    patch.timeoutMs = t as number | null
  }
  if (r.maxBudgetUsd !== undefined) {
    const b = r.maxBudgetUsd
    if (b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 100)) return { error: 'maxBudgetUsd must be null or dollars from 0.01 to 100' }
    patch.maxBudgetUsd = b as number | null
  }
  if (r.notify !== undefined) {
    if (!WATCH_NOTIFY.includes(r.notify as WatchNotify)) return { error: `notify must be one of: ${WATCH_NOTIFY.join(', ')}` }
    patch.notify = r.notify as WatchNotify
  }
  if (r.runOnceNow !== undefined) {
    if (typeof r.runOnceNow !== 'boolean') return { error: 'runOnceNow must be a boolean' }
    patch.runOnceNow = r.runOnceNow
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
  const urls = itemUrls(r.urls)
  if (urls) input.urls = urls
  const images = itemImageEdits(r)
  if (images) input.images = images
  return input
}

/**
 * The `urls` field of an item save: the complete desired list of the human's
 * links, trimmed and deduplicated. Absent leaves them alone, `[]` clears them.
 * Refused, not repaired, like images — a link that silently vanishes is worse.
 */
function itemUrls(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new Error('urls must be a list of http(s) links')
  const out: string[] = []
  for (const entry of v) {
    const u = typeof entry === 'string' ? entry.trim() : ''
    if (!/^https?:\/\/\S+$/.test(u) || u.length > 2000) throw new Error('each link must be an http(s) URL')
    if (!out.includes(u)) out.push(u)
  }
  if (out.length > MAX_URLS_PER_ITEM) throw new Error(`up to ${MAX_URLS_PER_ITEM} links per item`)
  return out
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
  const timeout = await rt.store.config.get<number>(WATCH_TIMEOUT_KEY)
  const budget = await rt.store.config.get<number>(WATCH_BUDGET_KEY)
  return {
    watchesEnabled: await watchesEnabled(rt),
    watchTimeoutMs: typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_WATCH_TIMEOUT_MS,
    watchBudgetUsd: typeof budget === 'number' && budget > 0 ? budget : null,
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
  if (r.watchTimeoutMs !== undefined) {
    const t = r.watchTimeoutMs
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 30_000 || t > MAX_WATCH_TIMEOUT_MS) throw new Error(`watchTimeoutMs must be whole milliseconds from 30000 to ${MAX_WATCH_TIMEOUT_MS}`)
    await rt.store.config.set(WATCH_TIMEOUT_KEY, t)
  }
  if (r.watchBudgetUsd !== undefined) {
    const b = r.watchBudgetUsd
    if (b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 100)) throw new Error('watchBudgetUsd must be null or dollars from 0.01 to 100')
    await rt.store.config.set(WATCH_BUDGET_KEY, b)
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
  const team = rt.sessionTeam.get(row.id)
  const run = team ? rt.teamRuns.get(team.runId) : undefined
  const agent = team && run && team.member !== 'manager' ? run.agents.find((a) => a.name === team.member) : undefined
  if (team && run && (team.member === 'manager' || agent)) {
    // Rebuilt per spawn like the brief server: one instance, one transport.
    const pipeline = run.mode === 'pipeline'
    const can = agent ? agent.can : (['read'] as AgentCan[])
    const browser = pipeline && can.includes('browser') ? userMcpServer('chrome-devtools') : null
    return {
      systemAppend: `${identity}\n${
        pipeline ? (agent ? pipelineAgentAppend(run, agent) : pipelineManagerAppend(run)) : agent ? agentAppend(run, agent) : managerAppend(run)
      }`,
      mcp: { team: makeTeamMcp(rt, row.id, run) },
      disallowedTools: agent ? disallowedFor(agent.can) : MANAGER_DISALLOWED,
      // Pipeline members load only what their stage needs: a short built-in
      // list and triage's own servers (+ the browser if allowed) — not every
      // connector and plugin in ~/.claude, whose schemas ride every call.
      ...(pipeline
        ? {
            tools: builtinToolsFor(can, { ask: !agent }),
            strictMcpConfig: true,
            ...(browser ? { externalMcp: { 'chrome-devtools': browser } } : {}),
          }
        : {}),
      // Compact long before a 1M window would (it defaults to ~967K there): a
      // member re-reads its whole history on every call, so history is cost.
      settings: { autoCompactWindow: TEAM_COMPACT_WINDOW },
      // What is left of the run's budget, so one runaway turn can't blow it.
      maxBudgetUsd: Math.max(0.25, run.budgetUsd - runSpent(run)),
    }
  }
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

// ---------------------------------------------------------------------------
// Teams (server/teams.ts) — sessions that message each other through triage.
// ---------------------------------------------------------------------------
const TEAM_RUNS_KEY = 'team_runs'

async function saveTeamRuns(rt: WorkspaceRuntime): Promise<void> {
  await rt.store.config.set(TEAM_RUNS_KEY, [...rt.teamRuns.values()])
}

/** Boot: mirror stored runs into memory, dropping members whose session was deleted. */
async function loadTeamRuns(rt: WorkspaceRuntime): Promise<void> {
  for (const run of (await rt.store.config.get<StoredTeamRun[]>(TEAM_RUNS_KEY)) ?? []) {
    const members = run.members.filter((m) => rt.rows.has(m.sessionId))
    if (!members.length) continue
    // Runs from before budgets existed get today's defaults rather than none.
    const legacy = run as Partial<StoredTeamRun>
    rt.teamRuns.set(run.id, {
      ...run,
      members,
      budgetUsd: legacy.budgetUsd ?? DEFAULT_TEAM_BUDGET_USD,
      spend: legacy.spend ?? {},
      state: legacy.state ?? 'running',
      stage: legacy.stage ?? 'build',
      round: legacy.round ?? 0,
      maxRounds: legacy.maxRounds ?? MAX_FIX_ROUNDS,
      rev: legacy.rev ?? 0,
      card: legacy.card ?? null,
      steps: legacy.steps ?? [],
      dir: legacy.dir ?? '',
    })
    for (const m of members) rt.sessionTeam.set(m.sessionId, { runId: run.id, member: m.member })
  }
}

/** A session's place on a team, as the wire carries it. */
function teamMembership(rt: WorkspaceRuntime, sessionId: string): TeamMembership | undefined {
  const t = rt.sessionTeam.get(sessionId)
  const run = t ? rt.teamRuns.get(t.runId) : undefined
  const order = run ? run.members.findIndex((m) => m.sessionId === sessionId) : -1
  if (!t || !run || order < 0) return undefined
  const m = run.members[order]
  return {
    id: run.id,
    member: m.member,
    label: m.label,
    ...(m.color ? { color: m.color } : {}),
    order,
    role: m.member === 'manager' ? 'manager' : run.agents.find((a) => a.name === m.member)?.role ?? 'checker',
    spentUsd: run.spend[m.member] ?? 0,
    run: runInfo(run),
  }
}

const runInfo = (run: StoredTeamRun): TeamRunInfo => ({
  state: run.state,
  spentUsd: runSpent(run),
  budgetUsd: run.budgetUsd,
  ...(run.reason ? { reason: run.reason } : {}),
  stage: run.stage,
  round: run.round,
  maxRounds: run.maxRounds,
  rev: run.rev,
})

/**
 * One MCP server from the user's own Claude Code config (~/.claude.json), as a
 * plain config to pass through — how a browser-allowed agent gets chrome-devtools
 * while strictMcpConfig keeps every other connector out.
 */
function userMcpServer(name: string): Record<string, unknown> | null {
  try {
    const cfg = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> }
    return cfg.mcpServers?.[name] ?? null
  } catch {
    return null
  }
}

/** A member's history is compacted past this many tokens (see extrasFor). */
const TEAM_COMPACT_WINDOW = 200_000

/** Write a notice into a session's transcript, live or not. */
async function sessionNotice(rt: WorkspaceRuntime, sessionId: string, text: string): Promise<void> {
  const live = rt.live.get(sessionId)
  if (live) return live.notice(text)
  const seq = (await rt.store.events.lastSeq(sessionId)) + 1
  const event: SessionEvent = { kind: 'notice', text }
  await rt.store.events.append(sessionId, seq, event)
  broadcast(rt, { type: 'session_event', sessionId, event, at: Date.now() })
}

const usd = (n: number) => `$${n.toFixed(2)}`

/**
 * A member's turn ended: book its cost on the run, and pause the run when the
 * budget is reached (or the SDK already stopped the turn at its backstop).
 */
async function noteTeamSpend(rt: WorkspaceRuntime, sessionId: string, delta: number, subtype?: string): Promise<void> {
  const t = rt.sessionTeam.get(sessionId)
  const run = t ? rt.teamRuns.get(t.runId) : undefined
  if (!t || !run) return
  run.spend[t.member] = (run.spend[t.member] ?? 0) + delta
  const spent = runSpent(run)
  if (run.state === 'running' && (spent >= run.budgetUsd || subtype === 'error_max_budget_usd')) {
    await pauseTeamRun(rt, run, `budget reached — ${usd(spent)} of ${usd(run.budgetUsd)}`)
    return
  }
  await saveTeamRuns(rt)
  broadcastSessionList(rt)
  await advanceTeamRun(rt, run, t.member)
}

/** Stop every member mid-turn and hold messages until the run is resumed. */
async function pauseTeamRun(rt: WorkspaceRuntime, run: StoredTeamRun, reason: string): Promise<void> {
  run.state = 'paused'
  run.reason = reason
  for (const m of run.members) {
    const live = rt.live.get(m.sessionId)
    if (!live) continue
    await live.interrupt()
    live.stop()
  }
  await saveTeamRuns(rt)
  const manager = run.members.find((m) => m.member === 'manager')
  if (manager) await sessionNotice(rt, manager.sessionId, `Team paused: ${reason}. Resume to raise the budget, or stop the run.`)
  log('info', 'teams', `run paused: ${reason}`, { teamId: run.id, workspace: rt.meta.id })
  broadcastSessionList(rt)
}

async function resumeTeamRun(rt: WorkspaceRuntime, run: StoredTeamRun, addUsd: number | null): Promise<void> {
  const spent = runSpent(run)
  // Resume always leaves room to work: at least the requested amount above what's spent.
  const add = addUsd ?? Math.max(5, Math.round(run.budgetUsd * 0.5))
  run.budgetUsd = Math.max(run.budgetUsd, spent) + add
  run.state = 'running'
  delete run.reason
  // Members respawn on their next message with the new remaining budget as their backstop.
  for (const m of run.members) rt.live.get(m.sessionId)?.stop()
  await saveTeamRuns(rt)
  const manager = run.members.find((m) => m.member === 'manager')
  if (manager) await sessionNotice(rt, manager.sessionId, `Team resumed — budget now ${usd(run.budgetUsd)} (${usd(spent)} spent).`)
  broadcastSessionList(rt)
  await continueTeamRun(rt, run)
}

async function stopTeamRun(rt: WorkspaceRuntime, run: StoredTeamRun): Promise<void> {
  run.state = 'stopped'
  for (const m of run.members) {
    const live = rt.live.get(m.sessionId)
    if (!live) continue
    await live.interrupt()
    live.stop()
  }
  await saveTeamRuns(rt)
  const manager = run.members.find((m) => m.member === 'manager')
  if (manager) await sessionNotice(rt, manager.sessionId, `Team stopped at ${usd(runSpent(run))}.`)
  broadcastSessionList(rt)
}

function teamRunFrom(rt: WorkspaceRuntime, raw: unknown): StoredTeamRun {
  const id = (raw as { teamId?: unknown })?.teamId
  const run = typeof id === 'string' ? rt.teamRuns.get(id) : undefined
  if (!run) throw new Error('no such team run')
  return run
}

async function teamLibraryOp(rt: WorkspaceRuntime): Promise<TeamLibraryResponse & { ok: true }> {
  return { ok: true, ...(await rt.teamLibrary.list()), dir: rt.teamLibrary.root }
}

/**
 * Start a team on a work item from the dialog's draft: the manager plus one
 * session per agent, in the item's project, each linked to the item as a
 * dispatch. The roster is copied onto the run, so editing a library file later
 * never rewrites what a run was told. Only the manager starts now; the others
 * spawn on their first message.
 */
async function startTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<{ teamId: string; managerId: string }> {
  const r = (raw ?? {}) as Record<string, unknown>
  const item = await rt.store.items.get(typeof r.itemId === 'string' ? r.itemId : '')
  if (!item) throw new Error('no such work item')
  const project = await projectFor(rt, item)
  if (!project) throw new Error('this item has no project — set one on the item so the team knows which folder to work in')
  const manager = managerFrom(r.manager)
  const agents = (Array.isArray(r.agents) ? r.agents : []).map((a) => agentFrom(a))
  checkRoster(agents, { toStart: true })
  const title = item.title.slice(0, 80)
  const id = randomUUID()
  const run: StoredTeamRun = {
    id,
    itemId: item.id,
    title,
    createdAt: Date.now(),
    team: isLibraryName(r.team) ? r.team : null,
    manager,
    agents,
    members: [],
    budgetUsd: budgetFrom(r.budgetUsd) ?? DEFAULT_TEAM_BUDGET_USD,
    spend: {},
    state: 'running',
    // V2: triage runs the stages (.docs/teams-industry.md).
    mode: 'pipeline',
    stage: 'spec',
    round: 0,
    maxRounds: MAX_FIX_ROUNDS,
    rev: 0,
    card: null,
    steps: [],
    root: (await repoRoot(project.path)) ?? project.path,
    dir: path.join(workspaceDir(rt.meta.id), 'team-runs', id),
  }
  run.checkCmds = await detectChecks(run.root!)
  const mgr = await createSession(rt, `Manager · ${title}`, project.path, manager.model, manager.effort, false, 'gated', { spawn: false })
  run.members.push({ member: 'manager', label: 'Manager', sessionId: mgr.id })
  for (const a of agents) {
    const mode = a.can.includes('edit') ? 'acceptEdits' : 'gated'
    const row = await createSession(rt, `${a.label} · ${title}`, project.path, a.model, a.effort, false, mode, { spawn: false })
    run.members.push({ member: a.name, label: a.label, color: a.color, sessionId: row.id })
  }
  for (const m of run.members) rt.sessionTeam.set(m.sessionId, { runId: run.id, member: m.member })
  rt.teamRuns.set(run.id, run)
  await saveTeamRuns(rt)
  for (const m of run.members) await linkSessionToItem(rt, m.sessionId, item.id, 'dispatch')
  const live = await getOrRevive(rt, mgr.id)
  if (!live) throw new Error('could not start the manager session')
  const brief = await currentBrief(rt, item.id)
  const mentions: Mention[] = [{ kind: 'item', ref: item.id, label: item.title }]
  if (brief) mentions.push({ kind: 'artifact', ref: brief.artifact.id, label: brief.artifact.title })
  const kickoff =
    typeof r.kickoff === 'string' && r.kickoff.trim()
      ? r.kickoff.trim()
      : `Start the team on this work item: "${item.title}". Understand the scope, show me the plan, then delegate the first task.`
  const images = await itemImageAttachments(rt.attachmentsDir, item.id, item.images)
  await live.sendUserMessage(`${kickoff}\n\n${mentions.map(mentionToken).join(' ')}`, images, mentions)
  log('info', 'teams', `team started: ${item.title}`, { teamId: run.id, itemId: item.id, agents: agents.length, workspace: rt.meta.id })
  return { teamId: run.id, managerId: mgr.id }
}

/**
 * Save a team draft as a library team. Agents unchanged from their library file
 * are referenced; edited ones are forked into new files (the dialog — never a
 * silent edit to an agent other teams share) or written back (Settings, which
 * shows who uses them). New agents get new files.
 */
async function saveTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const r = (raw ?? {}) as Record<string, unknown>
  const lib = rt.teamLibrary
  const label = typeof r.label === 'string' ? r.label.trim().slice(0, 60) : ''
  if (!label) throw new Error('the team needs a name')
  const drafts = (Array.isArray(r.agents) ? r.agents : []).map((a) => draftAgentFrom(a))
  checkRoster(drafts)
  const update = r.agentMode === 'update'
  const names: string[] = []
  const taken = new Set<string>()
  // A forked copy keeps its name unless another agent already carries it — then
  // the team's name tells the two apart in Settings ("Reviewer (My Development)").
  const labels = new Set((await lib.agents()).map((a) => a.label.toLowerCase()))
  for (const { base, dirty, ...raw } of drafts) {
    const spec = !base || !dirty || update || !labels.has(raw.label.toLowerCase()) ? raw : { ...raw, label: `${raw.label} (${label})`.slice(0, 60) }
    if (base && (await lib.readAgent(base))) {
      if (!dirty) {
        names.push(base)
        continue
      }
      if (update) {
        await lib.writeAgent({ ...spec, name: base })
        names.push(base)
        continue
      }
    }
    const name = await lib.freeName('agent', spec.label, taken)
    taken.add(name)
    await lib.writeAgent({ ...spec, name })
    names.push(name)
  }
  const existing = isLibraryName(r.name) && (await lib.readTeam(r.name)) ? r.name : null
  const name = existing ?? (await lib.freeName('team', label))
  await lib.writeTeam({
    name,
    label,
    description: typeof r.description === 'string' ? r.description.trim().slice(0, 400) : '',
    manager: managerFrom(r.manager),
    agents: names,
    budgetUsd: budgetFrom(r.budgetUsd) ?? DEFAULT_TEAM_BUDGET_USD,
  })
  log('info', 'teams', `team saved: ${label}`, { team: name, agents: names, workspace: rt.meta.id })
  return name
}

/** Create or update one agent file (Settings → Teams → Agents). */
async function saveAgentOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const r = (raw ?? {}) as Record<string, unknown>
  const spec = agentFrom(r.agent)
  const lib = rt.teamLibrary
  const existing = isLibraryName(r.name) && (await lib.readAgent(r.name)) ? r.name : null
  const name = existing ?? (await lib.freeName('agent', spec.label))
  await lib.writeAgent({ ...spec, name })
  return name
}

/**
 * The `team` MCP server a member gets. In a pipeline run (V2) its tools are the
 * member's one submission — submit_task_card / submit_handoff / submit_verdict —
 * plus builder↔helper messaging; triage acts on a submission when the member's
 * turn ends. Open runs (V1) keep free-form message_teammate.
 */
function makeTeamMcp(rt: WorkspaceRuntime, sessionId: string, run: StoredTeamRun) {
  const me = rt.sessionTeam.get(sessionId)
  const self = run.agents.find((a) => a.name === me?.member)
  const role = me?.member === 'manager' ? 'manager' : self?.role ?? 'checker'
  const pipeline = run.mode === 'pipeline'

  /** The run as it is now (not as it was at spawn), or an error to hand back. */
  const current = (): { run: StoredTeamRun; member: string } | { error: ReturnType<typeof errResult> } => {
    const t = rt.sessionTeam.get(sessionId)
    const cur = t ? rt.teamRuns.get(t.runId) : undefined
    if (!t || !cur) return { error: errResult('this session is not on a team') }
    if (cur.state !== 'running') {
      return { error: errResult(`the team is ${cur.state}${cur.reason ? ` (${cur.reason})` : ''} — stop; the user resumes it`) }
    }
    return { run: cur, member: t.member }
  }

  // Who this member may message: everyone (open), builder ↔ helpers (pipeline).
  const helpers = run.agents.filter((a) => a.role === 'helper').map((a) => a.name)
  const builderName = run.agents.find((a) => a.role === 'builder')?.name
  const reach = !pipeline
    ? run.members.map((m) => m.member).filter((m) => m !== me?.member)
    : role === 'builder'
      ? helpers
      : role === 'helper' && builderName
        ? [builderName]
        : []

  const messageTool = tool(
    'message_teammate',
    pipeline
      ? 'Ask a teammate a question (builder ↔ helpers only). It arrives in their session as a new turn; end your turn after sending.'
      : 'Send a message to another member of your team, by member name. It arrives in their session as a new turn. After sending, end your turn — their reply arrives as a new message.',
    {
      to: (reach.length ? z.enum(reach as [string, ...string[]]) : z.string()).describe('the member to message'),
      message: z.string().describe('the full message — the member sees only this, not your conversation'),
    },
    async (args) => {
      try {
        const c = current()
        if ('error' in c) return c.error
        if (!reach.includes(args.to)) return errResult(`you can't message ${args.to} — ${reach.length ? `only ${reach.join(', ')}` : 'no one'}`)
        const target = c.run.members.find((m) => m.member === args.to)
        if (!target) return errResult(`this team has no member named ${args.to}`)
        const sent = (rt.teamMessages.get(c.run.id) ?? 0) + 1
        if (sent > TEAM_MESSAGE_BUDGET) {
          return errResult(`the team has sent ${TEAM_MESSAGE_BUDGET} messages since the user last spoke — stop and report instead`)
        }
        const live = await getOrRevive(rt, target.sessionId)
        if (!live) return errResult(`could not start ${target.label}'s session`)
        rt.teamMessages.set(c.run.id, sent)
        const from = c.run.members.find((m) => m.sessionId === sessionId)?.label ?? c.member
        await live.sendUserMessage(args.message, undefined, undefined, { from })
        return okResult(`delivered to ${target.label}. End your turn now; their reply will arrive as a new message.`)
      } catch (err) {
        return errResult(errText(err))
      }
    },
  )

  const tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']> = []
  if (!pipeline || reach.length) tools.push(messageTool)

  if (pipeline && role === 'manager') {
    tools.push(
      tool(
        'submit_task_card',
        'Submit the task card: the contract the user approves and the checker verifies against. Replaces any earlier card. Then end your turn.',
        {
          goal: z.string().describe('one or two sentences: what the change achieves, for whom'),
          criteria: z.array(z.string()).min(1).max(8).describe('3–6 observable, checkable behaviours that mean "done"'),
          outOfScope: z.array(z.string()).max(8).optional().describe('what the builder must not touch or add'),
          files: z.array(z.string()).max(12).optional().describe('files or areas the builder should start from'),
          notes: z.string().optional().describe('decisions made, constraints, or "this card is the first slice of …"'),
        },
        async (args) => {
          const c = current()
          if ('error' in c) return c.error
          if (c.run.stage !== 'spec' && c.run.stage !== 'approve') return errResult(`the card can't change now — the run is at "${c.run.stage}"`)
          const card: TaskCard = {
            goal: args.goal.trim(),
            criteria: args.criteria.map((x) => x.trim()).filter(Boolean),
            outOfScope: (args.outOfScope ?? []).map((x) => x.trim()).filter(Boolean),
            files: (args.files ?? []).map((x) => x.trim()).filter(Boolean),
            ...(args.notes?.trim() ? { notes: args.notes.trim() } : {}),
          }
          c.run.card = card
          c.run.steps.push({ kind: 'card', at: Date.now(), card })
          c.run.pending = { member: c.member, kind: 'card' }
          await writeRunFile(c.run, 'card.md', `# Task card — ${c.run.title}\n\n${renderCard(card)}\n`)
          await saveTeamRuns(rt)
          return okResult('Task card submitted. End your turn now — the user approves it and triage runs the build.')
        },
      ),
    )
  }

  if (pipeline && role === 'builder') {
    tools.push(
      tool(
        'submit_handoff',
        'Hand the finished (or fixed) work to verification. Keep it short. Then end your turn.',
        {
          summary: z.string().describe('what you changed, in a few lines'),
          files: z.array(z.string()).describe('files created or modified'),
          verification: z.string().describe('what you ran to check it and what it showed'),
          uncertain: z.string().optional().describe('anything you are unsure about'),
          rejected: z.string().optional().describe('findings you declined as out of scope, with the reason'),
        },
        async (args) => {
          const c = current()
          if ('error' in c) return c.error
          if (c.run.stage !== 'build' && c.run.stage !== 'blocked') return errResult(`there's nothing to hand off — the run is at "${c.run.stage}"`)
          const step = {
            kind: 'handoff' as const,
            at: Date.now(),
            round: c.run.round,
            summary: args.summary.trim(),
            files: args.files,
            verification: args.verification.trim(),
            ...(args.uncertain?.trim() ? { uncertain: args.uncertain.trim() } : {}),
            ...(args.rejected?.trim() ? { rejected: args.rejected.trim() } : {}),
          }
          c.run.steps.push(step)
          c.run.pending = { member: c.member, kind: 'handoff' }
          await writeRunFile(c.run, `handoff-${c.run.round}.md`, handoffText(step))
          await saveTeamRuns(rt)
          return okResult('Handed off. End your turn now — triage runs the checks and the review.')
        },
      ),
      tool(
        'report_blocked',
        'Ask the user one question you cannot answer yourself. The run waits for their answer in your session.',
        { question: z.string().describe('one specific question') },
        async (args) => {
          const c = current()
          if ('error' in c) return c.error
          c.run.steps.push({ kind: 'blocked', at: Date.now(), question: args.question.trim() })
          c.run.pending = { member: c.member, kind: 'blocked' }
          await saveTeamRuns(rt)
          return okResult('Asked. End your turn now; the user answers here.')
        },
      ),
    )
  }

  if (pipeline && role === 'checker') {
    tools.push(
      tool(
        'submit_verdict',
        'Submit your verdict on the change. "fail" needs at least one P0/P1 finding. Then end your turn.',
        {
          verdict: z.enum(['pass', 'fail']),
          verified: z.string().describe('what you ran or checked, and what it showed'),
          findings: z
            .array(
              z.object({
                severity: z.enum(['P0', 'P1']),
                where: z.string().describe('file:line or the behaviour'),
                problem: z.string(),
                fix: z.string(),
              }),
            )
            .max(10)
            .optional(),
        },
        async (args) => {
          const c = current()
          if ('error' in c) return c.error
          if (c.run.stage !== 'verify') return errResult(`there's nothing to verify — the run is at "${c.run.stage}"`)
          const findings = args.findings ?? []
          if (args.verdict === 'fail' && !findings.length) return errResult('a "fail" needs at least one P0 or P1 finding')
          const label = c.run.members.find((m) => m.sessionId === sessionId)?.label ?? c.member
          const step = { kind: 'verdict' as const, at: Date.now(), round: c.run.round, checker: label, verdict: args.verdict, verified: args.verified.trim(), findings }
          c.run.steps.push(step)
          c.run.pending = { member: c.member, kind: 'verdict' }
          await writeRunFile(c.run, `verdict-${c.run.round}-${c.member}.md`, verdictText(step))
          await saveTeamRuns(rt)
          return okResult('Verdict submitted. End your turn now.')
        },
      ),
    )
  }

  return createSdkMcpServer({
    name: 'team',
    version: VERSION,
    // A member's submit tool is its one job-critical tool: loaded up front,
    // never behind tool search.
    alwaysLoad: true,
    tools,
  })
}

// --- the pipeline engine: triage, not an agent, moves a run between stages ---

async function writeRunFile(run: StoredTeamRun, name: string, text: string): Promise<void> {
  if (!run.dir) return
  await mkdir(run.dir, { recursive: true }).catch(() => {})
  await writeFile(path.join(run.dir, name), text, 'utf8').catch(() => {})
}

type HandoffStep = Extract<TeamStep, { kind: 'handoff' }>
type VerdictStep = Extract<TeamStep, { kind: 'verdict' }>
const handoffText = (s: HandoffStep): string =>
  [
    `Summary: ${s.summary}`,
    `Files: ${s.files.join(', ') || '—'}`,
    `Verified: ${s.verification}`,
    s.uncertain ? `Uncertain: ${s.uncertain}` : '',
    s.rejected ? `Declined as out of scope: ${s.rejected}` : '',
  ]
    .filter(Boolean)
    .join('\n')
const verdictText = (s: VerdictStep): string =>
  [
    `${s.checker}: ${s.verdict.toUpperCase()}`,
    `Verified: ${s.verified}`,
    ...s.findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.where} — ${f.problem}\n   Fix: ${f.fix}`),
  ].join('\n')

const memberOf = (run: StoredTeamRun, role: 'builder' | 'checker') =>
  run.agents.filter((a) => a.role === role).map((a) => run.members.find((m) => m.member === a.name)!).filter(Boolean)

/** Move to a stage: bump the revision, persist, tell every client. */
async function setStage(rt: WorkspaceRuntime, run: StoredTeamRun, stage: TeamStage): Promise<void> {
  run.stage = stage
  run.rev += 1
  delete run.nudged
  await saveTeamRuns(rt)
  broadcastSessionList(rt)
}

/** A message from triage itself — badged "from triage" in the transcript, framed as not-the-user for the model. */
async function tellMember(rt: WorkspaceRuntime, sessionId: string, text: string, opts: { fresh?: boolean } = {}): Promise<void> {
  if (opts.fresh) rt.freshNext.add(sessionId)
  const live = await getOrRevive(rt, sessionId)
  await live?.sendUserMessage(text, undefined, undefined, { from: 'triage' })
}

/**
 * A pipeline member's turn ended. Act on the submission it made during the
 * turn, if any; otherwise the run just waits (a question to the user is normal)
 * — except a builder or checker that stopped without submitting gets one nudge.
 */
async function advanceTeamRun(rt: WorkspaceRuntime, run: StoredTeamRun, member: string): Promise<void> {
  if (run.mode !== 'pipeline' || run.state !== 'running') return
  const p = run.pending
  if (p && p.member === member) {
    delete run.pending
    if (p.kind === 'card') {
      await setStage(rt, run, 'approve')
      const mgr = run.members.find((m) => m.member === 'manager')
      if (mgr) await sessionNotice(rt, mgr.sessionId, 'Task card ready — approve it above to start the build, or tell the manager what to change')
      return
    }
    if (p.kind === 'blocked') {
      await setStage(rt, run, 'blocked')
      return
    }
    if (p.kind === 'handoff') return runTeamChecks(rt, run)
    if (p.kind === 'verdict') {
      run.awaiting = (run.awaiting ?? []).filter((m) => m !== member)
      await saveTeamRuns(rt)
      if (!run.awaiting.length) return decideTeamVerdicts(rt, run)
      return
    }
  }
  if (run.stage === 'report' && member === 'manager') {
    await setStage(rt, run, 'done')
    run.state = 'done'
    await saveTeamRuns(rt)
    broadcastSessionList(rt)
    log('info', 'teams', `run done at ${usd(runSpent(run))}`, { teamId: run.id, workspace: rt.meta.id })
    return
  }
  const agent = run.agents.find((a) => a.name === member)
  const owes =
    (run.stage === 'build' && agent?.role === 'builder' && 'submit_handoff') ||
    (run.stage === 'verify' && agent?.role === 'checker' && run.awaiting?.includes(member) && 'submit_verdict')
  if (owes && run.nudged !== `${run.stage}:${run.round}:${member}`) {
    run.nudged = `${run.stage}:${run.round}:${member}`
    await saveTeamRuns(rt)
    const m = run.members.find((x) => x.member === member)
    if (m) await tellMember(rt, m.sessionId, `You ended your turn without calling ${owes}. If the work is done, call it now; if you are stuck on something only the user can decide${owes === 'submit_handoff' ? ', call report_blocked' : ', say so in your verdict'}.`)
  }
}

/** You approved the card: photograph the tree (the checker's diff base) and start the build. */
async function approveTeamRun(rt: WorkspaceRuntime, run: StoredTeamRun): Promise<void> {
  if (run.mode !== 'pipeline' || run.stage !== 'approve' || !run.card) throw new Error('there is no card waiting for approval')
  if (run.state !== 'running') throw new Error(`the run is ${run.state}`)
  const builder = memberOf(run, 'builder')[0]
  if (!builder) throw new Error('this team has no builder')
  run.steps.push({ kind: 'approved', at: Date.now() })
  run.baseTree = (run.root && (await snapshotTree(run.root))) || undefined
  await setStage(rt, run, 'build')
  await tellMember(rt, builder.sessionId, buildMessage(run, path.join(run.dir, 'card.md')))
}

const CHECK_TIMEOUT_MS = 240_000

/** The project's own typecheck/lint/test — free, and first: no checker is paid to find a type error. */
async function runTeamChecks(rt: WorkspaceRuntime, run: StoredTeamRun): Promise<void> {
  await setStage(rt, run, 'checks')
  const cmds = run.root ? await detectChecks(run.root) : []
  const results: { cmd: string; ok: boolean; tail: string }[] = []
  for (const cmd of cmds) {
    try {
      await pExec(cmd, { cwd: run.root, timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } })
      results.push({ cmd, ok: true, tail: '' })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'failed'
      results.push({ cmd, ok: false, tail: out.slice(-3000) })
    }
  }
  const ok = results.every((r) => r.ok)
  run.steps.push({ kind: 'checks', at: Date.now(), round: run.round, ok, commands: results })
  await writeRunFile(run, `checks-${run.round}.txt`, results.map((r) => `$ ${r.cmd} → ${r.ok ? 'ok' : 'FAILED'}\n${r.tail}`).join('\n\n') || 'no checks configured')
  if (!ok) {
    const failed = results.filter((r) => !r.ok)
    return fixOrReport(rt, run, { checks: failed }, `checks still failing: ${failed.map((f) => f.cmd).join(', ')}`)
  }
  return memberOf(run, 'checker').length ? startTeamVerify(rt, run) : startTeamReport(rt, run, 'checks passed (no checker on this team)')
}

/** Another fix round, or — past the cap — report what's unresolved instead of looping. */
async function fixOrReport(
  rt: WorkspaceRuntime,
  run: StoredTeamRun,
  parts: Parameters<typeof fixMessage>[2],
  unresolved: string,
): Promise<void> {
  if (run.round >= run.maxRounds) {
    run.steps.push({ kind: 'failed', at: Date.now(), why: `${unresolved} after ${run.maxRounds} fix rounds` })
    return startTeamReport(rt, run, `not verified — ${unresolved} after ${run.maxRounds} fix rounds`)
  }
  run.round += 1
  await setStage(rt, run, 'build')
  const builder = memberOf(run, 'builder')[0]
  if (builder) await tellMember(rt, builder.sessionId, fixMessage(run.round, run.maxRounds, parts))
}

/** Every checker gets the card, the handoff and this run's diff — in a fresh context each round. */
async function startTeamVerify(rt: WorkspaceRuntime, run: StoredTeamRun): Promise<void> {
  const checkers = memberOf(run, 'checker')
  run.awaiting = checkers.map((c) => c.member)
  await setStage(rt, run, 'verify')
  let patch = ''
  let truncated = false
  if (run.root && run.baseTree) {
    const now = await snapshotTree(run.root)
    if (now) ({ patch, truncated } = await treePatch(run.root, run.baseTree, now).catch(() => ({ patch: '', truncated: false })))
  }
  const handoff = [...run.steps].reverse().find((s): s is HandoffStep => s.kind === 'handoff')
  const text = checkerMessage(run, handoff ? handoffText(handoff) : '(no handoff)', patch, truncated, run.round)
  for (const c of checkers) await tellMember(rt, c.sessionId, text, { fresh: true })
}

async function decideTeamVerdicts(rt: WorkspaceRuntime, run: StoredTeamRun): Promise<void> {
  const verdicts = run.steps.filter((s): s is VerdictStep => s.kind === 'verdict' && s.round === run.round)
  const failing = verdicts.filter((v) => v.verdict === 'fail')
  if (!failing.length) return startTeamReport(rt, run, `verified — ${verdicts.map((v) => `${v.checker} passed`).join(', ')}`)
  return fixOrReport(
    rt,
    run,
    { findings: failing.map((v) => ({ checker: v.checker, findings: v.findings })) },
    `${failing.reduce((n, v) => n + v.findings.length, 0)} open finding(s)`,
  )
}

async function startTeamReport(rt: WorkspaceRuntime, run: StoredTeamRun, outcome: string): Promise<void> {
  await setStage(rt, run, 'report')
  const mgr = run.members.find((m) => m.member === 'manager')
  if (mgr) await tellMember(rt, mgr.sessionId, reportMessage(run, outcome))
}

/** After a resume: act on a submission the pause interrupted, or ask the stage's owner to carry on. */
async function continueTeamRun(rt: WorkspaceRuntime, run: StoredTeamRun): Promise<void> {
  if (run.mode !== 'pipeline') return
  if (run.pending) return advanceTeamRun(rt, run, run.pending.member)
  const owner =
    run.stage === 'build'
      ? memberOf(run, 'builder')[0]
      : run.stage === 'verify'
        ? memberOf(run, 'checker').find((c) => run.awaiting?.includes(c.member))
        : run.stage === 'report' || run.stage === 'spec'
          ? run.members.find((m) => m.member === 'manager')
          : undefined
  if (owner) await tellMember(rt, owner.sessionId, 'The run was paused and is now resumed. Carry on with your stage where you left off, and finish with your submit tool.')
}

function teamRunDetail(run: StoredTeamRun): TeamRunDetail {
  return { id: run.id, itemId: run.itemId, title: run.title, info: runInfo(run), card: run.card, steps: run.steps, dir: run.dir }
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
        'Add a manual to-do to the inbox (a user-authored item). Title is required; description, url, urls, priority (1–4), and projectId are optional.',
        {
          title: z.string().describe('what the to-do is'),
          description: z.string().optional().describe("the user's intent in a few sentences"),
          note: z.string().optional().describe('alias of description'),
          url: z.string().optional().describe('an http(s) link'),
          urls: z.array(z.string()).optional().describe('more http(s) links — the Slack thread, the PR, a doc'),
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
          urls: z.array(z.string()).optional().describe('the complete list of extra links; [] clears them'),
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

/**
 * The bundled manifest, with the start URL swapped per device: a paired phone's
 * home-screen app opens through /api/pair, because iOS gives a standalone web
 * app its own cookie jar and the pairing cookie would not follow it there.
 */
function webManifest(access: Access): Record<string, unknown> {
  let base: Record<string, unknown> = { name: 'Triage', short_name: 'Triage', display: 'standalone' }
  try {
    base = JSON.parse(readFileSync(path.join(WEB_DIR, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>
  } catch {
    // no build yet: the minimal manifest is fine
  }
  return { ...base, start_url: access === 'paired' ? `/api/pair?token=${encodeURIComponent(remote.token)}` : '/', scope: '/' }
}

function remoteStatus(): RemoteStatus {
  if (remote.enabled) pairCode = livePairCode(pairCode, Date.now())
  return {
    local: true,
    enabled: remote.enabled,
    token: remote.token,
    code: remote.enabled && pairCode ? { digits: pairCode.code, expiresAt: pairCode.expiresAt } : null,
    port: PORT,
    addresses: lanAddresses(),
    hostname: bonjourName(),
    tunnel: remote.tunnel,
    tunnelStatus: tunnel.status,
  }
}

/** Sockets and WebSockets from other devices, so switching access off or resetting the token cuts them at once. */
const remoteSockets = new Set<import('node:net').Socket>()
const remoteWs = new Set<WebSocket>()

function dropRemoteClients() {
  for (const ws of remoteWs) ws.close(4401, 'unpaired')
  remoteWs.clear()
  for (const sock of remoteSockets) sock.destroy()
  remoteSockets.clear()
}

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
  const access = accessOf(req, remote)
  if (url.pathname === '/api/pair') {
    // The QR code's link: trade the token for the cookie, then go home. Also
    // the home-screen app's start URL, so a standalone web app with its own
    // cookie jar pairs itself on every launch.
    const given = url.searchParams.get('token')
    const typed = url.searchParams.get('code')
    let ok = access === 'local' || (remote.enabled && tokenMatches(given?.trim(), remote.token))
    if (!ok && remote.enabled && typed && codesAllowed(req)) {
      const spent = tryPairCode(pairCode, typed, Date.now())
      pairCode = spent.next
      ok = spent.ok
      log(ok ? 'info' : 'warn', 'remote', ok ? 'device paired with the code' : 'wrong pairing code')
    }
    if (ok) {
      res.writeHead(302, { location: '/', ...(access === 'local' ? {} : { 'set-cookie': pairCookie(remote.token) }) })
      res.end()
    } else {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        pairPageHtml(
          typed
            ? 'That code did not match, or it has expired. Check the code on your Mac — it changes after each use.'
            : given
              ? 'That link has stopped working — the code was reset on the Mac. Scan the new QR code.'
              : undefined,
          codesAllowed(req),
        ),
      )
    }
    return
  }
  if (access === 'denied') {
    if (url.pathname.startsWith('/api/') || url.pathname === MCP_PATH) {
      json(401, { error: 'this device is not paired with triage' })
    } else {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(pairPageHtml(undefined, codesAllowed(req)))
    }
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req, access)) {
    // Any page can make a browser POST to us; only our own page gets to write.
    json(403, { ok: false, error: 'cross-origin writes are not accepted' })
    return
  }
  if (url.pathname === '/manifest.webmanifest') {
    // Served, not bundled: a paired device's start URL carries the token (see /api/pair).
    res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(webManifest(access)))
    return
  }
  if (url.pathname === MCP_PATH) {
    if (!sameOrigin(req, access)) {
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

  if (url.pathname === '/api/remote') {
    // Phone access is managed from the Mac only: a paired phone can use triage
    // but cannot read the token, rotate it, or switch access off and on.
    if (access !== 'local') {
      json(200, { local: false } satisfies RemoteStatus)
      return
    }
    if (req.method === 'POST') {
      let body: { enabled?: unknown; rotate?: unknown; newCode?: unknown; tunnel?: unknown } | null
      try {
        body = (await readJsonBody(req, 10_000)) as typeof body
      } catch (err) {
        json(400, { error: errText(err) })
        return
      }
      const next = { ...remote }
      if (typeof body?.enabled === 'boolean') next.enabled = body.enabled
      if (typeof body?.tunnel === 'boolean') next.tunnel = body.tunnel
      if (body?.rotate === true) next.token = newToken()
      if (body?.rotate === true || body?.newCode === true || !next.enabled) pairCode = null
      await saveRemote(next)
      const unpair = !next.enabled || next.token !== remote.token
      remote = next
      if (unpair) dropRemoteClients()
      syncTunnel()
      log('info', 'remote', `phone access ${remote.enabled ? (remote.tunnel ? 'on, anywhere' : 'on, same network') : 'off'}${body?.rotate === true ? ', token reset' : ''}`)
    }
    json(200, remoteStatus())
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

  // The Changes rail: every project's uncommitted files, one file's patch, and
  // reading/saving a changed file. Project-scoped, the complement of the
  // session view above: "what is dirty", whoever made it.
  if (url.pathname === '/api/changes' && req.method === 'GET') {
    let body: WorkingChangesResponse
    try {
      const projects = await rt.store.projects.list()
      body = { ok: true, projects: await Promise.all(projects.map(projectChanges)) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  if (url.pathname === '/api/changes/diff' || url.pathname === '/api/changes/file') {
    const project = (await rt.store.projects.list()).find((p) => p.id === url.searchParams.get('projectId'))
    const file = url.searchParams.get('path') ?? ''
    if (!project || !file) {
      json(400, { ok: false, error: project ? 'need a path' : 'unknown project' })
      return
    }
    if (url.pathname === '/api/changes/diff' && req.method === 'GET') {
      let body: WorkingDiffResponse
      try {
        const got = await worktreePatch(project.path, file)
        body = { ok: true, path: file, patch: got.patch, isBinary: got.patch.includes('Binary files'), truncated: got.truncated }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return
    }
    if (url.pathname === '/api/changes/file' && req.method === 'GET') {
      let body: ProjectFileResponse
      try {
        body = await readProjectFile(project.path, file)
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return
    }
    if (url.pathname === '/api/changes/file' && req.method === 'PUT') {
      // A write to disk: any page in the browser can POST to localhost, so
      // only our own origin gets to do it.
      if (!sameOrigin(req, access)) {
        json(403, { ok: false, error: 'cross-origin writes are not accepted' })
        return
      }
      let body: SaveProjectFileResponse
      try {
        const parsed = (await readJsonBody(req, 4_000_000)) as { content?: unknown; version?: unknown } | null
        if (typeof parsed?.content !== 'string' || typeof parsed.version !== 'string') {
          throw new Error('need content and the version it was edited from')
        }
        body = await writeProjectFile(project.path, file, parsed.content, parsed.version)
        if (body.ok) log('info', 'changes', `saved ${file}`, { project: project.name, workspace: rt.meta.id })
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : body.conflict ? 409 : 400, body)
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
        if (id) {
          await rt.store.projects.remove(id)
          // Its watches pause with a visible reason — never run somewhere else (watch-spec.md, item 2).
          for (const w of await rt.store.watches.list()) {
            if (w.projectId !== id) continue
            await rt.store.watches.patchState(w.id, { enabled: false, configError: 'project removed — pick another project for this watch' })
            log('info', 'watch', `paused "${w.title}": its project was removed`, { watchId: w.id, workspace: rt.meta.id })
          }
        }
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
    if (access !== 'local') {
      // The chooser would open on the Mac's screen, not the phone asking for it.
      json(200, { ok: false, error: 'the folder picker opens on the Mac — type the folder path instead' } satisfies PickFolderResponse)
      return
    }
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
        if (!p.title || !p.instruction || !p.tools?.length) {
          throw new Error('a watch needs a title, instructions, and at least one integration')
        }
        if (!p.projectId) throw new Error('pick the project this watch runs in')
        if (!(await rt.store.projects.list()).some((pr) => pr.id === p.projectId)) throw new Error('unknown project')
        // Schedule is the source of truth; accept a legacy cadence as a fallback.
        const schedule = p.schedule ?? (p.cadence ? cronFromCadence(p.cadence, p.windowStart, p.windowDay) : '0 9 * * *')
        const now = Date.now()
        await rt.store.watches.create({
          id: randomUUID(),
          source: 'slack',
          title: p.title,
          scope: p.scope ?? '',
          tools: p.tools,
          projectId: p.projectId,
          model: p.model,
          output: p.output ?? 'items',
          ...(p.catchUpWindow ? { catchUpWindow: p.catchUpWindow } : {}),
          ...(p.timeoutMs != null ? { timeoutMs: p.timeoutMs } : {}),
          ...(p.maxBudgetUsd != null ? { maxBudgetUsd: p.maxBudgetUsd } : {}),
          notify: p.notify ?? 'on_failure',
          consecutiveFailures: 0,
          // "Run once now" off: the first run waits for the next slot.
          ...(p.runOnceNow === false ? { lastRunStartedAt: now } : {}),
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
        log('info', 'watch', `created: ${p.title}`, { tools: p.tools.map(grantLabel), schedule, workspace: rt.meta.id })
        // active on the next scheduler tick (never run → due immediately, unless runOnceNow was off)
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        const existing = id ? await rt.store.watches.get(id) : null
        if (!id || !existing) throw new Error('unknown watch id')
        const parsed = watchPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        if (parsed.patch.projectId && !(await rt.store.projects.list()).some((pr) => pr.id === parsed.patch.projectId)) {
          throw new Error('unknown project')
        }
        const { runOnceNow: _ignored, ...patch } = parsed.patch
        await rt.store.watches.update(id, patch)
        // A valid project fixes a "project removed" config error.
        if (patch.projectId && existing.configError) await rt.store.watches.patchState(id, { configError: null })
        // Re-enabling waits for the next slot: no burst of catch-up runs.
        if (patch.enabled === true && !existing.enabled) await rt.store.watches.patchState(id, { lastRunStartedAt: Date.now() })
        if (patch.enabled === true && existing.configError && !patch.projectId) throw new Error(existing.configError)
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
      if (!p.instruction || !p.tools?.length) throw new Error('a preview needs instructions and at least one integration')
      if (!p.projectId) throw new Error('pick the project this watch runs in')
      const previewId = startWatchPreview(rt, {
        instruction: p.instruction,
        tools: p.tools,
        projectId: p.projectId,
        model: p.model,
        output: p.output ?? 'items',
        schedule: p.schedule ?? '0 9 * * *',
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
          ...(r.runTrigger ? { trigger: r.runTrigger } : {}),
          matches: r.runMatches,
          ...(r.runNew != null ? { newCount: r.runNew } : {}),
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
      if (w.configError) throw new Error(w.configError)
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
      void (async () => {
        // "Scan now": every enabled watch, now, as a manual run.
        if (!(await watchesEnabled(rt))) return
        for (const w of await rt.store.watches.list()) if (w.enabled && !w.configError) enqueueWatch(rt, w.id)
      })()
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
      const refresh = url.searchParams.get('refresh') === '1'
      const projectId = url.searchParams.get('projectId')
      if (projectId) {
        // The watch picker: what a run in this project's folder can load.
        const project = (await rt.store.projects.list()).find((p) => p.id === projectId)
        if (!project) throw new Error('unknown project')
        const cached = rt.folderProbes.get(project.path)
        const probe = cached && !refresh && Date.now() - cached.probedAt < FOLDER_PROBE_TTL_MS ? cached : await probeConnectors(rt, project.path)
        // the run's own server shadows any user server named triage — never offer it
        const connectors = probe.connectors.filter((c) => c.server !== RESERVED_SERVER)
        body = { ok: true, probedAt: probe.probedAt, connectors, cwd: project.path, elsewhere: await localServersElsewhere(rt, project.path, connectors) }
      } else {
        const probe = rt.connectorCache && !refresh ? rt.connectorCache : await probeConnectors(rt)
        if (refresh) rt.folderProbes.clear()
        body = { ok: true, probedAt: probe.probedAt, connectors: probe.connectors }
      }
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
  // Teams (.docs/teams.md): the agent/team library, saving it, and starting a run.
  if (url.pathname.startsWith('/api/teams')) {
    const route = `${req.method} ${url.pathname}`
    try {
      const lib = rt.teamLibrary
      if (route === 'GET /api/teams/library') {
        json(200, await teamLibraryOp(rt))
      } else if (route === 'POST /api/teams/start') {
        const body: StartTeamResponse = { ok: true, ...(await startTeamOp(rt, await readJsonBody(req))) }
        json(200, body)
      } else if (route === 'POST /api/teams/save') {
        const team = await saveTeamOp(rt, await readJsonBody(req))
        const body: SaveTeamResponse = { ok: true, team, library: await teamLibraryOp(rt) }
        json(200, body)
      } else if (route === 'PUT /api/teams/agent') {
        await saveAgentOp(rt, await readJsonBody(req))
        json(200, await teamLibraryOp(rt))
      } else if (route === 'DELETE /api/teams/agent' || route === 'DELETE /api/teams/team') {
        await lib.remove(url.pathname.endsWith('agent') ? 'agent' : 'team', url.searchParams.get('name') ?? '')
        json(200, await teamLibraryOp(rt))
      } else if (route === 'POST /api/teams/reset') {
        const b = ((await readJsonBody(req)) ?? {}) as { kind?: unknown; name?: unknown }
        if (!isLibraryName(b.name) || (b.kind !== 'agent' && b.kind !== 'team')) throw new Error('need a kind and a name')
        await lib.reset(b.kind, b.name)
        json(200, await teamLibraryOp(rt))
      } else if (route === 'POST /api/teams/approve') {
        await approveTeamRun(rt, teamRunFrom(rt, await readJsonBody(req)))
        json(200, { ok: true })
      } else if (route === 'GET /api/teams/run') {
        const body: TeamRunResponse = { ok: true, run: teamRunDetail(teamRunFrom(rt, { teamId: url.searchParams.get('teamId') })) }
        json(200, body)
      } else if (route === 'POST /api/teams/pause') {
        await pauseTeamRun(rt, teamRunFrom(rt, await readJsonBody(req)), 'paused by you')
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/resume') {
        const body = (await readJsonBody(req)) as { addUsd?: unknown } | null
        await resumeTeamRun(rt, teamRunFrom(rt, body), budgetFrom(body?.addUsd))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/stop') {
        await stopTeamRun(rt, teamRunFrom(rt, await readJsonBody(req)))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/open') {
        await openInEditor(lib.root)
        json(200, { ok: true })
      } else json(404, { ok: false, error: 'not found' })
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
  // The human's links on any item. The list sent is the complete desired set.
  if (url.pathname === '/api/items/urls' && req.method === 'POST') {
    let body: ItemUrlsResponse
    try {
      const parsed = (await readJsonBody(req)) as Record<string, unknown> | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      const urls = itemUrls(parsed?.urls) ?? []
      await rt.store.items.setUrls(id, urls)
      rt.inboxCache = null
      body = { ok: true, urls }
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
// Drop other devices at accept while phone access is off — the same as a
// loopback-only bind, without a restart to switch it on (server/remote.ts).
server.on('connection', (sock) => {
  if (isLoopbackAddress(sock.remoteAddress)) return
  if (!remote.enabled) {
    sock.destroy()
    return
  }
  remoteSockets.add(sock)
  sock.on('close', () => remoteSockets.delete(sock))
})

const wss = new WebSocketServer({
  server,
  path: '/ws',
  // Browsers let any page open a WebSocket to localhost; only our own page,
  // from this machine or a paired device, gets one.
  verifyClient: ({ req }, done) => {
    const access = accessOf(req, remote)
    if (access === 'denied') done(false, 401, 'not paired')
    else if (!sameOrigin(req, access)) done(false, 403, 'cross-origin')
    else done(true)
  },
})

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
  if (accessOf(req, remote) !== 'local') {
    remoteWs.add(ws)
    ws.on('close', () => remoteWs.delete(ws))
  }
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
          send(ws, {
            type: 'history',
            sessionId: msg.sessionId,
            events: events.map((e) => e.event),
            times: events.map((e) => e.createdAt),
          })
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
  syncTunnel()
  log('info', 'server', `triage v${VERSION} started on :${PORT} (${runtimes.size} workspace${runtimes.size === 1 ? '' : 's'}, default: ${registry.defaultId})`)
  // Record where we are so `triage stop/status` can find a --port server.
  writeState({ pid: process.pid, port: PORT, version: VERSION, startedAt: new Date().toISOString() }).catch(
    (err) => console.error('[state] could not write server.json:', err),
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('info', 'server', `received ${sig} — shutting down`)
    tunnel.stop()
    for (const rt of runtimes.values()) rt.terminals.killAll()
    clearState(process.pid).finally(() => process.exit(0))
  })
}
