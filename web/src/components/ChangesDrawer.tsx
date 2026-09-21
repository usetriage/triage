/**
 * What this session changed, docked between the transcript and the composer.
 *
 * Collapsed it is a 30px bar; open it takes its height from the transcript and
 * never from the composer, so the quoted line always lands somewhere you can
 * see. A session that changed nothing renders nothing at all.
 *
 * Attribution comes from the server (`GET /api/sessions/:id/changes`), which
 * reconstructs it from the git trees either side of each of this session's
 * turns — see `computeSessionChanges` in `server/index.ts`. Files another
 * session also touched are flagged rather than silently claimed.
 */
import { ChevronDown, ChevronUp, Columns2, FileDiff, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, SessionChanges, SessionDiffResponse } from '../../../shared/protocol.js'
import { parsePatch, type ParsedDiff } from '../diff.js'
import { DiffView } from './DiffView.js'

const MIN_H = 180
const MAX_H = 760
const DEFAULT_H = 340

const heightKey = 'triage.changes.height'
const modeKey = 'triage.changes.mode'

const readNum = (k: string, fallback: number) => {
  const n = Number(localStorage.getItem(k))
  return Number.isFinite(n) && n >= MIN_H && n <= MAX_H ? n : fallback
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '')

const STATUS_LETTER: Record<ChangedFile['status'], string> = { modified: 'M', added: 'A', deleted: 'D' }

/**
 * A session's title is its first prompt, so `alsoChangedBy` can hold whole
 * sentences. Name one, count the rest, and leave the full list to the tooltip
 * — the footer is one line and has a path to show as well.
 */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const alsoText = (names: string[]) =>
  names.length > 1 ? `${clip(names[0], 24)} and ${names.length - 1} more` : clip(names[0] ?? '', 40)

type Props = {
  sessionId: string
  /** fetched once by the session surface and shared with the transcript */
  changes: SessionChanges | null
  onQuote: (text: string) => void
}

