/**
 * The persistence seam ("thin frontends, fat core").
 *
 * One interface per aggregate, expressed in domain types — no SQL, no driver
 * types, no dialect. Everything is async even though the SQLite adapter is
 * synchronous underneath: `pg`/`mysql2` never will be, and retrofitting
 * Promises onto every call site later is the expensive rewrite this seam
 * exists to avoid.
 *
 * Portability rules the adapters must follow:
 * - IDs are generated in app code (UUIDs), never by the database.
 * - Times are integer epoch milliseconds.
 * - Booleans are 0/1 in storage, real booleans out here.
 * - JSON is (de)serialized inside the adapter; domain types carry objects.
 */
import type {
  Artifact,
  BriefJob,
  BriefStatus,
  EffortLevel,
  InboxSnapshot,
  ItemImage,
  Link,
  LinkKind,
  LinkRole,
  PermissionMode,
  Project,
  SessionEvent,
  SessionKind,
} from '../../shared/protocol.js'

export type { SessionKind }
import type { Provenance, WorkItem } from '../work/types.js'
import type { ItemEvent, ItemStatus, StatusChange } from '../work/state.js'
import type { NewWatch, Watch, WatchRunResult, WatchRunStart, WatchRunStatus, WatchRunTrigger } from '../watch/types.js'

export type StoredSession = {
  id: string
  title: string
  cwd: string
  /** Claude Code's own session id — the key for `resume` and the link to its transcript. */
  sdkSessionId: string | null
  /** The model the user picked; null = whatever Claude Code defaults to. */
  model: string | null
  /** The effort the user picked; null = the model's own default. */
  effort: EffortLevel | null
  /** Fast mode, as the user set it. Persisted so a revived session keeps it. */
  fastMode: boolean
  /** How much the session asks before acting; null = 'default' (ask). */
  permissionMode: PermissionMode | null
  /** Pinned sessions sort above the rest, whatever their last activity. */
  pinned: boolean
  /** chat (default) or watch-run. */
  kind: SessionKind
  /** the watch this run belongs to, for watch-run sessions. */
  watchId: string | null
  /** watch-run outcome, recorded when the run finishes (else undefined). */
  runStatus?: WatchRunStatus
  /** why this watch run happened, set when it starts */
  runTrigger?: WatchRunTrigger
  runMatches?: number
  /** of the matches, how many were new to the inbox */
  runNew?: number
  runTokens?: number
  /** dollars, from the SDK's total_cost_usd */
  runCostUsd?: number
  runError?: string
  createdAt: number
  updatedAt: number
}

/** The outcome a finished watch-run session records on its own row. */
export type WatchRunRecord = {
  status: WatchRunStatus
  matches: number
  newCount?: number
  tokens: number
  costUsd?: number
  error?: string
}

export type NewSession = {
  id: string
  title: string
  cwd: string
  model?: string | null
  effort?: EffortLevel | null
  fastMode?: boolean
  permissionMode?: PermissionMode | null
  kind?: SessionKind
  watchId?: string | null
  runTrigger?: WatchRunTrigger
}

export type StoredEvent = {
  seq: number
  event: SessionEvent
  createdAt: number
}

export interface SessionStore {
  create(s: NewSession): Promise<StoredSession>
  get(id: string): Promise<StoredSession | null>
  /** All sessions: pinned first, then most recently active. */
  list(): Promise<StoredSession[]>
  setSdkSessionId(id: string, sdkSessionId: string): Promise<void>
  /** Persist a model/effort switch, so a revived session keeps the choice. */
  setModel(id: string, model: string | null, effort: EffortLevel | null): Promise<void>
  /** Persist a fast-mode switch, so a revived session keeps the choice. */
  setFastMode(id: string, fastMode: boolean): Promise<void>
  /** Persist a permission-mode switch, so a revived session keeps the choice. */
  setPermissionMode(id: string, mode: PermissionMode | null): Promise<void>
  /** Give a session a new title. */
  rename(id: string, title: string): Promise<void>
  /** Pin or unpin a session. */
  setPinned(id: string, pinned: boolean): Promise<void>
  /** Delete a session and its whole event log. Irreversible. */
  remove(id: string): Promise<void>
  /** Bump updatedAt (a session saw activity). */
  touch(id: string): Promise<void>
  /** Record a watch-run session's outcome on its row (for the Activity view). */
  recordWatchRun(id: string, run: WatchRunRecord): Promise<void>
}

/**
 * One turn of a session, with the git tree either side of it.
 *
 * Sessions in the same folder share a working tree, so "what did *this*
 * session change" cannot be read off `git status`. It is reconstructed from
 * these: the agent only edits while its own turn runs, so everything between
 * `preTree` and `postTree` happened in this session's window — and is this
 * session's work unless another session's turn overlapped it.
 */
