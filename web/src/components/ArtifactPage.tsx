import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, AtSign, ExternalLink, Inbox, MessagesSquare, Pencil, Trash2 } from 'lucide-react'
import type { Artifact, ArtifactContentResponse, ArtifactResponse, Link } from '../../../shared/protocol.js'
import { itemHash, useSessions } from '../hooks.js'
import { useInbox } from '../inboxStore.js'
import { artifactStore } from '../artifactStore.js'
import { onThisMac } from '../device.js'
import { store } from '../store.js'
import { ArtifactEditor } from './ArtifactEditor.js'
import { Markdown } from './Markdown.js'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; artifact: Artifact; body: string; links: Link[]; abs: string }
  | { phase: 'error'; message: string }

const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/**
 * One artifact: the rendered markdown, its frontmatter as chips, and what it
 * is linked to. Edit (or `#/artifact/new`) hands the whole content area to the
 * ArtifactEditor — long notes need the room — and the page follows the file
 * when it changes on disk.
 */
export function ArtifactPage({
  id,
  onNavigate,
  onDirty,
}: {
  id: string
  onNavigate: (hash: string) => void
  /** Editing here means the tab must survive: promote it out of the peek slot. */
  onDirty: () => void
}) {
  if (id === 'new') return <NewArtifactPage onNavigate={onNavigate} />
  return <ExistingArtifactPage id={id} onNavigate={onNavigate} onDirty={onDirty} />
}

/** `#/artifact/new` — a fresh full-page editor; saving lands on the new artifact's page. */
function NewArtifactPage({ onNavigate }: { onNavigate: (hash: string) => void }) {
  return (
    <div id="artifactPage" className="page wide artEditPage">
      <ArtifactEditor
        draftKey="new"
        initialTitle=""
        initialBody=""
        crumb="Artifacts › New note"
        saveLabel="Create"
        onCancel={() => onNavigate('/artifacts')}
        onSave={async (title, body) => {
          const res = await fetch('/api/artifacts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, body }),
          })
          const b = (await res.json()) as ArtifactResponse
          if (!b.ok) return b.error
          void artifactStore.refresh()
          onNavigate(`/artifact/${b.artifact.id}`)
          return null
        }}
      />
    </div>
  )
}

