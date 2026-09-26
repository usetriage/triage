/**
 * Files for `@` mentions: a per-folder index the composer's picker searches,
 * and the send-time resolver that turns a picked path into what the model
 * receives. Nothing here escapes the folder it was asked about — a mention is
 * resolved inside the session's own cwd (the folder the agent already has), and
 * the picker only lists what `git` considers part of the project, so ignored
 * secrets never show up by accident.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fuzzyScore } from '../shared/fuzzy.js'
import { MAX_INLINE_FILE_BYTES, type FileHit, type ProjectFileResponse, type SaveProjectFileResponse } from '../shared/protocol.js'

const pExecFile = promisify(execFile)

/** How long a listing is trusted before the next search rebuilds it. */
const INDEX_TTL_MS = 15_000
/** Non-git folders are walked by hand and capped, so a home folder can't hang the picker. */
const WALK_CAP = 20_000
const WALK_IGNORE = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.DS_Store',
  'coverage',
  '.idea',
  '.vscode',
])

type Listing = {
  /** every file, as a `/`-separated path relative to the root */
  files: string[]
  /** every directory that contains one of those files, with a trailing `/` */
  dirs: string[]
  truncated: boolean
  builtAt: number
}

async function listGit(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await pExecFile(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 64 * 1024 * 1024 },
    )
    return stdout.split('\0').filter(Boolean)
  } catch {
    return null // not a repo, or no git — fall back to walking
  }
}

async function walk(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  const queue = ['']
  let truncated = false
  while (queue.length > 0 && !truncated) {
    const rel = queue.shift()!
    let entries
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (WALK_IGNORE.has(e.name)) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) queue.push(p)
      else if (e.isFile()) {
        files.push(p)
        if (files.length >= WALK_CAP) {
          truncated = true
          break
        }
      }
      // symlinks are neither followed nor listed — they can point anywhere
    }
  }
  return { files, truncated }
}

function dirsOf(files: string[]): string[] {
  const set = new Set<string>()
  for (const f of files) {
    let i = f.indexOf('/')
    while (i > 0) {
      set.add(f.slice(0, i + 1))
      i = f.indexOf('/', i + 1)
    }
  }
  return [...set]
}

/** The searchable listing of one folder, rebuilt lazily when stale. */
export class FileIndex {
  private listing: Listing | null = null
  private inflight: Promise<Listing> | null = null

  constructor(readonly root: string) {}

  invalidate() {
    this.listing = null
  }

  private async build(): Promise<Listing> {
    const fromGit = await listGit(this.root)
    const { files, truncated } = fromGit ? { files: fromGit, truncated: false } : await walk(this.root)
    // Windows separators never reach the client; every path is `/`-joined.
    const norm = files.map((f) => f.split(path.sep).join('/'))
    return { files: norm, dirs: dirsOf(norm), truncated, builtAt: Date.now() }
  }

  async list(): Promise<Listing> {
    if (this.listing && Date.now() - this.listing.builtAt < INDEX_TTL_MS) return this.listing
    if (!this.inflight) {
      this.inflight = this.build()
        .then((l) => {
          this.listing = l
          return l
        })
        .finally(() => {
          this.inflight = null
        })
    }
    return this.inflight
  }

  async search(query: string, limit: number): Promise<{ hits: FileHit[]; total: number; truncated: boolean }> {
    const { files, dirs, truncated } = await this.list()
    const q = query.trim()
    if (!q) {
      // Nothing typed yet: the top level, folders first, like `ls`.
      const top = [
        ...dirs.filter((d) => d.indexOf('/') === d.length - 1).sort().map((p) => ({ path: p, dir: true })),
        ...files.filter((f) => !f.includes('/')).sort().map((p) => ({ path: p, dir: false })),
      ]
      return { hits: top.slice(0, limit), total: files.length + dirs.length, truncated }
    }
    const scored: { hit: FileHit; s: number }[] = []
    for (const f of files) {
      const s = fuzzyScore(q, f)
      if (s !== null) scored.push({ hit: { path: f, dir: false }, s })
    }
    for (const d of dirs) {
      const s = fuzzyScore(q, d)
      if (s !== null) scored.push({ hit: { path: d, dir: true }, s: s - 2 })
    }
    scored.sort((a, b) => b.s - a.s)
    return { hits: scored.slice(0, limit).map((x) => x.hit), total: scored.length, truncated }
  }
}

/** One index per folder, a handful at a time — folders a workspace has sessions in. */
export class FileIndexes {
  private readonly byRoot = new Map<string, FileIndex>()

  get(root: string): FileIndex {
    let idx = this.byRoot.get(root)
    if (!idx) {
      idx = new FileIndex(root)
      this.byRoot.set(root, idx)
      // Bound the cache; the oldest entry goes first.
      if (this.byRoot.size > 16) {
        const first = this.byRoot.keys().next().value
        if (first !== undefined) this.byRoot.delete(first)
      }
    }
    return idx
  }

  invalidate(root: string) {
    this.byRoot.get(root)?.invalidate()
  }
}

// ---------------------------------------------------------------------------
// Resolution — a picked path becomes bytes for the model
// ---------------------------------------------------------------------------

