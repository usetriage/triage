/**
 * SQLite adapter for the Store interface, on node:sqlite (stdlib — keeps the
 * global install dependency-free; vision principle 5).
 *
 * Single-writer by design: SQLite has one writer and this process is it.
 * Nothing here may leak into the interface — a Postgres adapter for the hosted
 * version implements core/store/types.ts, not this file.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Artifact, BriefJob, BriefStatus, InboxSnapshot, ItemImage, Link, LinkKind, LinkRole, Project, SessionEvent } from '../../shared/protocol.js'
import { isArtifactAuthor, isLinkKind, isLinkRole } from '../../shared/protocol.js'
import type { Provenance, WorkItem } from '../work/types.js'
import type { ItemEvent, ItemEventKind, ItemStatus, StatusChange } from '../work/state.js'
import { eventForStatus, shouldReopen } from '../work/state.js'
import type { EffortLevel, PermissionMode } from '../../shared/protocol.js'
import type { NewWatch, Watch, WatchCadence, WatchConnector, WatchNotify, WatchRunResult, WatchRunStart, WatchRunStatus, WatchRunTrigger } from '../watch/types.js'
import { WATCH_NOTIFY, WATCH_RUN_STATUSES } from '../watch/types.js'
import { cronFromCadence } from '../watch/cron.js'
import { grantsFrom, grantsFromLegacy, type WatchToolGrant } from '../watch/tools.js'
import type {
  ArtifactStore,
  BriefJobStore,
  ConfigStore,
  LinkStore,
  NewBriefJob,
  NewLink,
  ProjectStore,
  EventStore,
  InboxStore,
  NewManualItem,
  NewSession,
  SessionKind,
  SessionStore,
  Store,
  StoredEvent,
  StoredSession,
  StoredTurn,
  WatchStatePatch,
  TurnStore,
  UpsertResult,
  WatchRunRecord,
  WatchStore,
  WorkItemStore,
} from './types.js'

// Numbered, append-only. A new migration is a new entry — never edit an old one.
const MIGRATIONS: string[] = [
  `CREATE TABLE sessions (
     id             TEXT PRIMARY KEY,
     title          TEXT NOT NULL,
     cwd            TEXT NOT NULL,
     sdk_session_id TEXT,
     created_at     INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL
   );
   CREATE TABLE session_events (
     session_id TEXT NOT NULL REFERENCES sessions(id),
     seq        INTEGER NOT NULL,
     kind       TEXT NOT NULL,
     payload    TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, seq)
   );
   CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);`,
  // 2: the inbox snapshot — one row holding the latest ranked result, so the
  // page renders instantly on load and across server restarts.
  `CREATE TABLE inbox_snapshot (
     id        INTEGER PRIMARY KEY CHECK (id = 1),
     synced_at INTEGER NOT NULL,
     payload   TEXT NOT NULL
   );`,
  // 3: settings + source caches, as a small JSON KV.
  `CREATE TABLE config (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // 4: projects — a named local folder, optionally tied to a GitHub repo.
  `CREATE TABLE projects (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     repo       TEXT NOT NULL DEFAULT '',
     path       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // 5: the watches engine (.docs/watches.md) — user-defined watches, the
  // persistent ingested items they (and external scanners) produce, and the
  // user-state overlay that survives every snapshot rebuild.
  `CREATE TABLE watches (
     id               TEXT PRIMARY KEY,
     source           TEXT NOT NULL,
     title            TEXT NOT NULL,
     scope            TEXT NOT NULL,
     instruction      TEXT NOT NULL,
     cadence          TEXT NOT NULL,
     window_start     TEXT,
     window_day       INTEGER,
     enabled          INTEGER NOT NULL DEFAULT 1,
     creates_items    INTEGER NOT NULL DEFAULT 1,
     cursor           TEXT,
     last_run_at      INTEGER,
     last_run_tokens  INTEGER,
     last_run_matches INTEGER,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL
   );
   CREATE TABLE ingested_items (
     id         TEXT PRIMARY KEY,
     updated_at INTEGER NOT NULL,
     payload    TEXT NOT NULL
   );
   CREATE TABLE item_state (
     item_id      TEXT PRIMARY KEY,
     status       TEXT NOT NULL,
     status_at    INTEGER NOT NULL,
     snooze_until INTEGER,
     pinned       INTEGER NOT NULL DEFAULT 0
   );`,
  // 6: the model a session runs on. NULL = Claude Code's own default, which
  // is not the same as any named model — an org can move it under us.
  `ALTER TABLE sessions ADD COLUMN model TEXT;
   ALTER TABLE sessions ADD COLUMN effort TEXT;`,
  // 7: how much a session asks before acting. NULL = 'default' (ask every
  // time), which is what every session predating this column was doing.
  `ALTER TABLE sessions ADD COLUMN permission_mode TEXT;`,
  // 8: pinned sessions — they sort above the rest, regardless of activity.
  `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`,
  // 9: user priority overrides (any item, survives re-sync) + manual items —
  // to-dos the user adds by hand, in their own editable table.
  `ALTER TABLE item_state ADD COLUMN priority INTEGER;
   CREATE TABLE manual_items (
     id         TEXT PRIMARY KEY,
     title      TEXT NOT NULL,
     project_id TEXT,
     note       TEXT,
     url        TEXT,
     priority   INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // 10: the durable inbox (.docs/watches-v2.md). One row per work item for
  // EVERY source (built-ins, watch hits, GitHub, manual), never hard-deleted;
  // lifecycle lives on the row and in an append-only per-item event log. This
  // supersedes ingested_items + item_state + manual_items + the slack.cache
  // config (all left in place, unused — a fresh start, no fold-forward). Watch
  // runs become real sessions (kind/watch_id on sessions); watches record each
  // run's status/session/error and a template origin.
  `CREATE TABLE work_items (
     id                TEXT PRIMARY KEY,
     source            TEXT NOT NULL,
     kind              TEXT NOT NULL,
     status            TEXT NOT NULL DEFAULT 'open',
     status_at         INTEGER NOT NULL,
     snooze_until      INTEGER,
     priority          INTEGER,
     pinned            INTEGER NOT NULL DEFAULT 0,
     returned          INTEGER NOT NULL DEFAULT 0,
     source_updated_at INTEGER NOT NULL,
     ingested_at       INTEGER NOT NULL,
     payload           TEXT NOT NULL,
     created_at        INTEGER NOT NULL,
     updated_at        INTEGER NOT NULL
   );
   CREATE INDEX idx_work_items_status ON work_items(status);
   CREATE INDEX idx_work_items_source ON work_items(source);
   CREATE TABLE item_events (
     item_id TEXT NOT NULL,
     seq     INTEGER NOT NULL,
     at      INTEGER NOT NULL,
     actor   TEXT NOT NULL,
     event   TEXT NOT NULL,
     detail  TEXT,
     PRIMARY KEY (item_id, seq)
   );
   ALTER TABLE sessions ADD COLUMN kind TEXT;
   ALTER TABLE sessions ADD COLUMN watch_id TEXT;
   ALTER TABLE watches ADD COLUMN last_run_status TEXT;
   ALTER TABLE watches ADD COLUMN last_run_session_id TEXT;
   ALTER TABLE watches ADD COLUMN last_run_error TEXT;
   ALTER TABLE watches ADD COLUMN template_id TEXT;`,
  // 11: per-run outcome on the (watch-run) session row, so the Activity view is
  // a true history of runs — each run is a session, and these are its receipt.
  `ALTER TABLE sessions ADD COLUMN run_status TEXT;
   ALTER TABLE sessions ADD COLUMN run_matches INTEGER;
   ALTER TABLE sessions ADD COLUMN run_tokens INTEGER;
   ALTER TABLE sessions ADD COLUMN run_error TEXT;`,
  // 12: cron schedule per watch — the precise fire schedule, superseding the
  // coarse hourly/daily/weekly cadence (old rows derive it from cadence).
  `ALTER TABLE watches ADD COLUMN schedule TEXT;`,
  // 13: fast mode per session — premium speed at premium price, so it is opt-in
  // per session and defaults off, including for every session that predates it.
  `ALTER TABLE sessions ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;`,
  // 14: artifacts + links (.docs/next-version.md, phase 1). `artifacts` is an
  // index over markdown files (the file is the truth); `links` is the one
  // polymorphic relation table for artifact↔item, artifact↔session and, from
  // phase 2, session↔item. IF NOT EXISTS because ensureDurableSchema also
  // converges these for DBs whose version counter got here another way.
  `CREATE TABLE IF NOT EXISTS artifacts (
     id         TEXT PRIMARY KEY,
     path       TEXT NOT NULL UNIQUE,
     title      TEXT NOT NULL,
     author     TEXT NOT NULL,
     refs       TEXT NOT NULL,
     created    INTEGER NOT NULL,
     updated    INTEGER NOT NULL,
     mtime      INTEGER NOT NULL,
     size       INTEGER NOT NULL,
     indexed_at INTEGER NOT NULL,
     warning    TEXT
   );
   CREATE TABLE IF NOT EXISTS links (
     id         TEXT PRIMARY KEY,
     from_kind  TEXT NOT NULL,
     from_id    TEXT NOT NULL,
     to_kind    TEXT NOT NULL,
     to_id      TEXT NOT NULL,
     role       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (from_kind, from_id, to_kind, to_id, role)
   );
   CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_kind, to_id);
   CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_kind, from_id);`,
  // 15: brief jobs (.docs/next-version.md, phase 2) — the FIFO queue and the
  // state machine for playbook runs, one row per run, newest = the item's brief.
  `CREATE TABLE IF NOT EXISTS brief_jobs (
     id          TEXT PRIMARY KEY,
     item_id     TEXT NOT NULL,
     status      TEXT NOT NULL,
     playbook    TEXT NOT NULL,
     model       TEXT,
     note        TEXT,
     session_id  TEXT,
     artifact_id TEXT,
     error       TEXT,
     created_at  INTEGER NOT NULL,
     started_at  INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS idx_brief_jobs_item ON brief_jobs(item_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS idx_brief_jobs_status ON brief_jobs(status, created_at);`,
  // 16: watches name the connectors they may use (their tool allowlist) and an
  // optional project, instead of one Slack place. Old rows were all Slack; a
  // channel scope folds into the instruction so the rule stays readable.
  `ALTER TABLE watches ADD COLUMN connectors TEXT;
   ALTER TABLE watches ADD COLUMN project_id TEXT;
   UPDATE watches SET instruction = 'In ' || scope || ': ' || instruction WHERE connectors IS NULL AND scope LIKE '#%';
   UPDATE watches SET connectors = '["slack"]' WHERE connectors IS NULL;`,
  // 17: what a watch run cost in dollars (the SDK's total_cost_usd on the result
  // message), so the watch page can show spend, not just tokens. Backfilled from
  // the event log — the result message is already persisted there.
  `ALTER TABLE sessions ADD COLUMN run_cost_usd REAL;
   UPDATE sessions SET run_cost_usd = (
     SELECT json_extract(e.payload, '$.message.total_cost_usd') FROM session_events e
     WHERE e.session_id = sessions.id AND e.kind = 'sdk' AND json_extract(e.payload, '$.message.type') = 'result'
     ORDER BY e.seq DESC LIMIT 1)
   WHERE kind = 'watch-run' AND run_cost_usd IS NULL;`,
  // 18: a watch may pin the model its runs use; NULL = Claude Code's default.
  `ALTER TABLE watches ADD COLUMN model TEXT;`,
  // 19: what a run produces — many items (default) or one rolling digest.
  `ALTER TABLE watches ADD COLUMN output TEXT;`,
  `CREATE TABLE IF NOT EXISTS session_turns (
     session_id TEXT NOT NULL,
     seq        INTEGER NOT NULL,
     root       TEXT NOT NULL,
     pre_tree   TEXT NOT NULL,
     post_tree  TEXT,
     started_at INTEGER NOT NULL,
     ended_at   INTEGER,
     touched    TEXT NOT NULL DEFAULT '[]',
     PRIMARY KEY (session_id, seq)
   );
   CREATE INDEX IF NOT EXISTS session_turns_root ON session_turns(root);`,
  // 21: watch-spec.md — tool grants, required project, scheduler hardening (start-time clock, catch-up, limits, streaks),
  // and run receipts that say why a run happened and how many finds were new.
  `ALTER TABLE watches ADD COLUMN tools TEXT;
   ALTER TABLE watches ADD COLUMN config_error TEXT;
   ALTER TABLE watches ADD COLUMN catch_up_window TEXT;
   ALTER TABLE watches ADD COLUMN timeout_ms INTEGER;
   ALTER TABLE watches ADD COLUMN max_budget_usd REAL;
   ALTER TABLE watches ADD COLUMN notify TEXT;
   ALTER TABLE watches ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE watches ADD COLUMN last_run_started_at INTEGER;
   ALTER TABLE watches ADD COLUMN last_run_new INTEGER;
   ALTER TABLE watches ADD COLUMN last_run_trigger TEXT;
   UPDATE watches SET last_run_started_at = last_run_at WHERE last_run_started_at IS NULL;
   ALTER TABLE sessions ADD COLUMN run_trigger TEXT;
   ALTER TABLE sessions ADD COLUMN run_new INTEGER;`,
]

export function openSqliteStore(file: string): Store {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  ensureDurableSchema(db)

  return {
    sessions: new SqliteSessions(db),
    events: new SqliteEvents(db),
    turns: new SqliteTurns(db),
    inbox: new SqliteInbox(db),
    config: new SqliteConfig(db),
    projects: new SqliteProjects(db),
    watches: new SqliteWatches(db),
    items: new SqliteWorkItems(db),
    artifacts: new SqliteArtifacts(db),
    links: new SqliteLinks(db),
    briefs: new SqliteBriefJobs(db),
    close: async () => db.close(),
  }
}

/**
 * Converge the durable-inbox schema regardless of migration-version state.
 *
 * Numbered migrations are positional, and this repo's DBs can arrive from
 * branches that already claimed the same version numbers for different tables
 * (e.g. an activity-log branch whose migration 10 created `scan_runs`). When
 * that happens the numbered runner skips *our* migration 10 as "already
 * applied" and `work_items` is never created. This runs after `migrate` and
 * makes the v2 schema present no matter how the version counter got there:
 * tables via IF NOT EXISTS, columns added only when missing. Idempotent, so on
 * a normally-migrated DB it is a no-op.
 */
function ensureDurableSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS work_items (
     id                TEXT PRIMARY KEY,
     source            TEXT NOT NULL,
     kind              TEXT NOT NULL,
     status            TEXT NOT NULL DEFAULT 'open',
     status_at         INTEGER NOT NULL,
     snooze_until      INTEGER,
     priority          INTEGER,
     pinned            INTEGER NOT NULL DEFAULT 0,
     returned          INTEGER NOT NULL DEFAULT 0,
     source_updated_at INTEGER NOT NULL,
     ingested_at       INTEGER NOT NULL,
     payload           TEXT NOT NULL,
     created_at        INTEGER NOT NULL,
     updated_at        INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
   CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items(source);
   CREATE TABLE IF NOT EXISTS item_events (
     item_id TEXT NOT NULL,
     seq     INTEGER NOT NULL,
     at      INTEGER NOT NULL,
     actor   TEXT NOT NULL,
     event   TEXT NOT NULL,
     detail  TEXT,
     PRIMARY KEY (item_id, seq)
   );`)

  db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
     id         TEXT PRIMARY KEY,
     path       TEXT NOT NULL UNIQUE,
     title      TEXT NOT NULL,
     author     TEXT NOT NULL,
     refs       TEXT NOT NULL,
     created    INTEGER NOT NULL,
     updated    INTEGER NOT NULL,
     mtime      INTEGER NOT NULL,
     size       INTEGER NOT NULL,
     indexed_at INTEGER NOT NULL,
     warning    TEXT
   );
   CREATE TABLE IF NOT EXISTS links (
     id         TEXT PRIMARY KEY,
     from_kind  TEXT NOT NULL,
     from_id    TEXT NOT NULL,
     to_kind    TEXT NOT NULL,
     to_id      TEXT NOT NULL,
     role       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (from_kind, from_id, to_kind, to_id, role)
   );
   CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_kind, to_id);
   CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_kind, from_id);
   CREATE TABLE IF NOT EXISTS brief_jobs (
     id          TEXT PRIMARY KEY,
     item_id     TEXT NOT NULL,
     status      TEXT NOT NULL,
     playbook    TEXT NOT NULL,
     model       TEXT,
     note        TEXT,
     session_id  TEXT,
     artifact_id TEXT,
     error       TEXT,
     created_at  INTEGER NOT NULL,
     started_at  INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS idx_brief_jobs_item ON brief_jobs(item_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS idx_brief_jobs_status ON brief_jobs(status, created_at);`)

  const cols = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name))
  const ensure = (table: string, col: string, decl: string, have: Set<string>) => {
    if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`)
  }

  const s = cols('sessions')
  ensure('sessions', 'kind', 'kind TEXT', s)
  ensure('sessions', 'watch_id', 'watch_id TEXT', s)
  ensure('sessions', 'run_status', 'run_status TEXT', s)
  ensure('sessions', 'run_matches', 'run_matches INTEGER', s)
  ensure('sessions', 'run_tokens', 'run_tokens INTEGER', s)
  ensure('sessions', 'run_error', 'run_error TEXT', s)
  ensure('sessions', 'run_cost_usd', 'run_cost_usd REAL', s)

  const w = cols('watches')
  ensure('watches', 'last_run_status', 'last_run_status TEXT', w)
  ensure('watches', 'last_run_session_id', 'last_run_session_id TEXT', w)
  ensure('watches', 'last_run_error', 'last_run_error TEXT', w)
  ensure('watches', 'template_id', 'template_id TEXT', w)
  ensure('watches', 'schedule', 'schedule TEXT', w)
  ensure('watches', 'connectors', 'connectors TEXT', w)
  ensure('watches', 'project_id', 'project_id TEXT', w)
  ensure('watches', 'model', 'model TEXT', w)
  ensure('watches', 'output', 'output TEXT', w)
  for (const [col, decl] of [
    ['tools', 'tools TEXT'], ['config_error', 'config_error TEXT'], ['catch_up_window', 'catch_up_window TEXT'],
    ['timeout_ms', 'timeout_ms INTEGER'], ['max_budget_usd', 'max_budget_usd REAL'], ['notify', 'notify TEXT'],
    ['consecutive_failures', 'consecutive_failures INTEGER NOT NULL DEFAULT 0'],
    ['last_run_started_at', 'last_run_started_at INTEGER'], ['last_run_new', 'last_run_new INTEGER'], ['last_run_trigger', 'last_run_trigger TEXT'],
  ]) ensure('watches', col, decl, w)
  ensure('sessions', 'run_trigger', 'run_trigger TEXT', s)
  ensure('sessions', 'run_new', 'run_new INTEGER', s)
}

function migrate(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v + 1, Date.now())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

type SessionRow = {
  id: string
  title: string
  cwd: string
  sdk_session_id: string | null
  model: string | null
  effort: string | null
  fast_mode: number
  permission_mode: string | null
  pinned: number
  kind: string | null
  watch_id: string | null
  run_status: string | null
  run_trigger: string | null
  run_matches: number | null
  run_new: number | null
  run_tokens: number | null
  run_cost_usd: number | null
  run_error: string | null
  created_at: number
  updated_at: number
}

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'gated']

/** Storage is text; anything the app no longer recognizes reads back as null. */
const toEffort = (v: string | null): EffortLevel | null =>
  EFFORTS.includes(v as EffortLevel) ? (v as EffortLevel) : null

/**
 * Same rule, and it matters more here: a mode we stop recognizing must fall
 * back to asking, never to a permissive mode inferred from a stale string.
 */
const toPermissionMode = (v: string | null): PermissionMode | null =>
  PERMISSION_MODES.includes(v as PermissionMode) ? (v as PermissionMode) : null

const toSession = (r: SessionRow): StoredSession => ({
  id: r.id,
  title: r.title,
  cwd: r.cwd,
  sdkSessionId: r.sdk_session_id,
  model: r.model,
  effort: toEffort(r.effort),
  fastMode: r.fast_mode === 1,
  permissionMode: toPermissionMode(r.permission_mode),
  pinned: r.pinned === 1,
  kind: r.kind === 'watch-run' || r.kind === 'brief' ? r.kind : 'chat',
  watchId: r.watch_id,
  runStatus: toRunStatus(r.run_status),
  runTrigger: toTrigger(r.run_trigger),
  runMatches: r.run_matches ?? undefined,
  runNew: r.run_new ?? undefined,
  runTokens: r.run_tokens ?? undefined,
  runCostUsd: r.run_cost_usd ?? undefined,
  runError: r.run_error ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

class SqliteSessions implements SessionStore {
  constructor(private db: DatabaseSync) {}

  async create(s: NewSession): Promise<StoredSession> {
    const now = Date.now()
    const model = s.model ?? null
    const effort = s.effort ?? null
    const fastMode = s.fastMode ?? false
    const permissionMode = s.permissionMode ?? null
    const kind: SessionKind = s.kind ?? 'chat'
    const watchId = s.watchId ?? null
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, cwd, sdk_session_id, model, effort, fast_mode, permission_mode, kind, watch_id, run_trigger, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title, s.cwd, model, effort, fastMode ? 1 : 0, permissionMode, kind, watchId, s.runTrigger ?? null, now, now)
    return {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      model,
      effort,
      fastMode,
      permissionMode,
      kind,
      watchId,
      ...(s.runTrigger ? { runTrigger: s.runTrigger } : {}),
      pinned: false,
      sdkSessionId: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  async get(id: string): Promise<StoredSession | null> {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return r ? toSession(r) : null
  }

  async list(): Promise<StoredSession[]> {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC')
      .all() as SessionRow[]
    return rows.map(toSession)
  }

  async setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id)
  }

  async setModel(id: string, model: string | null, effort: EffortLevel | null): Promise<void> {
    this.db.prepare('UPDATE sessions SET model = ?, effort = ? WHERE id = ?').run(model, effort, id)
  }

  async setFastMode(id: string, fastMode: boolean): Promise<void> {
    this.db.prepare('UPDATE sessions SET fast_mode = ? WHERE id = ?').run(fastMode ? 1 : 0, id)
  }

  async setPermissionMode(id: string, mode: PermissionMode | null): Promise<void> {
    this.db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run(mode, id)
  }

  async rename(id: string, title: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  }

  /**
   * Delete a session and its log. The event rows reference the session, so
   * they go first — with foreign keys on, the other order fails.
   */
  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM session_events WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  async touch(id: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  async recordWatchRun(id: string, run: WatchRunRecord): Promise<void> {
    this.db
      .prepare('UPDATE sessions SET run_status = ?, run_matches = ?, run_new = ?, run_tokens = ?, run_cost_usd = ?, run_error = ?, updated_at = ? WHERE id = ?')
      .run(run.status, run.matches, run.newCount ?? null, run.tokens, run.costUsd ?? null, run.error ?? null, Date.now(), id)
  }
}

type TurnRow = {
  session_id: string
  seq: number
  root: string
  pre_tree: string
  post_tree: string | null
  started_at: number
  ended_at: number | null
  touched: string
}

const turnFrom = (r: TurnRow): StoredTurn => ({
  sessionId: r.session_id,
  seq: r.seq,
  root: r.root,
  preTree: r.pre_tree,
  postTree: r.post_tree,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  touched: parseJsonArray(r.touched),
})

function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

class SqliteTurns implements TurnStore {
  constructor(private db: DatabaseSync) {}

  async begin(t: { sessionId: string; seq: number; root: string; preTree: string; startedAt: number }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO session_turns (session_id, seq, root, pre_tree, started_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO UPDATE SET root = excluded.root, pre_tree = excluded.pre_tree,
           started_at = excluded.started_at, post_tree = NULL, ended_at = NULL`,
      )
      .run(t.sessionId, t.seq, t.root, t.preTree, t.startedAt)
  }

  async end(
    sessionId: string,
    seq: number,
    post: { postTree: string | null; endedAt: number; touched: string[] },
  ): Promise<void> {
    this.db
      .prepare('UPDATE session_turns SET post_tree = ?, ended_at = ?, touched = ? WHERE session_id = ? AND seq = ?')
      .run(post.postTree, post.endedAt, JSON.stringify(post.touched), sessionId, seq)
  }

  async list(sessionId: string): Promise<StoredTurn[]> {
    const rows = this.db
      .prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as TurnRow[]
    return rows.map(turnFrom)
  }

  async othersInRoot(root: string, exceptSessionId: string): Promise<StoredTurn[]> {
    const rows = this.db
      .prepare('SELECT * FROM session_turns WHERE root = ? AND session_id != ? ORDER BY started_at')
      .all(root, exceptSessionId) as TurnRow[]
    return rows.map(turnFrom)
  }

  async lastSeq(sessionId: string): Promise<number> {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM session_turns WHERE session_id = ?')
      .get(sessionId) as { n: number }
    return r.n
  }

  async removeFor(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(sessionId)
  }
}

