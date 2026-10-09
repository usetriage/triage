/**
 * A watch as its file (#/watches/new, #/watches/<id>/edit): the whole
 * `watches/<slug>.md` in one editor — frontmatter for the settings, the body
 * for the instruction. Save checks it exactly as the scheduler would and
 * writes it only when nothing is wrong; every problem is listed at once. The
 * side list carries what a file has to name by id: projects and tool lines.
 */
import * as Collapsible from '@radix-ui/react-collapsible'
import { Check, ChevronRight, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WatchFileReference, WatchFileResponse } from '../../../shared/protocol.js'

export function WatchFileEditor({ id, onNavigate }: { id?: string; onNavigate: (hash: string) => void }) {
  const [text, setText] = useState<string | null>(null)
  const [file, setFile] = useState<string | undefined>()
  const [reference, setReference] = useState<WatchFileReference | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const q = id ? `?id=${encodeURIComponent(id)}` : ''
    fetch(`/api/watches/file${q}`)
      .then((r) => r.json() as Promise<WatchFileResponse>)
      .then((b) => {
        if (!b.ok) return setErrors([b.error])
        if (!('text' in b)) return
        setText(b.text)
        setFile(b.file)
        setReference(b.reference)
      })
      .catch((err) => setErrors([String(err)]))
  }, [id])

  async function save() {
    if (text == null || saving) return
    setSaving(true)
    setErrors([])
    try {
      const q = id ? `?id=${encodeURIComponent(id)}` : ''
      const res = await fetch(`/api/watches/file${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const b = (await res.json()) as WatchFileResponse
      if (!b.ok) setErrors(b.errors?.length ? b.errors : [b.error])
      else if ('id' in b) onNavigate(`/watches/${encodeURIComponent(b.id)}`)
    } catch (err) {
      setErrors([String(err)])
    } finally {
      setSaving(false)
    }
  }

  // Tab indents instead of leaving the editor; ⌘S / Ctrl+S saves.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      void save()
      return
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: a, selectionEnd: b } = el
      const next = `${el.value.slice(0, a)}  ${el.value.slice(b)}`
      setText(next)
      setDirty(true)
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
    }
  }

  const cancel = () => {
    if (dirty && !confirm('Discard your changes to this file?')) return
    onNavigate(id ? `/watches/${encodeURIComponent(id)}` : '/watches')
  }

  return (
    <div className="page wide">
      <div className="glow blue" aria-hidden="true" />
      <div className="inner wfile">
        <div className="crumbs">
          <button type="button" className="crumb link" onClick={() => onNavigate('/watches')}>
            Watches
          </button>
          <span className="crumbSep">›</span>
          <span className="crumb now">{id ? 'Edit watch' : 'New watch'}</span>
          {file && <span className="wfileName mono">{file}</span>}
        </div>

        {text == null ? (
          errors.length ? (
            <div className="msg error">{errors.join('\n')}</div>
          ) : (
            <div className="probing">
              <span className="pip" /> Loading…
            </div>
          )
        ) : (
          <div className="wfileGrid">
            <div className="wfileMain">
              <textarea
                className="wfileText"
                aria-label="Watch file"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoFocus
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setDirty(true)
                }}
                onKeyDown={onKeyDown}
              />
              {errors.length > 0 && (
                <div className="msg error" role="alert">
                  {errors.length === 1 ? 'Not saved: ' : `Not saved — ${errors.length} problems:\n`}
                  {errors.length === 1 ? errors[0] : errors.map((e) => `· ${e}`).join('\n')}
                </div>
              )}
              <div className="foot">
                <span className="hint">
                  Checked like the scheduler checks it; saved only when nothing is wrong. <kbd>⌘S</kbd>
                </span>
                <button type="button" className="btn outline" onClick={cancel}>
                  Cancel
                </button>
                <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
                  {saving ? 'Checking…' : id ? 'Save' : 'Create'}
                </button>
              </div>
            </div>
            {reference && <ReferencePanel reference={reference} />}
          </div>
        )}
      </div>
    </div>
  )
}

/** What a file names by id, click to copy. */
function ReferencePanel({ reference }: { reference: WatchFileReference }) {
  return (
    <aside className="wfileRef" aria-label="Reference">
      <div className="secLabel">Projects</div>
      {reference.projects.length === 0 ? (
        <div className="wfileEmpty">No projects yet — add one first.</div>
      ) : (
        reference.projects.map((p) => <CopyRow key={p.id} value={p.id} label={p.name} />)
      )}
      <div className="secLabel">Built-in tools</div>
      {reference.builtins.map((b) => (
        <CopyRow key={b} value={b} />
      ))}
      {reference.servers.length > 0 && <div className="secLabel">MCP tools</div>}
      {reference.servers.map((s) => (
        <Collapsible.Root key={s.server} className="wfileServer">
          <Collapsible.Trigger className="wfileServerHead">
            <ChevronRight size={12} aria-hidden="true" />
            <span className="mono">{s.server}</span>
            <span className="n mono">{s.tools.length}</span>
          </Collapsible.Trigger>
          <Collapsible.Content className="wfileServerBody">
            {s.tools.map((t) => (
              <CopyRow key={t} value={t} label={t.slice(s.server.length + 1)} />
            ))}
          </Collapsible.Content>
        </Collapsible.Root>
      ))}
    </aside>
  )
}

function CopyRow({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="wfileCopy"
      title={`Copy ${value}`}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }
    >
      <span className="v mono">{label ?? value}</span>
      {label && label !== value && <span className="k mono">{value.length > 14 ? `${value.slice(0, 8)}…` : value}</span>}
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  )
}
