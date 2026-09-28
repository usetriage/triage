/**
 * Where an item points: its source, the links you put on it (a Slack thread,
 * the PR, a doc), and the PRs/pages the scanner saw mentioned. One click out
 * to each. Only your own links can be removed — the rest belong to the source.
 */
import { CircleDot, ExternalLink, GitPullRequest, Link2, MessageSquare, Plus, SquareKanban, X } from 'lucide-react'
import { useState } from 'react'
import type { ItemUrlsResponse, ScoredItem } from '../../../shared/protocol.js'
import { itemLinks, type UrlKind } from '../../../core/work/link.js'

const KIND_ICON: Record<UrlKind, typeof Link2> = {
  'github-pr': GitPullRequest,
  'github-issue': CircleDot,
  slack: MessageSquare,
  linear: SquareKanban,
  web: Link2,
}

const ORIGIN_LABEL = { source: 'source', mentioned: 'mentioned', added: '' } as const

type Props = {
  item: ScoredItem
  /** the links as the server saved them — the page patches its copy of the item */
  onSaved: (urls: string[]) => void
  onDirty: () => void
}

export function ItemLinks({ item, onSaved, onDirty }: Props) {
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const links = itemLinks(item)

  async function save(urls: string[]): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/items/urls', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, urls }),
      })
      const b = (await res.json()) as ItemUrlsResponse
      if (!b.ok) {
        setError(b.error)
        return false
      }
      onSaved(b.urls)
      return true
    } catch {
      setError('could not save the link')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function add() {
    const url = draft?.trim() ?? ''
    if (!url) return setDraft(null)
    if (!/^https?:\/\//i.test(url)) return setError('a link must start with http:// or https://')
    if (await save([...(item.urls ?? []), url])) setDraft(null)
  }

  return (
    <div className="linksBlock">
      <div className="head">
        <span className="secLabel mute">
          Links {links.length > 0 && <span className="n">{links.length}</span>}
        </span>
        {draft === null && (
          <button
            type="button"
            className="btn xs ghost"
            onClick={() => {
              setDraft('')
              setError(null)
            }}
            title="Link a Slack thread, a PR, a doc — anything this work refers to"
          >
            <Plus size={11} aria-hidden="true" /> Add link
          </button>
        )}
      </div>

      {links.map((l) => {
        const Icon = KIND_ICON[l.kind]
        return (
          <div key={l.url} className="linkRow">
            <a href={l.url} target="_blank" rel="noreferrer" title={l.url}>
              <Icon size={13} aria-hidden="true" />
              <span className="lab">{l.label}</span>
              {ORIGIN_LABEL[l.origin] && <span className="origin">{ORIGIN_LABEL[l.origin]}</span>}
              <ExternalLink className="out" size={11} aria-hidden="true" />
            </a>
            {l.origin === 'added' ? (
              <button
                type="button"
                className="rm"
                disabled={busy}
                aria-label={`Remove ${l.label}`}
                title="Remove this link"
                onClick={() => void save((item.urls ?? []).filter((u) => u !== l.url))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            ) : (
              // keeps the ↗ column aligned with the removable rows
              <span className="rm" aria-hidden="true" />
            )}
          </div>
        )
      })}

      {links.length === 0 && draft === null && <div className="asideEmpty">No links yet.</div>}

      {draft !== null && (
        <div className="addRow">
          <input
            autoFocus
            type="url"
            value={draft}
            placeholder="Paste a link — Slack thread, PR, doc…"
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
              onDirty()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
              if (e.key === 'Escape') setDraft(null)
            }}
          />
          <button type="button" className="btn xs ghost" onClick={() => setDraft(null)}>
            Cancel
          </button>
          <button type="button" className="btn xs primary" disabled={busy || !draft.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
      )}
      {error && <div className="msg error">{error}</div>}
    </div>
  )
}
