/**
 * `npm run dev:copy-prod` (scripts/copy-prod.mjs): prod's workspaces land in the
 * dev root with DBs snapshotted (WAL rows included), secrets kept at 0600, and
 * the per-process files (server.json, remote.json, logs) left behind.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { copyProd } from '../scripts/copy-prod.mjs'

const quiet = () => {}

/** A prod root with one workspace whose DB is held open, so its rows sit in the WAL. */
function prodHome() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'triage-prod-'))
  const ws = path.join(root, 'workspaces', 'w1')
  mkdirSync(path.join(ws, 'artifacts'), { recursive: true })
  mkdirSync(path.join(root, 'logs'))
  writeFileSync(path.join(root, 'workspaces.json'), '{"version":1,"defaultId":"w1","workspaces":[]}')
  writeFileSync(path.join(root, 'server.json'), '{"pid":1,"port":1}')
  writeFileSync(path.join(root, 'remote.json'), '{}')
  writeFileSync(path.join(root, 'ngrok.pid'), '1')
  writeFileSync(path.join(root, 'logs', 'triage.jsonl'), '')
  writeFileSync(path.join(ws, '.env'), 'ANTHROPIC_API_KEY=x\n', { mode: 0o600 })
  writeFileSync(path.join(ws, 'artifacts', 'note.md'), '# note\n')
  const db = new DatabaseSync(path.join(ws, 'triage.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2)')
  return { root, db }
}

test('copies workspaces and snapshots live DBs, skipping per-process files', async () => {
  const { root, db } = prodHome()
  const to = mkdtempSync(path.join(os.tmpdir(), 'triage-dev-'))
  try {
    assert.deepEqual(await copyProd({ from: root, to, log: quiet }), ['w1'])
    const ws = path.join(to, 'workspaces', 'w1')
    const copy = new DatabaseSync(path.join(ws, 'triage.db'), { readOnly: true })
    assert.equal((copy.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n, 2)
    copy.close()
    assert.equal(existsSync(path.join(ws, 'triage.db-wal')), false)
    assert.equal(readFileSync(path.join(ws, 'artifacts', 'note.md'), 'utf8'), '# note\n')
    assert.equal(statSync(path.join(ws, '.env')).mode & 0o777, 0o600)
    assert.ok(existsSync(path.join(to, 'workspaces.json')))
    for (const skipped of ['server.json', 'remote.json', 'ngrok.pid', 'logs']) {
      assert.equal(existsSync(path.join(to, skipped)), false, skipped)
    }
  } finally {
    db.close()
  }
})

test('refuses to overwrite dev workspaces without --force, replaces them with it', async () => {
  const { root, db } = prodHome()
  const to = mkdtempSync(path.join(os.tmpdir(), 'triage-dev-'))
  try {
    await copyProd({ from: root, to, log: quiet })
    const stale = path.join(to, 'workspaces', 'w1', 'triage.db-wal')
    writeFileSync(stale, 'stale')
    await assert.rejects(copyProd({ from: root, to, log: quiet }), /--force/)
    await copyProd({ from: root, to, force: true, log: quiet })
    assert.equal(existsSync(stale), false)
  } finally {
    db.close()
  }
})

test('refuses to copy a root onto itself', async () => {
  const { root, db } = prodHome()
  try {
    await assert.rejects(copyProd({ from: root, to: root, log: quiet }), /both/)
  } finally {
    db.close()
  }
})
