import { useEffect, useRef, useState } from 'react'
import type { BriefJobsResponse, PlaybooksResponse, ScoredItem, SettingsResponse } from '../../../shared/protocol.js'
import { briefStore } from '../briefStore.js'
import { findModel, useModels } from '../models.js'
import { KIND_LABEL } from '../itemUi.js'
import { Select, SelectItem } from '../ui/Select.js'

type Props = {
  open: boolean
  /** the items to brief — one from the item page, or the checked rows from the inbox */
  items: ScoredItem[]
  onClose: () => void
  /** queued: the caller may clear its selection */
  onQueued: () => void
}

/**
 * "Create brief": the one gate between an item and a token-spending run. The
 * context note is the most valuable field on the page — it turns a generic
 * brief into a targeted one — so it leads. Playbook defaults to the kind,
 * model to the workspace's brief default; both are one click to change.
 */
export function CreateBriefDialog({ open, items, onClose, onQueued }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [note, setNote] = useState('')
  const [playbook, setPlaybook] = useState<string>('')
  const [model, setModel] = useState<string>('')
  const [playbooks, setPlaybooks] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const models = useModels()

  const single = items.length === 1 ? items[0] : null
  const sameKind = items.every((i) => i.kind === items[0]?.kind)

  useEffect(() => {
    if (!open) return
    setNote('')
    setPlaybook('')
    setModel('')
    setError(null)
    setSaving(false)
    void fetch('/api/playbooks')
      .then((r) => r.json() as Promise<PlaybooksResponse>)
      .then((b) => {
        if (b.ok) setPlaybooks(b.playbooks.map((p) => p.kind))
      })
      .catch(() => {})
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<SettingsResponse>)
      .then((b) => {
        if (b.ok) setDefaultModel(b.settings.briefsDefaultModel)
      })
      .catch(() => {})
  }, [open])

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  async function submit() {
    if (!items.length) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/briefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemIds: items.map((i) => i.id),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(playbook ? { playbook } : {}),
          ...(model ? { model } : {}),
        }),
      })
      const b = (await res.json()) as BriefJobsResponse
      if (!b.ok) {
        setError(b.error)
        return
      }
      for (const j of b.jobs) briefStore.apply(j)
      onQueued()
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const defaultModelName = defaultModel ? findModel(models, defaultModel)?.name ?? defaultModel : 'Claude Code default'

  return (
    <dialog ref={dialog} className="projModal briefDialog" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <h3>{single ? 'Create a brief' : `Brief ${items.length} items`}</h3>

      <div className="items">
        {items.slice(0, 8).map((i) => (
          <div key={i.id} className="it" title={i.title}>
            <span className="k">{KIND_LABEL[i.kind] ?? i.kind}</span>
            {i.title}
          </div>
        ))}
        {items.length > 8 && <div className="it">…and {items.length - 8} more</div>}
      </div>

      <label>What you already know (optional, but it makes the brief yours)</label>
      <textarea
        autoFocus
        placeholder={
          single
            ? 'e.g. I think this is the OAuth redirect — check the staging config first.'
            : 'A note that applies to every item in this batch.'
        }
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit()
        }}
      />

      <div className="knobs">
        <Select
          className="pill"
          title="Which playbook shapes the brief"
          aria-label="Playbook"
          value={playbook}
          onValueChange={setPlaybook}
        >
          <SelectItem value="">
            {sameKind ? `Playbook: ${items[0] ? KIND_LABEL[items[0].kind] ?? items[0].kind : 'by kind'}` : 'Playbook: each item’s own kind'}
          </SelectItem>
          {playbooks.map((k) => (
            <SelectItem key={k} value={k}>
              {KIND_LABEL[k as keyof typeof KIND_LABEL] ?? k}
            </SelectItem>
          ))}
        </Select>
        <Select
          className="pill"
          title="Which model runs the playbook"
          aria-label="Model"
          value={model}
          onValueChange={setModel}
        >
          <SelectItem value="">Model: {defaultModelName}</SelectItem>
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </Select>
      </div>

      {error && <div className="projError">{error}</div>}

      <div className="row">
        <button type="button" className="cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="go" disabled={saving || !items.length} onClick={() => void submit()}>
          {saving ? 'Queueing…' : items.length > 1 ? `Queue ${items.length} briefs` : 'Queue the brief'}
        </button>
      </div>
      <p className="sub" style={{ marginTop: 10 }}>
        Runs one at a time, in order, under the daily cap. The run reads only — it never posts, pushes or
        edits — and every run is a session you can open.
      </p>
    </dialog>
  )
}