export type StoredTurn = {
  sessionId: string
  seq: number
  /** the repo root this turn ran against */
  root: string
  /** tree sha of the working tree captured just before the turn started */
  preTree: string
  /** tree sha captured after the turn's `result`; null while it is running */
  postTree: string | null
  startedAt: number
  endedAt: number | null
  /** absolute paths this turn's file-editing tools named */
  touched: string[]
}

export interface TurnStore {
  /** Open a turn. Only the pre-turn tree is known at this point. */
  begin(t: { sessionId: string; seq: number; root: string; preTree: string; startedAt: number }): Promise<void>
  /** Close it with the post-turn tree and the paths its tools named. */
  end(
    sessionId: string,
    seq: number,
    post: { postTree: string | null; endedAt: number; touched: string[] },
  ): Promise<void>
  /** This session's turns, oldest first. */
  list(sessionId: string): Promise<StoredTurn[]>
  /** Every *other* session's turns against the same root — for collision checks. */
  othersInRoot(root: string, exceptSessionId: string): Promise<StoredTurn[]>
  /** The highest turn seq recorded for a session, or 0. */
  lastSeq(sessionId: string): Promise<number>
  /** Drop a session's turns (it was deleted). */
  removeFor(sessionId: string): Promise<void>
}

export interface EventStore {
  /** Append one event; `seq` must be the caller's next per-session sequence number. */
  append(sessionId: string, seq: number, event: SessionEvent): Promise<void>
  /** Events after `afterSeq` (exclusive), in order. Omit for the full log. */
  read(sessionId: string, afterSeq?: number): Promise<StoredEvent[]>
  /** The highest seq for a session, or 0 if none. */
  lastSeq(sessionId: string): Promise<number>
}

export interface InboxStore {
  /** Persist the latest ranked snapshot (replaces the previous one). */
  save(snapshot: InboxSnapshot): Promise<void>
  load(): Promise<InboxSnapshot | null>
}

/** Small typed KV for settings and source caches (JSON values). */
export interface ConfigStore {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
}

export interface ProjectStore {
  list(): Promise<Project[]>
  create(p: Project): Promise<void>
  remove(id: string): Promise<void>
  /** Delete the retired built-in scratch projects (a dev-build leftover); returns what was removed. */
  retireBuiltin(): Promise<Project[]>
}

/** Scheduler-owned state on a watch — never part of the user's edit. */
export type WatchStatePatch = {
  enabled?: boolean
  /** null clears it */
  configError?: string | null
  lastRunStartedAt?: number
  /** null clears it */
  projectId?: string | null
}

export interface WatchStore {
  list(): Promise<Watch[]>
  get(id: string): Promise<Watch | null>
  create(w: Watch): Promise<void>
  /** Edit the user-authored fields (and enabled). Bumps updatedAt. */
  update(id: string, patch: Partial<NewWatch> & { enabled?: boolean }): Promise<void>
  /** Scheduler-owned fields: config error, the due rule's clock, a forced project. */
  patchState(id: string, patch: WatchStatePatch): Promise<void>
  /** A run started (or a slot was skipped): moves the due rule's clock. */
  markRunStarted(id: string, start: WatchRunStart): Promise<void>
  /** What a finished run writes back: status, cost, matches, failure streak. */
  recordRun(id: string, run: WatchRunResult): Promise<void>
  remove(id: string): Promise<void>
}

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged'

export type UpsertResult = {
  outcome: UpsertOutcome
  /** the reopen rule fired: a done item returned to open on newer source activity */
  reopened: boolean
}

export type NewManualItem = {
  id: string
  title: string
  projectId?: string
  description?: string
  url?: string
  priority?: number
}

/**
 * The durable inbox (.docs/watches-v2.md): one row per work item, keyed by its
 * canonical id, for every source — built-ins, watch hits, GitHub, and manual
 * to-dos. Never hard-deleted, never auto-expired; an item leaves the open inbox
 * only by a recorded transition (done/snoozed/archived) or a wake. The
 * idempotent upsert rule and the deterministic reopen rule live in the adapter
 * — correctness in the contract, not the prompt. Every transition is appended
 * to the item's own event log.
 */
