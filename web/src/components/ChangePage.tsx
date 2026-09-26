/**
 * One changed file, full width: its uncommitted diff against HEAD, and an
 * editor that saves straight to disk.
 *
 * The editor is a plain textarea on purpose — this is for the fix you spot
 * while reading a diff, not a replacement for your editor. Saves carry the
 * version the text was opened at, so a file an agent rewrote in the meantime
 * comes back as a conflict to resolve instead of being silently reverted.
 */
import { Columns2, FileDiff, PenLine, RotateCcw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ProjectFileResponse, SaveProjectFileResponse, WorkingDiffResponse } from '../../../shared/protocol.js'
import { changesStore, useChanges } from '../changesStore.js'
import { parsePatch, type ParsedDiff } from '../diff.js'
import { MOD_LABEL } from '../keys.js'
import { STATUS_LETTER } from './ChangesPanel.js'
import { DiffView } from './DiffView.js'

type Props = {
  projectId: string
  path: string
  /** the first keystroke pins the tab — edits should not live in a peek */
  onDirty: () => void
}

type Loaded = { content: string; version: string; eol: '\n' | '\r\n' }

/** The shared split/unified preference — the session drawer reads the same key. */
const modeKey = 'triage.changes.mode'

/**
 * Unsaved edits outlive the page: switching tabs unmounts it, and losing a
 * half-made fix to a tab switch is worse than any stale-draft risk. Kept in
 * memory only, with the version it was edited from, so a save still catches
 * a file that moved underneath it.
 */
const parked = new Map<string, { text: string; version: string }>()

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '')
const query = (projectId: string, path: string) =>
  `projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`

