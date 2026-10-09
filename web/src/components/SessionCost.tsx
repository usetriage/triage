/**
 * What this session has cost, as a pill in the chat header; hover (or tap, on
 * a phone) for the split — input, output, cache writes and reads, and models.
 *
 * Same ledger and vocabulary as the item page's cost block (`/api/usage/sessions`,
 * `usageFormat.ts`), so the two never disagree. The transcript is the source,
 * so a running session's figure is a floor: it is refetched a beat after each
 * assistant message lands and again when the session settles.
 */
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { SessionStatus, SessionsUsage, SessionsUsageResponse } from '../../../shared/protocol.js'
import { useEvents } from '../hooks.js'
import { MAX_SERIES, OTHER, SERIES, modelLabel, money, tokens } from '../usageFormat.js'

/** The widest window the ledger offers — a session from last month still adds up. */
const DAYS = 90
/** Claude Code appends to its transcript a moment after the SDK emits the message. */
const SETTLE_MS = 1500
const HOVER_OPEN_MS = 120
const HOVER_CLOSE_MS = 160

/** The last figure per session, so landing on one shows it at once and refreshes behind. */
const lastSeen = new Map<string, SessionsUsage>()

export function SessionCost({ sessionId, status }: { sessionId: string; status: SessionStatus }) {
  const events = useEvents(sessionId)
  const replies = events.reduce((n, ev) => (ev.kind === 'sdk' && ev.message.type === 'assistant' ? n + 1 : n), 0)
  const [usage, setUsage] = useState<SessionsUsage | null>(() => lastSeen.get(sessionId) ?? null)
  const [open, setOpen] = useState(false)
  /** The session the ledger has answered for — until then, a skeleton holds the pill's place. */
  const [settled, setSettled] = useState<string | null>(() => (lastSeen.has(sessionId) ? sessionId : null))
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** The session whose first, undelayed fetch has gone out. */
  const fetchedFor = useRef<string | null>(null)

  useEffect(() => {
    setUsage(lastSeen.get(sessionId) ?? null)
    setSettled(lastSeen.has(sessionId) ? sessionId : null)
  }, [sessionId])

  useEffect(() => {
    let live = true
    // Landing on a session fetches straight away; only a new reply or a status
    // change waits for Claude Code to finish writing its transcript.
    const first = fetchedFor.current !== sessionId
    const t = setTimeout(
      () => {
        // Marked once it actually goes out: events loading a beat after landing
        // re-run this effect, and a cancelled first fetch must stay undelayed.
        fetchedFor.current = sessionId
        void fetch(`/api/usage/sessions?ids=${encodeURIComponent(sessionId)}&days=${DAYS}`)
          .then((r) => r.json() as Promise<SessionsUsageResponse>)
          .then((b) => {
            if (b.ok) lastSeen.set(sessionId, b.usage)
            if (!live) return
            if (b.ok) setUsage(b.usage)
            setSettled(sessionId)
          })
          .catch(() => {
            if (live) setSettled(sessionId)
          })
      },
      first ? 0 : SETTLE_MS,
    )
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [sessionId, replies, status])

  useEffect(() => () => clearTimeout(hover.current), [])

  const spend = usage?.bySession[sessionId]
  if (!spend) {
    // Loading: a faint bar where the figure will land.
    // Answered with no spend (a session yet to reply): nothing.
    return settled === sessionId ? null : <span className="costSkel" aria-hidden="true" />
  }

  const later = (next: boolean, ms: number) => {
    clearTimeout(hover.current)
    hover.current = setTimeout(() => setOpen(next), ms)
  }
  const hoverProps = {
    onPointerEnter: (e: PointerEvent) => e.pointerType === 'mouse' && later(true, HOVER_OPEN_MS),
    onPointerLeave: (e: PointerEvent) => e.pointerType === 'mouse' && later(false, HOVER_CLOSE_MS),
  }

  const prompt = spend.input + spend.cacheWrite + spend.cacheRead
  const hit = prompt > 0 ? Math.round((spend.cacheRead / prompt) * 100) : 0
  const models = (usage?.models ?? []).filter((m) => m.tokens > 0)
  const running = status === 'running' || status === 'starting'

  const rows: Array<[string, number, string?]> = [
    ['Input', spend.input],
    ['Output', spend.output],
    ['Cache write', spend.cacheWrite],
    ['Cache read', spend.cacheRead, prompt > 0 ? `${hit}% of prompt` : undefined],
  ]

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`pill mono costPill${open ? ' on' : ''}`}
          aria-label={`Session cost ${money(spend.cost)} — show breakdown`}
          {...hoverProps}
        >
          {money(spend.cost)}
          {!spend.priced && '+'}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="costPop"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          {...hoverProps}
        >
          <div className="head">
            <span className="lab">Session cost</span>
            {running && <span className="win">so far</span>}
          </div>
          <div className="big">
            {money(spend.cost)}
            {!spend.priced && <span className="approx">+</span>}
          </div>
          <div className="sub">
            {tokens(spend.tokens)} tokens · {spend.messages} {spend.messages === 1 ? 'API call' : 'API calls'}
          </div>

          {/* A daemon older than the breakdown sends the totals only. */}
          {typeof spend.input === 'number' && (
            <dl className="split">
              {rows.map(([label, n, note]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {note && <span className="note">{note}</span>}
                    {tokens(n)}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {models.length > 0 && (
            <div className="keys">
              {models.map((m, i) => (
                <span className="key" key={m.model}>
                  <i className="sw" style={{ background: i < MAX_SERIES ? SERIES[i] : OTHER }} aria-hidden="true" />
                  {modelLabel(m.model)} <span className="v">{m.priced ? money(m.cost) : '—'}</span>
                </span>
              ))}
            </div>
          )}

          <div className="foot">list-price equivalent{!spend.priced && ' · some tokens unpriced'}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
