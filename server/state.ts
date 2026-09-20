/**
 * Shared between the CLI (server/cli.ts) and the server (server/index.ts):
 * where the daemon's state and log files live, and the health-check contract
 * the CLI uses to tell "triage is already running" apart from "something
 * else owns the port".
 *
 * The state file is never the source of truth for "is triage running" —
 * GET /api/health is. The state file only records which port (and pid) the
 * last server started on, so stop/status can find a non-default port after
 * the shell that started it is gone.
 */
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 5178
/** TRIAGE_HOME relocates the whole state root (registry, workspaces, logs) — used by tests. */
export const TRIAGE_DIR = process.env.TRIAGE_HOME || path.join(os.homedir(), '.triage')
export const STATE_FILE = path.join(TRIAGE_DIR, 'server.json')
export const LOG_FILE = path.join(TRIAGE_DIR, 'server.log')

export interface ServerState {
  pid: number
  port: number
  version: string
  startedAt: string
}

export interface Health {
  app: 'triage'
  version: string
  pid: number
  port: number
  db: string
  liveSessions: number
}

/**
 * package.json version. This file lives at <repo>/server/state.ts in dev and
 * <pkg>/dist/server/state.js when published, so the package root is one or
 * two levels up.
 */
export function pkgVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const dir of [path.join(here, '..'), path.join(here, '..', '..')]) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (pkg.name === 'usetriage') return pkg.version
    } catch {
      // keep walking up
    }
  }
  return 'unknown'
}

export async function writeState(state: ServerState) {
  await mkdir(TRIAGE_DIR, { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
}

export async function readState(): Promise<ServerState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

/** Remove the state file, but only if it still points at `pid`. */
export async function clearState(pid: number) {
  const state = await readState()
  if (state?.pid === pid) await rm(STATE_FILE, { force: true })
}

/**
 * Ask whoever is listening on `port` whether they are a triage server.
 * Three outcomes: a Health body (triage is running), 'other' (the port
 * answers but not with our health contract), null (nothing is listening).
 */
export async function checkHealth(port: number): Promise<Health | 'other' | null> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    })
    const body: unknown = await res.json().catch(() => null)
    return isHealth(body) ? body : 'other'
  } catch (err) {
    // A timeout means something holds the port but won't answer HTTP —
    // that is "other", not "free". Connection refused means nothing listens.
    return (err as { name?: string })?.name === 'TimeoutError' ? 'other' : null
  }
}

function isHealth(body: unknown): body is Health {
  return typeof body === 'object' && body !== null && (body as Health).app === 'triage'
}