export function ChangePage({ projectId, path, onDirty }: Props) {
  const { projects, loaded: storeLoaded } = useChanges()
  const project = projects.find((p) => p.project.id === projectId) ?? null
  const entry = project?.files.find((f) => f.path === path) ?? null
  const key = `${projectId}/${path}`

  const [mode, setMode] = useState<'diff' | 'edit'>(() => (parked.has(key) ? 'edit' : 'diff'))
  const [view, setView] = useState<'split' | 'unified'>(() =>
    localStorage.getItem(modeKey) === 'split' ? 'split' : 'unified',
  )

  const [diff, setDiff] = useState<ParsedDiff | null>(null)
  const [diffError, setDiffError] = useState('')
  const [truncated, setTruncated] = useState(false)

  const [file, setFile] = useState<ProjectFileResponse | null>(null)
  const [base, setBase] = useState<Loaded | null>(null)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  const dirty = !!base && text !== base.content
  const textRef = useRef(text)
  textRef.current = text
  const baseRef = useRef(base)
  baseRef.current = base

  // The store may not have loaded yet on a cold open of this route.
  useEffect(() => {
    if (!storeLoaded) void changesStore.refresh()
  }, [storeLoaded])

  // Re-read the diff whenever the store says this file moved (a turn ended,
  // a save, the poll) — its counts are the cheapest fingerprint we have.
  const fingerprint = entry ? `${entry.status}:${entry.insertions}:${entry.deletions}` : 'clean'
  const loadDiff = useCallback(() => {
    let cancelled = false
    void fetch(`/api/changes/diff?${query(projectId, path)}`)
      .then((r) => r.json() as Promise<WorkingDiffResponse>)
      .then((b) => {
        if (cancelled) return
        if (b.ok) {
          setDiff(parsePatch(b.patch))
          setTruncated(b.truncated)
          setDiffError('')
        } else setDiffError(b.error)
      })
      .catch((err) => !cancelled && setDiffError(String(err)))
    return () => {
      cancelled = true
    }
  }, [projectId, path])
  useEffect(() => loadDiff(), [loadDiff, fingerprint])

  const loadFile = useCallback(
    (opts: { keepText?: boolean } = {}) =>
      fetch(`/api/changes/file?${query(projectId, path)}`)
        .then((r) => r.json() as Promise<ProjectFileResponse>)
        .then((b) => {
          setFile(b)
          if (!b.ok || b.kind !== 'text') {
            setBase(null)
            return null
          }
          // A textarea only ever speaks \n; remember what the file used so a
          // save does not rewrite every line ending in it.
          const eol = b.content.includes('\r\n') ? '\r\n' : '\n'
          const loaded: Loaded = { content: b.content.replaceAll('\r\n', '\n'), version: b.version, eol }
          setBase(loaded)
          if (!opts.keepText) {
            const p = parked.get(key)
            setText(p ? p.text : loaded.content)
            // A parked draft keeps the version it was edited from.
            if (p) setBase({ ...loaded, version: p.version })
          }
          return loaded
        })
        .catch((err) => {
          setFile({ ok: false, error: String(err) })
          return null
        }),
    [projectId, path, key],
  )

  useEffect(() => {
    void loadFile()
  }, [loadFile])

  // A file nobody is editing follows the disk.
  useEffect(() => {
    if (base && textRef.current === base.content) void loadFile()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint])

  // Park unsaved edits when the page goes away; drop them once they match.
  useEffect(
    () => () => {
      const b = baseRef.current
      if (b && textRef.current !== b.content) parked.set(key, { text: textRef.current, version: b.version })
      else parked.delete(key)
    },
    [key],
  )

  // Closing the browser tab is the one exit nothing can park across.
  useEffect(() => {
    if (!dirty) return
    const guard = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  const save = useCallback(
    async (version?: string) => {
      const b = baseRef.current
      if (!b || saving) return
      setSaving(true)
      setSaveError(null)
      const content = b.eol === '\n' ? textRef.current : textRef.current.replaceAll('\n', b.eol)
      try {
        const res = await fetch(`/api/changes/file?${query(projectId, path)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, version: version ?? b.version }),
        })
        const out = (await res.json()) as SaveProjectFileResponse
        if (out.ok) {
          const saved = textRef.current
          setBase({ ...b, content: saved, version: out.version })
          parked.delete(key)
          setJustSaved(true)
          window.setTimeout(() => setJustSaved(false), 1600)
          void changesStore.refresh()
          loadDiff()
        } else setSaveError({ message: out.error, conflict: !!out.conflict })
      } catch (err) {
        setSaveError({ message: String(err), conflict: false })
      } finally {
        setSaving(false)
      }
    },
    [projectId, path, key, saving, loadDiff],
  )

  /** Conflict, their side: throw the edits away and take the disk. */
  const takeDisk = () => {
    parked.delete(key)
    setSaveError(null)
    void loadFile()
  }
  /** Conflict, my side: save over whatever is on disk now. */
  const overwrite = async () => {
    const fresh = await loadFile({ keepText: true })
    if (fresh) void save(fresh.version)
  }

  const indent = useMemo(() => (/^\t/m.test(base?.content ?? '') ? '\t' : '  '), [base?.content])

  function onEditorKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (dirty) void save()
      return
    }
    // Tab indents rather than leaving the field; Esc still gets you out.
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: s, selectionEnd: end } = el
      const next = text.slice(0, s) + indent + text.slice(end)
      setText(next)
      if (!dirty) onDirty()
      requestAnimationFrame(() => el.setSelectionRange(s + indent.length, s + indent.length))
    }
  }

  const setViewMode = (v: 'split' | 'unified') => {
    setView(v)
    localStorage.setItem(modeKey, v)
  }

  if (storeLoaded && !project) {
    return <div id="empty">That project is no longer in this workspace.</div>
  }

  const editable = file?.ok && file.kind === 'text'
  const notEditable =
    file?.ok && file.kind !== 'text'
      ? file.kind === 'missing'
        ? 'Deleted — nothing on disk to edit.'
        : file.kind === 'binary'
          ? 'Binary file — not editable here.'
          : 'Too large to edit here — open it in your editor.'
      : file && !file.ok
        ? file.error
        : null

  return (
    <div className="page chgPage">
      <div className="chgBar">
        {entry && <span className={`st ${entry.status}`}>{STATUS_LETTER[entry.status]}</span>}
        <span className="crumb" title={`${project?.project.path ?? ''}/${path}`}>
          {project && <span className="proj">{project.project.name}</span>}
          <span className="dir">{dirName(path)}</span>
          <span className="nm">{baseName(path)}</span>
        </span>
        {entry && !entry.isBinary && (
          <span className="num">
            <span className="pl">+{entry.insertions}</span> <span className="mn">−{entry.deletions}</span>
          </span>
        )}
        <span className="sp" />
        <span className="seg" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'diff'}
            className={`segBtn${mode === 'diff' ? ' active' : ''}`}
            onClick={() => setMode('diff')}
          >
            <FileDiff size={11} aria-hidden="true" /> Diff
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'edit'}
            className={`segBtn${mode === 'edit' ? ' active' : ''}`}
            disabled={!editable}
            title={notEditable ?? undefined}
            onClick={() => setMode('edit')}
          >
            <PenLine size={11} aria-hidden="true" /> Edit
            {dirty && <span className="dot sm yellow" aria-label="unsaved" />}
          </button>
        </span>
        {mode === 'diff' ? (
          <span className="seg">
            <button type="button" className={`segBtn${view === 'split' ? ' active' : ''}`} onClick={() => setViewMode('split')}>
              <Columns2 size={11} aria-hidden="true" /> Split
            </button>
            <button type="button" className={`segBtn${view === 'unified' ? ' active' : ''}`} onClick={() => setViewMode('unified')}>
              Unified
            </button>
          </span>
        ) : (
          <>
            <span className="state">{saving ? 'Saving…' : justSaved ? 'Saved' : dirty ? 'Unsaved' : ''}</span>
            <button
              type="button"
              className="btn xs"
              disabled={!dirty || saving}
              title="Discard unsaved edits"
              onClick={() => base && setText(base.content)}
            >
              <RotateCcw size={11} aria-hidden="true" /> Revert
            </button>
            <button type="button" className="btn xs primary" disabled={!dirty || saving} onClick={() => void save()}>
              Save <span className="kbd">{MOD_LABEL}S</span>
            </button>
          </>
        )}
      </div>

      {saveError && (
        <div className="chgAlert" role="alert">
          <TriangleAlert size={13} aria-hidden="true" />
          <span className="tx">{saveError.message}</span>
          {saveError.conflict && (
            <>
              <button type="button" className="btn xs" onClick={takeDisk}>
                Discard mine, reload
              </button>
              <button type="button" className="btn xs" onClick={() => void overwrite()}>
                Overwrite with mine
              </button>
            </>
          )}
        </div>
      )}

      <div className={`chgBody${mode === 'edit' ? ' editing' : ''}`}>
        {mode === 'edit' && editable ? (
          <textarea
            className="chgEditor"
            value={text}
            spellCheck={false}
            autoFocus
            aria-label={`Edit ${path}`}
            onChange={(e) => {
              if (!dirty) onDirty()
              setText(e.target.value)
            }}
            onKeyDown={onEditorKey}
          />
        ) : diffError ? (
          <p className="dnote err">{diffError}</p>
        ) : !diff ? (
          <p className="dnote">Reading the diff…</p>
        ) : diff.isBinary || entry?.isBinary ? (
          <p className="dnote">Binary file — nothing to show.</p>
        ) : diff.rows.length === 0 ? (
          <p className="dnote">No uncommitted changes — this file matches HEAD.</p>
        ) : (
          <>
            {dirty && <p className="dnote">This is the file on disk — your unsaved edits are not in it yet.</p>}
            <DiffView diff={diff} mode={view} />
            {truncated && <p className="dnote">The patch was cut off at 256 KB.</p>}
          </>
        )}
      </div>
    </div>
  )
}