export type ResolvedFile =
  | { kind: 'text'; abs: string; rel: string; bytes: number; text: string }
  | { kind: 'large'; abs: string; rel: string; bytes: number }
  | { kind: 'binary'; abs: string; rel: string; bytes: number }
  | { kind: 'dir'; abs: string; rel: string; entries: string[] }
  | { kind: 'error'; rel: string; error: string }

/**
 * Resolve `ref` inside `cwd` and read it if it is small text. The realpath of
 * the target must stay under the realpath of `cwd` — a symlink pointing out of
 * the project resolves to an error, not to the file it points at.
 */
export async function resolveFileMention(cwd: string, ref: string): Promise<ResolvedFile> {
  const wantsDir = ref.endsWith('/')
  const rel = ref.replace(/\/+$/, '')
  const abs = path.resolve(cwd, rel)
  let realRoot: string
  let real: string
  try {
    realRoot = await realpath(cwd)
    real = await realpath(abs)
  } catch {
    return { kind: 'error', rel: ref, error: 'not found' }
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return { kind: 'error', rel: ref, error: 'outside the session folder' }
  }
  let st
  try {
    st = await stat(real)
  } catch {
    return { kind: 'error', rel: ref, error: 'not found' }
  }
  const shown = path.relative(cwd, abs).split(path.sep).join('/') || '.'
  if (st.isDirectory()) {
    const entries = (await readdir(real, { withFileTypes: true }))
      .filter((e) => !WALK_IGNORE.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
    return { kind: 'dir', abs: real, rel: shown + '/', entries: entries.slice(0, 500) }
  }
  if (wantsDir) return { kind: 'error', rel: ref, error: 'not a directory' }
  if (st.size > MAX_INLINE_FILE_BYTES) return { kind: 'large', abs: real, rel: shown, bytes: st.size }
  const buf = await readFile(real)
  // A NUL in the first 8 KB is the classic "this is not text" test.
  if (buf.subarray(0, 8192).includes(0)) return { kind: 'binary', abs: real, rel: shown, bytes: st.size }
  return { kind: 'text', abs: real, rel: shown, bytes: st.size, text: buf.toString('utf8') }
}

// ---------------------------------------------------------------------------
// Editing — the Changes view opens a changed file and saves it back
// ---------------------------------------------------------------------------

/** Files above this open read-only: a textarea is the wrong tool past it. */
export const MAX_EDIT_BYTES = 1024 * 1024

const versionOf = (buf: Buffer) => createHash('sha1').update(buf).digest('hex')

/**
 * `rel` resolved to a real path inside `root`, or an error. Absolute paths,
 * `..` escapes, symlinks pointing out of the folder, and anything under
 * `.git/` are all refused — this is the only gate between the browser and a
 * write to disk.
 */
async function containedPath(root: string, rel: string): Promise<{ real: string } | { error: string; missing?: true }> {
  const norm = path.posix.normalize(rel.split(path.sep).join('/'))
  if (!rel || path.isAbsolute(rel) || norm === '..' || norm.startsWith('../')) return { error: 'path is outside the project' }
  if (norm === '.git' || norm.startsWith('.git/') || norm.includes('/.git/')) return { error: 'refusing to touch .git' }
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    return { error: 'project folder not found' }
  }
  let real: string
  try {
    real = await realpath(path.resolve(root, norm))
  } catch {
    return { error: 'not found', missing: true }
  }
  if (!real.startsWith(realRoot + path.sep)) return { error: 'path is outside the project' }
  return { real }
}

export async function readProjectFile(root: string, rel: string): Promise<ProjectFileResponse> {
  const got = await containedPath(root, rel)
  if ('error' in got) return got.missing ? { ok: true, path: rel, kind: 'missing', bytes: 0 } : { ok: false, error: got.error }
  const st = await stat(got.real)
  if (!st.isFile()) return { ok: false, error: 'not a file' }
  if (st.size > MAX_EDIT_BYTES) return { ok: true, path: rel, kind: 'large', bytes: st.size }
  const buf = await readFile(got.real)
  if (buf.subarray(0, 8192).includes(0)) return { ok: true, path: rel, kind: 'binary', bytes: st.size }
  return { ok: true, path: rel, kind: 'text', content: buf.toString('utf8'), version: versionOf(buf) }
}

/**
 * Overwrite an existing file — never create one — provided it still holds
 * the bytes the editor opened. Agents write to these same files; a stale save
 * is a conflict for the user to resolve, not a silent revert of their work.
 */
export async function writeProjectFile(
  root: string,
  rel: string,
  content: string,
  version: string,
): Promise<SaveProjectFileResponse> {
  const got = await containedPath(root, rel)
  if ('error' in got) return { ok: false, error: got.missing ? 'the file no longer exists' : got.error }
  const st = await stat(got.real)
  if (!st.isFile()) return { ok: false, error: 'not a file' }
  if (st.size > MAX_EDIT_BYTES) return { ok: false, error: 'file is too large to edit here' }
  if (versionOf(await readFile(got.real)) !== version) {
    return { ok: false, conflict: true, error: 'the file changed on disk since you opened it' }
  }
  const next = Buffer.from(content, 'utf8')
  if (next.length > MAX_EDIT_BYTES) return { ok: false, error: 'file is too large to edit here' }
  await writeFile(got.real, next)
  return { ok: true, version: versionOf(next) }
}
