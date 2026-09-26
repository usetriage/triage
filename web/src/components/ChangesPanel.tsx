/**
 * The Changes panel: every project's uncommitted files, one group per
 * project. A row opens the file in the content area — its diff against HEAD,
 * and an editor. What it lists is the disk, not a session: anything that
 * changed a file (an agent, a terminal, your editor) shows up here.
 */
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChangeStatus, ProjectChanges } from '../../../shared/protocol.js'
import { changesStore } from '../changesStore.js'
import { rowOpen } from '../tabs.js'
import { PanelSearch } from './ContextPanel.js'

/** A poll, not a push: nothing tells the daemon a file changed on disk. */
const POLL_MS = 15_000
const collapsedKey = 'triage.changes.collapsed'

export const STATUS_LETTER: Record<ChangeStatus, string> = { modified: 'M', added: 'A', deleted: 'D' }

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

function readCollapsed(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

type Props = {
  projects: readonly ProjectChanges[]
  loaded: boolean
  loading: boolean
  current: { projectId: string; path: string } | null
  onOpen: (projectId: string, path: string) => void
  /** Keep it in the band without leaving where you are (⌘-click, middle-click). */
  onPin: (projectId: string, path: string) => void
  onSearch: () => void
}

export function ChangesPanel({ projects, loaded, loading, current, onOpen, onPin, onSearch }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed)

  // Fresh on arrival, then a slow poll while the panel is on screen.
  useEffect(() => {
    void changesStore.refresh()
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void changesStore.refresh()
    }, POLL_MS)
    return () => window.clearInterval(t)
  }, [])

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(collapsedKey, JSON.stringify([...next]))
      } catch {
        // storage blocked — the toggle still works for this page load
      }
      return next
    })
  }

  // Dirty projects first; a clean one is still listed, so "no changes" is an answer.
  const ordered = [...projects].sort((a, b) => Number(b.files.length > 0) - Number(a.files.length > 0))
  const total = projects.reduce((n, p) => n + p.files.length, 0)

  return (
    <aside className="panel" aria-label="Changes">
      <PanelSearch onSearch={onSearch} placeholder="Search sessions, items…" />
      <div className="panelBody">
        <div className="panelHead">
          <span>Changes</span>
          <span className="n">{total}</span>
          <span className="acts">
            <button
              type="button"
              className={`iconBtn sm${loading ? ' spinning' : ''}`}
              title="Refresh"
              onClick={() => void changesStore.refresh()}
            >
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          </span>
        </div>
        {loaded && projects.length === 0 && (
          <div className="panelEmpty">No projects yet. Add one in Settings → Projects and its uncommitted files show up here.</div>
        )}
        {ordered.map((pc) => {
          const open = !collapsed.has(pc.project.id)
          const note = pc.error ? 'git failed' : !pc.isRepo ? 'not a repo' : pc.files.length === 0 ? 'clean' : null
          return (
            <div key={pc.project.id} className="chgGroup">
              <button
                type="button"
                className="panelGroup asBtn"
                aria-expanded={open}
                title={`${pc.project.path}${pc.branch ? ` · ${pc.branch}` : ''}${pc.error ? `\n${pc.error}` : ''}`}
                onClick={() => toggle(pc.project.id)}
              >
                {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                <span className="nm">{pc.project.name}</span>
                {pc.files.length > 0 && <span className="n">{pc.files.length}</span>}
                {note && <span className="note">{note}</span>}
                {pc.files.length > 0 && (
                  <span className="num">
                    <span className="pl">+{pc.insertions}</span> <span className="mn">−{pc.deletions}</span>
                  </span>
                )}
              </button>
              {open &&
                pc.files.map((f) => {
                  const sel = current?.projectId === pc.project.id && current.path === f.path
                  const dir = dirName(f.path)
                  return (
                    <button
                      key={f.path}
                      type="button"
                      className={`prow chg${sel ? ' sel' : ''}`}
                      title={f.path}
                      {...rowOpen(
                        () => onOpen(pc.project.id, f.path),
                        () => onPin(pc.project.id, f.path),
                      )}
                    >
                      <span className={`st ${f.status}`}>{STATUS_LETTER[f.status]}</span>
                      <span className="t">
                        <span className="nm">{baseName(f.path)}</span>
                        {dir && <span className="sub">{dir}</span>}
                      </span>
                      <span className="m">
                        {f.isBinary ? (
                          'bin'
                        ) : (
                          <>
                            <span className="pl">+{f.insertions}</span> <span className="mn">−{f.deletions}</span>
                          </>
                        )}
                      </span>
                    </button>
                  )
                })}
            </div>
          )
        })}
      </div>
      <div className="panelFoot">
        vs HEAD · <span className="kbd">dbl-click</span> keeps the tab
      </div>
    </aside>
  )
}