export function ChangesDrawer({ sessionId, changes, onQuote }: Props) {
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(() => readNum(heightKey, DEFAULT_H))
  const [mode, setMode] = useState<'split' | 'unified'>(() =>
    localStorage.getItem(modeKey) === 'split' ? 'split' : 'unified',
  )
  const [active, setActive] = useState<string | null>(null)
  const [diff, setDiff] = useState<ParsedDiff | null>(null)
  const [diffError, setDiffError] = useState('')
  const [loadingDiff, setLoadingDiff] = useState(false)

  // A new session is a new drawer: nothing carried over from the last one.
  useEffect(() => {
    setOpen(false)
    setActive(null)
    setDiff(null)
  }, [sessionId])

  const files = changes?.files ?? []
  const current = useMemo(
    () => files.find((f) => f.path === active) ?? files[0] ?? null,
    [files, active],
  )

  // Fetch the patch for whichever file is in front.
  useEffect(() => {
    if (!open || !current) return
    let cancelled = false
    setLoadingDiff(true)
    setDiffError('')
    void fetch(`/api/sessions/${sessionId}/diff?path=${encodeURIComponent(current.path)}`)
      .then((r) => r.json() as Promise<SessionDiffResponse>)
      .then((b) => {
        if (cancelled) return
        if (b.ok) setDiff(parsePatch(b.patch))
        else {
          setDiff(null)
          setDiffError(b.error)
        }
      })
      .catch((err) => !cancelled && setDiffError(String(err)))
      .finally(() => !cancelled && setLoadingDiff(false))
    return () => {
      cancelled = true
    }
  }, [open, current, sessionId, changes])

  // Drag the grip to resize; the height is a per-browser preference.
  const dragging = useRef(false)
  useEffect(() => {
    function move(e: MouseEvent) {
      if (!dragging.current) return
      const next = Math.min(MAX_H, Math.max(MIN_H, window.innerHeight - e.clientY - 150))
      setHeight(next)
    }
    function up() {
      if (!dragging.current) return
      dragging.current = false
      document.body.classList.remove('resizing')
      localStorage.setItem(heightKey, String(height))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [height])

  // ⌘⇧D opens and closes it; Esc closes it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === 'd' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function quote(sel: { from: number; to: number; text: string }) {
    if (!current) return
    const where = sel.from === sel.to ? `${current.path}:${sel.from}` : `${current.path}:${sel.from}-${sel.to}`
    onQuote(`${where}\n\`\`\`\n${sel.text}\n\`\`\`\n`)
  }

  // Nothing changed (or no repo): the session looks exactly as it did before.
  if (!changes || !files.length) return null

  const shared = files.filter((f) => f.confidence !== 'exact')

  if (!open) {
    return (
      <div className="changesBar" role="region" aria-label="Changes">
        <button type="button" className="changesOpen" onClick={() => setOpen(true)}>
          <ChevronUp size={13} aria-hidden="true" />
          <FileDiff size={13} aria-hidden="true" />
          <span className="n">
            {files.length} {files.length === 1 ? 'file' : 'files'} changed
          </span>
          <span className="num">
            <span className="pl">+{changes.insertions}</span> <span className="mn">−{changes.deletions}</span>
          </span>
          {shared.length > 0 && (
            <span className="warn" title="Another session changed some of these files too">
              <TriangleAlert size={11} aria-hidden="true" /> {shared.length} shared
            </span>
          )}
          <span className="kbd">⌘⇧D</span>
        </button>
      </div>
    )
  }

  return (
    <div className="changesDrawer" style={{ height }} role="region" aria-label="Changes">
      <div
        className="grip"
        onMouseDown={() => {
          dragging.current = true
          document.body.classList.add('resizing')
        }}
      >
        <span />
      </div>

      <div className="dbar">
        <FileDiff size={13} aria-hidden="true" />
        <span className="t">Changes</span>
        <span className="mono dim">
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
        <span className="pill mono">
          <span className="pl">+{changes.insertions}</span> <span className="mn">−{changes.deletions}</span>
        </span>
        <span className="pill mute">this session</span>
        <span className="sp" />
        <span className="seg">
          <button
            type="button"
            className={`segBtn${mode === 'split' ? ' active' : ''}`}
            onClick={() => {
              setMode('split')
              localStorage.setItem(modeKey, 'split')
            }}
          >
            <Columns2 size={11} aria-hidden="true" /> Split
          </button>
          <button
            type="button"
            className={`segBtn${mode === 'unified' ? ' active' : ''}`}
            onClick={() => {
              setMode('unified')
              localStorage.setItem(modeKey, 'unified')
            }}
          >
            Unified
          </button>
        </span>
        <button type="button" className="iconBtn sm" aria-label="Collapse changes" onClick={() => setOpen(false)}>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="dmain">
        {/* The file list reads down the side rather than across the top: a
            row per file keeps the name, its folder and its counts legible
            however many there are, where a chip strip scrolls them away. */}
        <div className="flist" role="tablist" aria-label="Changed files">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              role="tab"
              aria-selected={current?.path === f.path}
              className={`frow${current?.path === f.path ? ' on' : ''}`}
              title={`${f.path}${f.alsoChangedBy.length ? ` — also changed by ${f.alsoChangedBy.join(', ')}` : ''}`}
              onClick={() => setActive(f.path)}
            >
              <span className={`st ${f.status}`}>{STATUS_LETTER[f.status]}</span>
              <span className="nm">{baseName(f.path)}</span>
              {f.confidence !== 'exact' && <TriangleAlert size={10} className="warnIcon" aria-hidden="true" />}
              <span className="num">
                <span className="pl">+{f.insertions}</span> <span className="mn">−{f.deletions}</span>
              </span>
              {dirName(f.path) && <span className="dir">{dirName(f.path).slice(0, -1)}</span>}
            </button>
          ))}
        </div>

        <div className="dbody">
          {current?.isBinary ? (
            <p className="dnote">Binary file — nothing to show.</p>
          ) : diffError ? (
            <p className="dnote err">{diffError}</p>
          ) : diff ? (
            <DiffView diff={diff} mode={mode} onComment={quote} />
          ) : (
            <p className="dnote">{loadingDiff ? 'Reading the diff…' : 'Pick a file.'}</p>
          )}
        </div>
      </div>

      <div className="dfoot">
        {current && (
          <>
            <span className="mono path">
              <span className="dir">{dirName(current.path)}</span>
              {baseName(current.path)}
            </span>
            {current.confidence === 'shared' ? (
              <span className="warn" title={`also changed by ${current.alsoChangedBy.join(', ')}`}>
                <TriangleAlert size={11} aria-hidden="true" />
                <span className="tx">also changed by {alsoText(current.alsoChangedBy)}</span>
              </span>
            ) : current.confidence === 'ambiguous' ? (
              <span className="warn">
                <TriangleAlert size={11} aria-hidden="true" />
                <span className="tx">another session was running — may not be this session's change</span>
              </span>
            ) : current.touched ? (
              <span className="ok">edited by this session in turn {current.turns.join(', ')}</span>
            ) : (
              <span className="ok">changed during turn {current.turns.join(', ')}</span>
            )}
          </>
        )}
        <span className="sp" />
        <span className="hint">drag to select lines · Comment sends them to the composer</span>
      </div>
    </div>
  )
}