class SqliteEvents implements EventStore {
  constructor(private db: DatabaseSync) {}

  async append(sessionId: string, seq: number, event: SessionEvent): Promise<void> {
    this.db
      .prepare('INSERT INTO session_events (session_id, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, seq, event.kind, JSON.stringify(event), Date.now())
  }

  async read(sessionId: string, afterSeq = 0): Promise<StoredEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, payload, created_at FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, afterSeq) as { seq: number; payload: string; created_at: number }[]
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as SessionEvent, createdAt: r.created_at }))
  }

  async lastSeq(sessionId: string): Promise<number> {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM session_events WHERE session_id = ?')
      .get(sessionId) as { s: number }
    return r.s
  }
}

class SqliteInbox implements InboxStore {
  constructor(private db: DatabaseSync) {}

  async save(snapshot: InboxSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO inbox_snapshot (id, synced_at, payload) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET synced_at = excluded.synced_at, payload = excluded.payload`,
      )
      .run(snapshot.syncedAt, JSON.stringify({ items: snapshot.items, notices: snapshot.notices }))
  }

  async load(): Promise<InboxSnapshot | null> {
    const r = this.db.prepare('SELECT synced_at, payload FROM inbox_snapshot WHERE id = 1').get() as
      | { synced_at: number; payload: string }
      | undefined
    if (!r) return null
    const body = JSON.parse(r.payload) as Pick<InboxSnapshot, 'items' | 'notices'>
    return { syncedAt: r.synced_at, items: body.items, notices: body.notices }
  }
}

class SqliteConfig implements ConfigStore {
  constructor(private db: DatabaseSync) {}

  async get<T>(key: string): Promise<T | null> {
    const r = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return r ? (JSON.parse(r.value) as T) : null
  }

  async set(key: string, value: unknown): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value))
  }
}

type WatchRow = {
  id: string
  source: string
  title: string
  scope: string
  instruction: string
  cadence: string
  window_start: string | null
  window_day: number | null
  schedule: string | null
  enabled: number
  creates_items: number
  cursor: string | null
  last_run_at: number | null
  last_run_tokens: number | null
  last_run_matches: number | null
  last_run_status: string | null
  last_run_session_id: string | null
  last_run_error: string | null
  template_id: string | null
  connectors: string | null
  project_id: string | null
  model: string | null
  output: string | null
  tools: string | null
  config_error: string | null
  catch_up_window: string | null
  timeout_ms: number | null
  max_budget_usd: number | null
  notify: string | null
  consecutive_failures: number | null
  last_run_started_at: number | null
  last_run_new: number | null
  last_run_trigger: string | null
  created_at: number
  updated_at: number
}

const CONNECTORS = new Set<WatchConnector>(['slack', 'linear', 'github', 'web'])
/** Parse the stored connector list; a legacy row (NULL) was a Slack watch. */
function toConnectors(raw: string | null): WatchConnector[] {
  if (!raw) return ['slack']
  try {
    const arr = JSON.parse(raw) as unknown
    const out = Array.isArray(arr) ? arr.filter((c): c is WatchConnector => CONNECTORS.has(c as WatchConnector)) : []
    return out.length ? out : ['slack']
  } catch {
    return ['slack']
  }
}

const toRunStatus = (v: string | null): WatchRunStatus | undefined =>
  WATCH_RUN_STATUSES.includes(v as WatchRunStatus) ? (v as WatchRunStatus) : undefined

const TRIGGERS: WatchRunTrigger[] = ['scheduled', 'catch_up', 'manual']
const toTrigger = (v: string | null): WatchRunTrigger | undefined =>
  TRIGGERS.includes(v as WatchRunTrigger) ? (v as WatchRunTrigger) : undefined

/** Stored grants; a row from before grants (NULL) migrates from its legacy connectors. */
function toGrants(raw: string | null, legacy: string | null): WatchToolGrant[] {
  if (raw) {
    try {
      const parsed = grantsFrom(JSON.parse(raw))
      if ('grants' in parsed) return parsed.grants
    } catch {
      /* fall through to the legacy list */
    }
  }
  return grantsFromLegacy(toConnectors(legacy))
}

const toWatch = (r: WatchRow): Watch => ({
  id: r.id,
  source: 'slack',
  title: r.title,
  scope: r.scope,
  instruction: r.instruction,
  tools: toGrants(r.tools, r.connectors),
  // Required since watch-spec item 2; a legacy NULL is migrated to the scratch
  // project at boot, and reads as '' (no project) until then.
  projectId: r.project_id ?? '',
  ...(r.config_error ? { configError: r.config_error } : {}),
  ...(r.catch_up_window ? { catchUpWindow: r.catch_up_window } : {}),
  ...(r.timeout_ms != null ? { timeoutMs: r.timeout_ms } : {}),
  ...(r.max_budget_usd != null ? { maxBudgetUsd: r.max_budget_usd } : {}),
  notify: WATCH_NOTIFY.includes(r.notify as WatchNotify) ? (r.notify as WatchNotify) : 'on_failure',
  consecutiveFailures: r.consecutive_failures ?? 0,
  model: r.model ?? undefined,
  output: r.output === 'digest' ? 'digest' : 'items',
  cadence: r.cadence as WatchCadence,
  windowStart: r.window_start ?? undefined,
  windowDay: r.window_day ?? undefined,
  // Precise schedule is the source of truth; legacy rows derive it from cadence.
  schedule: r.schedule ?? cronFromCadence(r.cadence as WatchCadence, r.window_start ?? undefined, r.window_day ?? undefined),
  enabled: r.enabled === 1,
  createsItems: r.creates_items === 1,
  lastRunStartedAt: r.last_run_started_at ?? undefined,
  lastRunAt: r.last_run_at ?? undefined,
  lastRunNew: r.last_run_new ?? undefined,
  lastRunTrigger: toTrigger(r.last_run_trigger),
  lastRunTokens: r.last_run_tokens ?? undefined,
  lastRunMatches: r.last_run_matches ?? undefined,
  lastRunStatus: toRunStatus(r.last_run_status),
  lastRunSessionId: r.last_run_session_id ?? undefined,
  lastRunError: r.last_run_error ?? undefined,
  templateId: r.template_id ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

class SqliteWatches implements WatchStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<Watch[]> {
    const rows = this.db.prepare('SELECT * FROM watches ORDER BY created_at').all() as WatchRow[]
    return rows.map(toWatch)
  }

  async get(id: string): Promise<Watch | null> {
    const r = this.db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as WatchRow | undefined
    return r ? toWatch(r) : null
  }

  async create(w: Watch): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO watches (id, source, title, scope, instruction, cadence, window_start, window_day,
           schedule, enabled, creates_items, cursor, last_run_at, last_run_tokens, last_run_matches, template_id,
           tools, project_id, model, output, catch_up_window, timeout_ms, max_budget_usd, notify,
           config_error, last_run_started_at, consecutive_failures, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        w.id, w.source, w.title, w.scope, w.instruction, w.cadence,
        w.windowStart ?? null, w.windowDay ?? null,
        w.schedule,
        w.enabled ? 1 : 0, w.createsItems ? 1 : 0,
        w.templateId ?? null,
        JSON.stringify(w.tools), w.projectId || null, w.model ?? null, w.output,
        w.catchUpWindow ?? null, w.timeoutMs ?? null, w.maxBudgetUsd ?? null, w.notify,
        w.configError ?? null, w.lastRunStartedAt ?? null,
        w.createdAt, w.updatedAt,
      )
  }

  async update(id: string, patch: Partial<NewWatch> & { enabled?: boolean }): Promise<void> {
    const current = await this.get(id)
    if (!current) return
    const next = { ...current, ...patch }
    // null in a patch clears an optional limit back to "use the default"
    const opt = <T,>(v: T | null | undefined): T | null => (v === undefined || v === null ? null : v)
    this.db
      .prepare(
        `UPDATE watches SET title = ?, scope = ?, instruction = ?, cadence = ?, window_start = ?,
           window_day = ?, schedule = ?, enabled = ?, creates_items = ?, tools = ?, project_id = ?, model = ?, output = ?,
           catch_up_window = ?, timeout_ms = ?, max_budget_usd = ?, notify = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title, next.scope ?? '', next.instruction, next.cadence,
        next.windowStart ?? null, next.windowDay ?? null,
        next.schedule,
        next.enabled ? 1 : 0, next.createsItems ? 1 : 0,
        JSON.stringify(next.tools), next.projectId || null, next.model ?? null, next.output ?? 'items',
        opt(next.catchUpWindow), opt(next.timeoutMs), opt(next.maxBudgetUsd), next.notify ?? 'on_failure',
        Date.now(), id,
      )
  }

  async patchState(id: string, patch: WatchStatePatch): Promise<void> {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0) }
    if (patch.configError !== undefined) { sets.push('config_error = ?'); vals.push(patch.configError) }
    if (patch.lastRunStartedAt !== undefined) { sets.push('last_run_started_at = ?'); vals.push(patch.lastRunStartedAt) }
    if (patch.projectId !== undefined) { sets.push('project_id = ?'); vals.push(patch.projectId) }
    if (!sets.length) return
    this.db.prepare(`UPDATE watches SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  async markRunStarted(id: string, start: WatchRunStart): Promise<void> {
    this.db
      .prepare(
        `UPDATE watches SET last_run_started_at = ?, last_run_trigger = COALESCE(?, last_run_trigger),
           last_run_session_id = COALESCE(?, last_run_session_id) WHERE id = ?`,
      )
      .run(start.startedAt, start.trigger ?? null, start.sessionId ?? null, id)
  }

  /**
   * Write back one run attempt. Status/session/error are always recorded so the
   * list can tell "looked, found nothing" from "the scan broke". The failure
   * streak counts failed/timeout runs in a row; an ok run resets it; skips and
   * interruptions leave it alone.
   */
  async recordRun(id: string, run: WatchRunResult): Promise<void> {
    const streak =
      run.status === 'ok' ? '0' : run.status === 'failed' || run.status === 'timeout' ? 'consecutive_failures + 1' : 'consecutive_failures'
    this.db
      .prepare(
        `UPDATE watches SET last_run_at = ?, last_run_tokens = ?, last_run_matches = ?, last_run_new = ?,
           last_run_status = ?, last_run_session_id = COALESCE(?, last_run_session_id), last_run_error = ?,
           last_run_trigger = COALESCE(?, last_run_trigger), consecutive_failures = ${streak} WHERE id = ?`,
      )
      .run(run.lastRunAt, run.lastRunTokens, run.lastRunMatches, run.lastRunNew ?? null,
        run.status, run.sessionId ?? null, run.error ?? null, run.trigger ?? null, id)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM watches WHERE id = ?').run(id)
  }
}

type WorkItemRow = {
  id: string
  source: string
  kind: string
  status: string
  status_at: number
  snooze_until: number | null
  priority: number | null
  pinned: number
  returned: number
  source_updated_at: number
  ingested_at: number
  payload: string
  created_at: number
  updated_at: number
}

const VALID_STATUSES: ItemStatus[] = ['open', 'snoozed', 'done', 'archived']
const toStatus = (v: string): ItemStatus =>
  VALID_STATUSES.includes(v as ItemStatus) ? (v as ItemStatus) : 'open'

/**
 * Project a row into the rendered WorkItem. The payload holds the source-shaped
 * fields; the columns are authoritative for lifecycle (status/returned/priority/
 * ingestedAt), so they overwrite whatever the payload happened to carry.
 */
function toWorkItem(r: WorkItemRow): WorkItem {
  const base = JSON.parse(r.payload) as WorkItem
  // `note` is the pre-0.7 name of `description` on manual items; read it as a fallback.
  const description = base.description ?? base.note
  return {
    ...base,
    ...(description ? { description } : {}),
    status: toStatus(r.status),
    returned: r.returned === 1,
    ...(r.priority != null ? { priority: r.priority } : {}),
    ingestedAt: r.ingested_at,
  }
}

/** Lifecycle fields live in columns, not the payload — strip before storing. */
function payloadOf(item: WorkItem): string {
  const { status, returned, priority, ingestedAt, ...rest } = item
  void status; void returned; void priority; void ingestedAt
  return JSON.stringify(rest)
}

/** Append `add` to a provenance list, replacing an entry from the same run. */
function mergeProvenance(existing: Provenance[] | undefined, add?: Provenance): Provenance[] {
  const list = existing ? [...existing] : []
  if (!add) return list
  const key = (p: Provenance) => `${p.watchId ?? ''}|${p.runId ?? ''}`
  const i = list.findIndex((p) => key(p) === key(add))
  if (i >= 0) list[i] = add
  else list.push(add)
  return list.slice(-10)
}

/** Who an ingestion transition is attributed to. */
function upsertActor(p: Provenance | undefined): string {
  if (p?.runId) return `watch:${p.runId}`
  if (p?.watchId) return `watch:${p.watchId}`
  return 'system'
}

const evDetail = (p?: Provenance): Record<string, unknown> =>
  p ? { ...(p.watchId ? { watchId: p.watchId } : {}), ...(p.runId ? { runId: p.runId } : {}), ...(p.why ? { why: p.why } : {}) } : {}

/**
 * The durable inbox: one row per work item, an append-only event log per item.
 * Never hard-deletes; the idempotent upsert and deterministic reopen rules live
 * here (.docs/watches-v2.md).
 */
class SqliteWorkItems implements WorkItemStore {
  constructor(private db: DatabaseSync) {}

  private row(id: string): WorkItemRow | undefined {
    return this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItemRow | undefined
  }

  private appendEvent(
    itemId: string,
    at: number,
    actor: string,
    event: ItemEventKind,
    detail: Record<string, unknown>,
  ): void {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM item_events WHERE item_id = ?')
      .get(itemId) as { s: number }
    this.db
      .prepare('INSERT INTO item_events (item_id, seq, at, actor, event, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(itemId, r.s + 1, at, actor, event, Object.keys(detail).length ? JSON.stringify(detail) : null)
  }

  async upsert(item: WorkItem, provenance?: Provenance): Promise<UpsertResult> {
    const incoming = Date.parse(item.updatedAt)
    if (!Number.isFinite(incoming)) return { outcome: 'unchanged', reopened: false }
    const now = Date.now()
    const actor = upsertActor(provenance)
    const existing = this.row(item.id)

    if (!existing) {
      const foundBy = mergeProvenance(item.foundBy, provenance)
      const stored: WorkItem = { ...item, why: provenance?.why ?? item.why, foundBy }
      this.db
        .prepare(
          `INSERT INTO work_items (id, source, kind, status, status_at, snooze_until, priority, pinned,
             returned, source_updated_at, ingested_at, payload, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, NULL, ?, 0, 0, ?, ?, ?, ?, ?)`,
        )
        .run(item.id, item.source, item.kind, now, item.priority ?? null, incoming, now, payloadOf(stored), now, now)
      this.appendEvent(item.id, now, actor, 'created', evDetail(provenance))
      return { outcome: 'inserted', reopened: false }
    }

    const base = JSON.parse(existing.payload) as WorkItem
    const foundBy = mergeProvenance(base.foundBy, provenance)
    const newer = incoming > existing.source_updated_at
    const reopened = newer && shouldReopen(toStatus(existing.status), incoming, existing.status_at)

    if (!newer && !provenance) return { outcome: 'unchanged', reopened: false }

    const stored: WorkItem = newer
      ? {
          ...base,
          kind: item.kind,
          title: item.title,
          url: item.url,
          repo: item.repo,
          author: item.author,
          peopleWaiting: item.peopleWaiting,
          updatedAt: item.updatedAt,
          isDraft: item.isDraft,
          ciFailing: item.ciFailing,
          refs: item.refs ?? base.refs,
          why: provenance?.why ?? item.why ?? base.why,
          foundBy,
        }
      : { ...base, why: provenance?.why ?? base.why, foundBy }

    if (reopened) {
      this.db
        .prepare(
          `UPDATE work_items SET kind = ?, source_updated_at = ?, payload = ?, status = 'open',
             status_at = ?, returned = 1, updated_at = ? WHERE id = ?`,
        )
        .run(item.kind, incoming, payloadOf(stored), now, now, item.id)
      this.appendEvent(item.id, now, actor, 'reopened', { sourceUpdatedAt: incoming, ...evDetail(provenance) })
    } else if (newer) {
      this.db
        .prepare('UPDATE work_items SET kind = ?, source_updated_at = ?, payload = ?, updated_at = ? WHERE id = ?')
        .run(item.kind, incoming, payloadOf(stored), now, item.id)
      this.appendEvent(item.id, now, actor, 'updated', evDetail(provenance))
    } else {
      // provenance-only re-find: refresh foundBy/why, no new source activity, no event
      this.db
        .prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?')
        .run(payloadOf(stored), now, item.id)
    }
    return { outcome: 'updated', reopened }
  }

  async createManual(item: NewManualItem): Promise<string> {
    const now = Date.now()
    const iso = new Date(now).toISOString()
    const wi: WorkItem = {
      id: item.id,
      source: 'manual',
      kind: 'manual',
      title: item.title,
      url: item.url ?? '',
      repo: '',
      author: '',
      peopleWaiting: 0,
      createdAt: iso,
      updatedAt: iso,
      ...(item.projectId ? { projectId: item.projectId } : {}),
      ...(item.description ? { description: item.description, why: item.description } : {}),
      ...(item.urls?.length ? { urls: item.urls } : {}),
    }
    this.db
      .prepare(
        `INSERT INTO work_items (id, source, kind, status, status_at, snooze_until, priority, pinned,
           returned, source_updated_at, ingested_at, payload, created_at, updated_at)
         VALUES (?, 'manual', 'manual', 'open', ?, NULL, ?, 0, 0, ?, ?, ?, ?, ?)`,
      )
      .run(item.id, now, item.priority || null, now, now, payloadOf(wi), now, now)
    this.appendEvent(item.id, now, 'user', 'created', {})
    return item.id
  }

  async updateManual(id: string, patch: Partial<Omit<NewManualItem, 'id'>>): Promise<void> {
    const r = this.row(id)
    if (!r) return
    const base = JSON.parse(r.payload) as WorkItem
    const next: WorkItem = { ...base }
    if (patch.title !== undefined) next.title = patch.title
    if (patch.url !== undefined) next.url = patch.url
    if (patch.urls !== undefined) next.urls = patch.urls.length > 0 ? patch.urls : undefined
    if (patch.description !== undefined) {
      next.description = patch.description || undefined
      // manual items show the description as their "why" on the card
      next.why = patch.description || undefined
      delete next.note
    }
    if (patch.projectId !== undefined) next.projectId = patch.projectId || undefined
    const priority = patch.priority !== undefined ? patch.priority || null : r.priority
    this.db
      .prepare('UPDATE work_items SET payload = ?, priority = ?, updated_at = ? WHERE id = ?')
      .run(payloadOf(next), priority, Date.now(), id)
  }

  async get(id: string): Promise<WorkItem | null> {
    const r = this.row(id)
    return r ? toWorkItem(r) : null
  }

  async list(status: ItemStatus = 'open'): Promise<WorkItem[]> {
    const rows = this.db
      .prepare('SELECT * FROM work_items WHERE status = ? ORDER BY source_updated_at DESC')
      .all(status) as WorkItemRow[]
    return rows.map(toWorkItem)
  }

  async listAll(): Promise<WorkItem[]> {
    const rows = this.db
      .prepare('SELECT * FROM work_items ORDER BY source_updated_at DESC')
      .all() as WorkItemRow[]
    return rows.map(toWorkItem)
  }

  async transition(id: string, change: StatusChange): Promise<void> {
    if (!this.row(id)) return
    const now = Date.now()
    const snooze = change.status === 'snoozed' ? change.snoozeUntil ?? null : null
    this.db
      .prepare(
        'UPDATE work_items SET status = ?, status_at = ?, snooze_until = ?, returned = 0, updated_at = ? WHERE id = ?',
      )
      .run(change.status, now, snooze, now, id)
    this.appendEvent(id, now, change.actor, eventForStatus(change.status), {
      ...(change.snoozeUntil ? { snoozeUntil: change.snoozeUntil } : {}),
      ...(change.detail ?? {}),
    })
  }

  async setPriority(id: string, priority: number | null): Promise<void> {
    this.db.prepare('UPDATE work_items SET priority = ?, updated_at = ? WHERE id = ?').run(priority, Date.now(), id)
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.db.prepare('UPDATE work_items SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, Date.now(), id)
  }

  async wakeSnoozed(now: number): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT id FROM work_items WHERE status = ? AND snooze_until IS NOT NULL AND snooze_until <= ?')
      .all('snoozed', now) as { id: string }[]
    const upd = this.db.prepare(
      "UPDATE work_items SET status = 'open', snooze_until = NULL, status_at = ?, updated_at = ? WHERE id = ?",
    )
    for (const { id } of rows) {
      upd.run(now, now, id)
      this.appendEvent(id, now, 'system', 'woken', {})
    }
    return rows.map((r) => r.id)
  }

  async events(id: string): Promise<ItemEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, at, actor, event, detail FROM item_events WHERE item_id = ? ORDER BY seq')
      .all(id) as { seq: number; at: number; actor: string; event: string; detail: string | null }[]
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      actor: r.actor,
      event: r.event as ItemEventKind,
      ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
    }))
  }

  async setDescription(id: string, description: string | null): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const base = JSON.parse(r.payload) as WorkItem
    const next: WorkItem = { ...base }
    delete next.note
    if (description) next.description = description
    else delete next.description
    // A manual item's card quotes its description as the "why"; source items keep the scanner's.
    if (base.source === 'manual') next.why = description || undefined
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }

  async setImages(id: string, images: ItemImage[]): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const next: WorkItem = { ...(JSON.parse(r.payload) as WorkItem) }
    if (images.length > 0) next.images = images
    else delete next.images
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }

  async setUrls(id: string, urls: string[]): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const next: WorkItem = { ...(JSON.parse(r.payload) as WorkItem) }
    if (urls.length > 0) next.urls = urls
    else delete next.urls
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }
}

class SqliteProjects implements ProjectStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<Project[]> {
    const rows = this.db
      .prepare('SELECT id, name, repo, path FROM projects ORDER BY name COLLATE NOCASE')
      .all() as Project[]
    return rows.map((r) => ({ id: r.id, name: r.name, repo: r.repo, path: r.path }))
  }

  async create(p: Project): Promise<void> {
    this.db
      .prepare('INSERT INTO projects (id, name, repo, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.id, p.name, p.repo, p.path, Date.now())
  }

  async retireBuiltin(): Promise<Project[]> {
    // A short-lived dev build added a `builtin` column and a scratch project;
    // projects are always real folders now. Remove those rows, if any.
    const cols = new Set((this.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((r) => r.name))
    if (!cols.has('builtin')) return []
    const rows = this.db.prepare('SELECT id, name, repo, path FROM projects WHERE builtin = 1').all() as Project[]
    this.db.prepare('DELETE FROM projects WHERE builtin = 1').run()
    return rows
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}

// ---------------------------------------------------------------------------
// Artifacts index + links (.docs/next-version.md, phase 1)
// ---------------------------------------------------------------------------

type ArtifactRow = {
  id: string
  path: string
  title: string
  author: string
  refs: string
  created: number
  updated: number
  mtime: number
  size: number
  indexed_at: number
  warning: string | null
}

const toArtifact = (r: ArtifactRow): Artifact => ({
  id: r.id,
  path: r.path,
  title: r.title,
  author: isArtifactAuthor(r.author) ? r.author : 'human',
  refs: (() => {
    try {
      const v: unknown = JSON.parse(r.refs)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })(),
  created: r.created,
  updated: r.updated,
  mtime: r.mtime,
  size: r.size,
  ...(r.warning ? { warning: r.warning } : {}),
})

class SqliteArtifacts implements ArtifactStore {
  constructor(private db: DatabaseSync) {}

  async upsert(a: Artifact): Promise<void> {
    // A different file now lives at this path (replaced, or re-created without
    // its id): the old row is stale and would violate the UNIQUE(path).
    this.db.prepare('DELETE FROM artifacts WHERE path = ? AND id != ?').run(a.path, a.id)
    this.db
      .prepare(
        `INSERT INTO artifacts (id, path, title, author, refs, created, updated, mtime, size, indexed_at, warning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path, title = excluded.title, author = excluded.author, refs = excluded.refs,
           created = excluded.created, updated = excluded.updated, mtime = excluded.mtime,
           size = excluded.size, indexed_at = excluded.indexed_at, warning = excluded.warning`,
      )
      .run(a.id, a.path, a.title, a.author, JSON.stringify(a.refs), a.created, a.updated, a.mtime, a.size, Date.now(), a.warning ?? null)
  }

  async get(id: string): Promise<Artifact | null> {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined
    return r ? toArtifact(r) : null
  }

  async getByPath(p: string): Promise<Artifact | null> {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE path = ?').get(p) as ArtifactRow | undefined
    return r ? toArtifact(r) : null
  }

  async list(): Promise<Artifact[]> {
    const rows = this.db.prepare('SELECT * FROM artifacts ORDER BY updated DESC, title COLLATE NOCASE').all() as ArtifactRow[]
    return rows.map(toArtifact)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id)
  }
}

type LinkRow = {
  id: string
  from_kind: string
  from_id: string
  to_kind: string
  to_id: string
  role: string
  created_at: number
}

const toLink = (r: LinkRow): Link => ({
  id: r.id,
  fromKind: isLinkKind(r.from_kind) ? r.from_kind : 'artifact',
  fromId: r.from_id,
  toKind: isLinkKind(r.to_kind) ? r.to_kind : 'item',
  toId: r.to_id,
  role: isLinkRole(r.role) ? r.role : 'context',
  createdAt: r.created_at,
})

class SqliteLinks implements LinkStore {
  constructor(private db: DatabaseSync) {}

  async add(l: NewLink): Promise<Link> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO links (id, from_kind, from_id, to_kind, to_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), l.fromKind, l.fromId, l.toKind, l.toId, l.role, Date.now())
    const r = this.db
      .prepare('SELECT * FROM links WHERE from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ? AND role = ?')
      .get(l.fromKind, l.fromId, l.toKind, l.toId, l.role) as LinkRow
    return toLink(r)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id)
  }

  async removeFor(kind: LinkKind, id: string): Promise<void> {
    this.db
      .prepare('DELETE FROM links WHERE (from_kind = ? AND from_id = ?) OR (to_kind = ? AND to_id = ?)')
      .run(kind, id, kind, id)
  }

  async forTarget(kind: LinkKind, id: string): Promise<Link[]> {
    const rows = this.db.prepare('SELECT * FROM links WHERE to_kind = ? AND to_id = ? ORDER BY created_at').all(kind, id) as LinkRow[]
    return rows.map(toLink)
  }

  async forSource(kind: LinkKind, id: string): Promise<Link[]> {
    const rows = this.db.prepare('SELECT * FROM links WHERE from_kind = ? AND from_id = ? ORDER BY created_at').all(kind, id) as LinkRow[]
    return rows.map(toLink)
  }

  async list(): Promise<Link[]> {
    return (this.db.prepare('SELECT * FROM links ORDER BY created_at').all() as LinkRow[]).map(toLink)
  }
}

// ---------------------------------------------------------------------------
// Brief jobs (.docs/next-version.md, phase 2)
// ---------------------------------------------------------------------------

type BriefJobRow = {
  id: string
  item_id: string
  status: string
  playbook: string
  model: string | null
  note: string | null
  session_id: string | null
  artifact_id: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

const BRIEF_STATUS_SET = new Set<string>(['queued', 'running', 'ready', 'failed'])

const toBriefJob = (r: BriefJobRow): BriefJob => ({
  id: r.id,
  itemId: r.item_id,
  status: BRIEF_STATUS_SET.has(r.status) ? (r.status as BriefStatus) : 'failed',
  playbook: r.playbook,
  model: r.model,
  note: r.note,
  sessionId: r.session_id,
  artifactId: r.artifact_id,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
})

class SqliteBriefJobs implements BriefJobStore {
  constructor(private db: DatabaseSync) {}

  private row(id: string): BriefJobRow | undefined {
    return this.db.prepare('SELECT * FROM brief_jobs WHERE id = ?').get(id) as BriefJobRow | undefined
  }

  async create(j: NewBriefJob): Promise<BriefJob> {
    this.db
      .prepare(
        `INSERT INTO brief_jobs (id, item_id, status, playbook, model, note, created_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(j.id, j.itemId, j.playbook, j.model ?? null, j.note ?? null, Date.now())
    return toBriefJob(this.row(j.id)!)
  }

  async get(id: string): Promise<BriefJob | null> {
    const r = this.row(id)
    return r ? toBriefJob(r) : null
  }

  async latestForItem(itemId: string): Promise<BriefJob | null> {
    const r = this.db
      .prepare('SELECT * FROM brief_jobs WHERE item_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(itemId) as BriefJobRow | undefined
    return r ? toBriefJob(r) : null
  }

  async forSession(sessionId: string): Promise<BriefJob | null> {
    const r = this.db
      .prepare('SELECT * FROM brief_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as BriefJobRow | undefined
    return r ? toBriefJob(r) : null
  }

  async latestPerItem(): Promise<BriefJob[]> {
    const rows = this.db
      .prepare(
        `SELECT b.* FROM brief_jobs b
         JOIN (SELECT item_id, MAX(created_at) AS c FROM brief_jobs GROUP BY item_id) m
           ON m.item_id = b.item_id AND m.c = b.created_at
         ORDER BY b.created_at DESC`,
      )
      .all() as BriefJobRow[]
    return rows.map(toBriefJob)
  }

  async list(status?: BriefStatus): Promise<BriefJob[]> {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM brief_jobs WHERE status = ? ORDER BY created_at').all(status)
        : this.db.prepare('SELECT * FROM brief_jobs ORDER BY created_at').all()
    ) as BriefJobRow[]
    return rows.map(toBriefJob)
  }

  async countStartedSince(sinceMs: number): Promise<number> {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM brief_jobs WHERE started_at IS NOT NULL AND started_at >= ?')
      .get(sinceMs) as { n: number }
    return r.n
  }

  async update(id: string, patch: Partial<Omit<BriefJob, 'id' | 'itemId' | 'playbook'>>): Promise<void> {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    const col: Record<string, string> = {
      status: 'status',
      model: 'model',
      note: 'note',
      sessionId: 'session_id',
      artifactId: 'artifact_id',
      error: 'error',
      createdAt: 'created_at',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in col) || v === undefined) continue
      sets.push(`${col[k]} = ?`)
      vals.push(v as string | number | null)
    }
    if (!sets.length) return
    vals.push(id)
    this.db.prepare(`UPDATE brief_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  async failAllRunning(error: string): Promise<string[]> {
    const rows = this.db.prepare("SELECT id FROM brief_jobs WHERE status = 'running'").all() as { id: string }[]
    const now = Date.now()
    const upd = this.db.prepare("UPDATE brief_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
    for (const { id } of rows) upd.run(error, now, id)
    return rows.map((r) => r.id)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM brief_jobs WHERE id = ?').run(id)
  }
}
