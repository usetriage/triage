// `npm run dev:copy-prod` — seed the dev data root (~/.triage-dev, see
// dev-home.mjs) from prod's ~/.triage, so dev runs against real workspaces
// without its migrations, watches or phone pairing ever touching prod.
//
// Copied: the workspace registry and every workspace folder (artifacts, agents,
// teams, playbooks, dispatch, attachments, claude/, .env kept at 0600). Each
// triage.db is snapshotted with VACUUM INTO — a consistent copy that includes
// rows still in the WAL, safe while prod is running — never cp'd.
// Not copied: server.json, server.log, remote.json, ngrok.pid, logs/ — those
// belong to the process that writes them.
//
//   npm run dev:copy-prod              refuses if the dev root already has data
//   npm run dev:copy-prod -- --force   replaces the dev workspaces
//
// TRIAGE_PROD_HOME overrides the source; TRIAGE_HOME overrides the destination.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { DEV_HOME } from './dev-home.mjs'

const DB_FILES = /^triage\.db(-wal|-shm|-journal)?$/

/** The server holding `home`'s DBs open, if one answers its server.json port. */
async function liveServer(home) {
  let state
  try {
    state = JSON.parse(readFileSync(path.join(home, 'server.json'), 'utf8'))
  } catch {
    return null
  }
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/health`, { signal: AbortSignal.timeout(1000) })
    const health = await res.json()
    return health?.app === 'triage' ? state.port : null
  } catch {
    return null
  }
}

/** A consistent snapshot of a (possibly live, WAL-mode) SQLite file. */
function snapshotDb(from, to) {
  const db = new DatabaseSync(from, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('VACUUM INTO ?').run(to)
  } finally {
    db.close()
  }
}

export async function copyProd({ from, to, force = false, log = console.log }) {
  from = path.resolve(from)
  to = path.resolve(to)
  if (from === to) throw new Error(`source and destination are both ${from}`)
  if (!existsSync(path.join(from, 'workspaces.json'))) throw new Error(`${from} has no workspaces.json — nothing to copy`)

  const port = await liveServer(to)
  if (port) throw new Error(`a triage server is running on ${to} (port ${port}) — stop it first`)

  const registry = path.join(to, 'workspaces.json')
  const workspaces = path.join(to, 'workspaces')
  if (existsSync(registry) || existsSync(workspaces)) {
    if (!force) throw new Error(`${to} already has workspaces — rerun with --force to replace them`)
    rmSync(registry, { force: true })
    rmSync(workspaces, { recursive: true, force: true })
  }

  mkdirSync(workspaces, { recursive: true })
  cpSync(path.join(from, 'workspaces.json'), registry)

  const srcWorkspaces = path.join(from, 'workspaces')
  const ids = existsSync(srcWorkspaces)
    ? readdirSync(srcWorkspaces, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : []
  for (const id of ids) {
    const src = path.join(srcWorkspaces, id)
    const dst = path.join(workspaces, id)
    mkdirSync(dst, { recursive: true })
    for (const name of readdirSync(src)) {
      if (DB_FILES.test(name)) continue
      cpSync(path.join(src, name), path.join(dst, name), { recursive: true, preserveTimestamps: true })
    }
    if (existsSync(path.join(dst, '.env'))) chmodSync(path.join(dst, '.env'), 0o600)
    if (existsSync(path.join(src, 'triage.db'))) snapshotDb(path.join(src, 'triage.db'), path.join(dst, 'triage.db'))
    log(`  ${id}`)
  }
  return ids
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const from = process.env.TRIAGE_PROD_HOME || path.join(os.homedir(), '.triage')
  const to = process.env.TRIAGE_HOME || DEV_HOME
  console.log(`copying ${from} → ${to}`)
  try {
    const ids = await copyProd({ from, to, force: process.argv.includes('--force') })
    console.log(`done: ${ids.length} workspace${ids.length === 1 ? '' : 's'}. Start dev with npm run dev.`)
  } catch (err) {
    console.error(`dev:copy-prod: ${err.message}`)
    process.exit(1)
  }
}
