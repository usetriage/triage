/**
 * Watches — user-defined ingestion rules (.docs/watches.md, watch-spec.md). A
 * watch is plain-English instructions, a schedule, the tools its runs may call,
 * and the project folder its runs work in. Server-managed rows → SQLite.
 */
import type { WatchToolGrant } from './tools.js'

export type { WatchToolGrant } from './tools.js'

export type WatchCadence = 'hourly' | 'daily' | 'weekly'

/** Legacy (pre-grants) connector ids; old rows are migrated to tool grants. */
export type WatchConnector = 'slack' | 'linear' | 'github' | 'web'

/**
 * What a run produces. `items`: one work item per match, deduped by the link
 * it passes. `digest`: ONE rolling work item per watch with a markdown report
 * attached; each run rewrites the report and the item returns to the inbox.
 */
export type WatchOutput = 'items' | 'digest'
export const WATCH_OUTPUTS: WatchOutput[] = ['items', 'digest']

/** The outcome of one watch run (watch-spec.md, item 3). */
export type WatchRunStatus = 'ok' | 'failed' | 'timeout' | 'skipped' | 'interrupted'
export const WATCH_RUN_STATUSES: WatchRunStatus[] = ['ok', 'failed', 'timeout', 'skipped', 'interrupted']

/** Why a run happened. */
export type WatchRunTrigger = 'scheduled' | 'catch_up' | 'manual'

export type WatchNotify = 'never' | 'on_failure' | 'always'
export const WATCH_NOTIFY: WatchNotify[] = ['never', 'on_failure', 'always']

/** Built-in run limits when neither the watch nor the workspace sets one. */
export const DEFAULT_WATCH_TIMEOUT_MS = 240_000
export const MAX_WATCH_TIMEOUT_MS = 60 * 60_000

export interface Watch {
  id: string
  /** v0.2: slack only (connector-neutral machinery; Slack lives in the prompt) */
  source: 'slack'
  /** "PX topics in #novus-px" */
  title: string
  /**
   * Legacy (pre-connectors) place hint: '#channel' | '@dm'. Empty for watches
   * created since; kept so old rows still say where they used to look.
   */
  scope: string
  /** the NL instructions: where to look and what counts; editable forever */
  instruction: string
  /** the tools runs may call, resolved at save time (never empty) */
  tools: WatchToolGrant[]
  /** the project whose folder every run works in, and nowhere else */
  projectId: string
  /** set when the watch cannot run until the user fixes it (e.g. its project was removed) */
  configError?: string
  /** skip a missed slot older than this: "6h" | "never" | "unlimited"; omitted = default by output */
  catchUpWindow?: string
  /** per-run limits; omitted = the workspace default */
  timeoutMs?: number
  maxBudgetUsd?: number
  /** when to post a macOS notification about a run */
  notify: WatchNotify
  /** model alias or wire id for the run; omitted = Claude Code's own default */
  model?: string
  /** items (default) or one rolling digest with a report */
  output: WatchOutput
  /**
   * A 5-field cron expression, the source of truth for when the watch runs
   * (.docs/watches-v2.md). Legacy rows without one derive it from `cadence`.
   */
  schedule: string
  /** legacy coarse cadence; retained for back-compat / draft suggestions */
  cadence: WatchCadence
  /** daily/weekly: local time "09:00" */
  windowStart?: string
  /** weekly: 0-6 (JS getDay convention, Sunday = 0) */
  windowDay?: number
  enabled: boolean
  /** false = FYI-only rows (fyi kind, base score 5) */
  createsItems: boolean
  /** epoch ms the last run STARTED (or was skipped) — what the due rule reads */
  lastRunStartedAt?: number
  /** epoch ms the last run attempt finished (any status) */
  lastRunAt?: number
  /** items the last run filed that were not already in the inbox */
  lastRunNew?: number
  /** why the last run happened */
  lastRunTrigger?: WatchRunTrigger
  /** failed/timeout runs in a row; reset by an ok run */
  consecutiveFailures: number
  /** what the last run cost/produced, surfaced in the watch list UI */
  lastRunTokens?: number
  lastRunMatches?: number
  /** the last run's outcome, so the list can show ok/failed honestly */
  lastRunStatus?: WatchRunStatus
  /** the session id of the last run, for opening its transcript */
  lastRunSessionId?: string
  /** the last run's error message, when it failed */
  lastRunError?: string
  /** the template this watch was seeded from (pre-installed as a copy), if any */
  templateId?: string
  createdAt: number
  updatedAt: number
}

export type NewWatch = Pick<Watch, 'title' | 'instruction' | 'schedule' | 'createsItems' | 'tools' | 'projectId'> & {
  /** legacy place hint; new watches leave it empty */
  scope?: string
  model?: string
  output?: WatchOutput
  catchUpWindow?: string | null
  timeoutMs?: number | null
  maxBudgetUsd?: number | null
  notify?: WatchNotify
  /** legacy; defaults to a coarse bucket when omitted */
  cadence?: WatchCadence
  windowStart?: string
  windowDay?: number
}

/**
 * What one finished (or skipped, or interrupted) run attempt writes back to the
 * row. Runs are stateless (watch-spec.md, item 4): nothing here feeds the next
 * run's prompt.
 */
export interface WatchRunResult {
  lastRunAt: number
  lastRunTokens: number
  lastRunMatches: number
  /** of the matches, how many were new to the inbox */
  lastRunNew?: number
  status: WatchRunStatus
  trigger?: WatchRunTrigger
  sessionId?: string
  error?: string
}

/** What starting (or skipping) a slot writes: the due rule's clock. */
export interface WatchRunStart {
  startedAt: number
  trigger?: WatchRunTrigger
  sessionId?: string
}

/** The draft step's parse of a plain-text wish — every field stays editable. */
export interface WatchDraft {
  title: string
  scope: string
  instruction: string
  cadence: WatchCadence
  createsItems: boolean
}

/** One thread a preview run would have matched, with its why-line. */
export interface WatchPreviewRow {
  /** the canonical id the real run would file under */
  id: string
  title: string
  url: string
  place: string
  from: string
  lastActivity: string
  why: string
}

/** What a dry run returns: the would-be items or the would-be digest, and what it cost. Nothing is saved. */
export interface WatchPreviewResult {
  output: WatchOutput
  rows: WatchPreviewRow[]
  digest?: { title: string; body: string }
  tokens: number
  costUsd?: number
  durationMs: number
}