export interface WorkItemStore {
  /**
   * Insert or refresh one scanned/source item. Id exists → update payload only
   * if the incoming source time is newer (re-ranking is correct); state columns
   * are never touched by ingestion, except the reopen rule (a done item with
   * newer source activity returns to open). `provenance` is appended to the
   * item's foundBy list. New id → insert with a 'created' event.
   */
  upsert(item: WorkItem, provenance?: Provenance): Promise<UpsertResult>
  /** A user-authored to-do (source/kind 'manual'); returns the created id. */
  createManual(item: NewManualItem): Promise<string>
  updateManual(id: string, patch: Partial<Omit<NewManualItem, 'id'>>): Promise<void>
  get(id: string): Promise<WorkItem | null>
  /** Items in one status (default 'open'), newest source activity first. */
  list(status?: ItemStatus): Promise<WorkItem[]>
  /** Every item regardless of status — for reconciliation and counts. */
  listAll(): Promise<WorkItem[]>
  /** Record a status transition: append the matching event and set the column. */
  transition(id: string, change: StatusChange): Promise<void>
  /** Set (or clear, with null) the user priority override. */
  setPriority(id: string, priority: number | null): Promise<void>
  setPinned(id: string, pinned: boolean): Promise<void>
  /** Snoozes whose wake time has elapsed → open (+ a 'woken' event). Returns woken ids. */
  wakeSnoozed(now: number): Promise<string[]>
  /** The append-only transition log for one item, in order. */
  events(id: string): Promise<ItemEvent[]>
  /** Set (or clear, with null) the human's description on any item. Never touched by ingestion. */
  setDescription(id: string, description: string | null): Promise<void>
  /**
   * Replace the image refs on any item. The bytes are the caller's business
   * (they live on disk); this only records what the item now holds.
   */
  setImages(id: string, images: ItemImage[]): Promise<void>
}

export type NewBriefJob = {
  id: string
  itemId: string
  playbook: string
  model?: string | null
  note?: string | null
}

/**
 * Brief jobs (.docs/next-version.md, phase 2): the queue and the state machine
 * in one table, so it survives a restart and stays FIFO. The current brief of
 * an item is its newest job.
 */
export interface BriefJobStore {
  create(j: NewBriefJob): Promise<BriefJob>
  get(id: string): Promise<BriefJob | null>
  /** The newest job for an item, whatever its status. */
  latestForItem(itemId: string): Promise<BriefJob | null>
  /** The newest job that ran (or runs) in a session — how a revived brief session finds its tool. */
  forSession(sessionId: string): Promise<BriefJob | null>
  /** The newest job per item — the inbox's status pills in one query. */
  latestPerItem(): Promise<BriefJob[]>
  /** Jobs in one status, oldest first (the queue order for 'queued'). */
  list(status?: BriefStatus): Promise<BriefJob[]>
  /** How many jobs started at or after `sinceMs` — the daily cap's counter. */
  countStartedSince(sinceMs: number): Promise<number>
  update(id: string, patch: Partial<Omit<BriefJob, 'id' | 'itemId' | 'playbook'>>): Promise<void>
  /** Boot: every 'running' job's subprocess died with the old daemon. Returns the ids. */
  failAllRunning(error: string): Promise<string[]>
  /** Drop a job (cancelling a queued one). */
  remove(id: string): Promise<void>
}

/**
 * The artifacts index (.docs/next-version.md, phase 1): one row per markdown
 * file under the workspace's artifacts folder. The file is the truth — rows are
 * rebuilt from disk by the server's indexer, never edited on their own.
 */
export interface ArtifactStore {
  /** Insert or replace the row for this id; a stale row at the same path (a replaced file) is dropped. */
  upsert(a: Artifact): Promise<void>
  get(id: string): Promise<Artifact | null>
  getByPath(path: string): Promise<Artifact | null>
  /** Every indexed artifact, most recently updated first. */
  list(): Promise<Artifact[]>
  remove(id: string): Promise<void>
}

export type NewLink = { fromKind: LinkKind; fromId: string; toKind: LinkKind; toId: string; role: LinkRole }

/**
 * Relations between artifacts, work items and sessions, polymorphic on purpose
 * so "which sessions worked this item" and "which document is its brief" are
 * one table and one query shape.
 */
export interface LinkStore {
  /** Idempotent on (from, to, role): an existing identical link is returned, not duplicated. */
  add(l: NewLink): Promise<Link>
  remove(id: string): Promise<void>
  /** Drop every link touching an entity, either side — when the entity goes away. */
  removeFor(kind: LinkKind, id: string): Promise<void>
  forTarget(kind: LinkKind, id: string): Promise<Link[]>
  forSource(kind: LinkKind, id: string): Promise<Link[]>
  list(): Promise<Link[]>
}

export interface Store {
  sessions: SessionStore
  events: EventStore
  turns: TurnStore
  inbox: InboxStore
  config: ConfigStore
  projects: ProjectStore
  watches: WatchStore
  items: WorkItemStore
  artifacts: ArtifactStore
  links: LinkStore
  briefs: BriefJobStore
  close(): Promise<void>
}