function ExistingArtifactPage({ id, onNavigate, onDirty }: { id: string; onNavigate: (hash: string) => void; onDirty: () => void }) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [editing, setEditing] = useState(false)
  // Opening the editor commits you to this note: keep its tab.
  useEffect(() => {
    if (editing) onDirty()
  }, [editing, onDirty])
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const inbox = useInbox()
  const sessions = useSessions()

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/artifacts/content?id=${encodeURIComponent(id)}`)
      const b = (await res.json()) as ArtifactContentResponse
      if (b.ok) setState({ phase: 'ready', artifact: b.artifact, body: b.body, links: b.links, abs: b.abs })
      else setState({ phase: 'error', message: b.error })
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  // The file may change under us (your editor, a session) — follow it, unless mid-edit.
  useEffect(() => store.onArtifactsChanged(() => void load()), [load])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 2000)
    return () => window.clearTimeout(t)
  }, [notice])

  async function save(title: string, body: string): Promise<string | null> {
    const res = await fetch(`/api/artifacts?id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, body }),
    })
    const b = (await res.json()) as ArtifactResponse
    if (!b.ok) return b.error
    setEditing(false)
    await load()
    return null
  }

  async function remove() {
    setBusy('delete')
    try {
      const res = await fetch(`/api/artifacts?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const b = (await res.json()) as { ok: boolean; error?: string }
      if (b.ok) onNavigate('/artifacts')
      else setNotice(b.error ?? 'could not delete')
    } finally {
      setBusy(null)
    }
  }

  async function openInEditor() {
    setBusy('open')
    try {
      const res = await fetch('/api/artifacts/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const b = (await res.json()) as { ok: boolean; error?: string }
      setNotice(b.ok ? 'Opened in your editor' : b.error ?? 'could not open')
    } finally {
      setBusy(null)
    }
  }

  async function copyMention() {
    try {
      await navigator.clipboard.writeText(`@artifact:${id}`)
      setNotice('Copied — paste it into any composer')
    } catch {
      setNotice(`@artifact:${id}`)
    }
  }

  if (state.phase === 'loading') return <div className="page">Loading…</div>
  if (state.phase === 'error') {
    return (
      <div className="page">
        <button type="button" className="artBack" onClick={() => onNavigate('/artifacts')}>
          <ArrowLeft size={12} aria-hidden="true" /> Artifacts
        </button>
        <div className="msg error">{state.message}</div>
      </div>
    )
  }

  const { artifact: a, body, links, abs } = state

  // Edit mode takes the whole content area — long notes need the room.
  if (editing) {
    return (
      <div id="artifactPage" className="page wide artEditPage">
        <ArtifactEditor
          draftKey={a.id}
          initialTitle={a.title}
          initialBody={body}
          crumb={`Artifacts › ${a.path}`}
          saveLabel="Save"
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  const itemTitle = (itemId: string) => inbox.items.find((i) => i.id === itemId)?.title ?? itemId
  const sessionTitle = (sid: string) => sessions.find((s) => s.id === sid)?.title ?? sid.slice(0, 8)

  return (
    <div id="artifactPage" className="page wide">
      <div className="inner">
        <button type="button" className="artBack" onClick={() => onNavigate('/artifacts')}>
          <ArrowLeft size={12} aria-hidden="true" /> Artifacts
        </button>

        <div className="artHead">
          <div>
            <h1 className="display md" style={{ margin: 0 }}>
              {a.title}
            </h1>
            <div className="chipRow" style={{ marginTop: 10 }}>
              <span className={`pill ${a.author === 'model' ? 'blue' : 'mute'}`}>{a.author === 'model' ? 'written by the model' : 'written by you'}</span>
              <span className="pill mute" title={new Date(a.updated).toLocaleString()}>
                updated {new Date(a.updated).toLocaleDateString()}
              </span>
              <span className="pill mono mute" title={abs}>
                <span className="t">{a.path}</span>
              </span>
              {a.refs.map((r) => (
                <span key={r} className="pill mono">
                  {r}
                </span>
              ))}
              {a.warning && (
                <span className="pill yellow" title={a.warning}>
                  frontmatter did not parse
                </span>
              )}
            </div>
          </div>
          <div className="actions">
            {
              <>
                <button type="button" className="btn sm" onClick={() => setEditing(true)} title="Full-page editor (⌘S saves)">
                  <Pencil size={13} aria-hidden="true" /> Edit
                </button>
                {/* The editor opens on the Mac's screen — no use to a phone. */}
                {onThisMac() && (
                  <button type="button" className="btn sm" onClick={() => void openInEditor()} disabled={busy !== null} title={abs}>
                    <ExternalLink size={13} aria-hidden="true" /> Open in editor
                  </button>
                )}
                <button type="button" className="btn sm" onClick={() => void copyMention()} title="Copy the @ token for a composer">
                  <AtSign size={13} aria-hidden="true" /> Mention
                </button>
                {confirmDelete ? (
                  <button type="button" className="btn sm danger" onClick={() => void remove()} disabled={busy !== null}>
                    {busy === 'delete' ? 'Deleting…' : 'Really delete'}
                  </button>
                ) : (
                  <button type="button" className="btn sm ghost" onClick={() => setConfirmDelete(true)} title="Delete the file (git keeps its history)">
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                )}
              </>
            }
          </div>
        </div>

        {notice && <div className="notice">{notice}</div>}

        <div className="artGrid">
          <div className="card artBody" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
            {body.trim() ? <Markdown text={body} /> : <div className="artEmpty">Empty. Edit here, or open it in your editor.</div>}
          </div>

          <aside className="artAside">
            <section>
              <div className="secLabel">
                Linked to <span className="n">{links.length}</span>
              </div>
              {links.length === 0 ? (
                <div className="artEmpty" style={{ marginTop: 8 }}>
                  Nothing yet. A session can link this to a work item with <code>link_artifact</code>.
                </div>
              ) : (
                <div className="artLinks" style={{ marginTop: 8 }}>
                  {links.map((l) => {
                    const other = l.fromKind === 'artifact' && l.fromId === a.id ? { kind: l.toKind, id: l.toId } : { kind: l.fromKind, id: l.fromId }
                    return (
                      <div key={l.id} className="artLink">
                        {other.kind === 'item' ? <Inbox size={13} aria-hidden="true" /> : <MessagesSquare size={13} aria-hidden="true" />}
                        <button
                          type="button"
                          className="link"
                          onClick={() => onNavigate(other.kind === 'item' ? itemHash(other.id) : other.id)}
                          title={other.id}
                        >
                          {other.kind === 'item' ? itemTitle(other.id) : sessionTitle(other.id)}
                        </button>
                        <span className="pill mute">{l.role}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
            <section>
              <div className="secLabel">On disk</div>
              <div className="artEmpty mono" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
                {tilde(abs)}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
