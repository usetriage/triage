import { KeyRound } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  mentionToken,
  type PermissionBehavior,
  type QuestionAnswers,
  type ResolvedMention,
  type SessionEvent,
  type SessionTurnSummary,
} from '../../../shared/protocol.js'
import { parseQuestions } from '../askQuestions.js'
import { useLiveText } from '../hooks.js'
import { openSettings } from '../settings.js'
import { buildTranscript, type TranscriptItem } from '../transcript.js'
import { AskCard } from './AskCard.js'
import { InitCard } from './InitCard.js'
import { MentionChip } from './MentionPicker.js'
import { Markdown } from './Markdown.js'
import { PermissionCard } from './PermissionCard.js'
import { ToolCard } from './ToolCard.js'

type Props = {
  sessionId: string
  events: readonly SessionEvent[]
  /** per-turn file counts, so a turn marker can say what that turn changed */
  turns?: readonly SessionTurnSummary[]
  onRespond: (requestId: string, behavior: PermissionBehavior, answers?: QuestionAnswers) => void
}

/**
 * Who else was touching the repo during this turn, in the width a one-line
 * turn marker has. A session's title is the first line of its first message
 * (up to 80 chars), which is far too long to sit inline, so a single one is
 * clamped and several collapse to a count — the full list is in the tooltip.
 */
const MAX_OVERLAP_CHARS = 32

function overlapLabel(titles: readonly string[]): string {
  if (titles.length > 1) return `${titles.length} other sessions`
  const t = titles[0]
  return t.length > MAX_OVERLAP_CHARS ? `${t.slice(0, MAX_OVERLAP_CHARS - 1).trimEnd()}…` : t
}

export function Transcript({ sessionId, events, turns, onRespond }: Props) {
  const items = useMemo(() => buildTranscript(events), [events])
  const { ref, scrollToBottom } = useStickToBottom()

  // Committed events grow the transcript; the streaming line grows it too, but
  // re-renders separately (see LiveLine), so it calls back in here to scroll.
  useLayoutEffect(scrollToBottom, [items, scrollToBottom])

  return (
    <div id="transcript" ref={ref}>
      <div className="inner">
        {items.map((item) => (
          <Item
            key={item.key}
            item={item}
            turn={item.kind === 'meta' && item.turn ? turns?.find((t) => t.seq === item.turn) : undefined}
            onRespond={onRespond}
          />
        ))}
        <LiveLine sessionId={sessionId} onGrow={scrollToBottom} />
      </div>
    </div>
  )
}

/**
 * The user's text with each `@` token shown as its label — `@smoke test`
 * rather than `@session:72dce3d1-…`. The stored text keeps the token; only the
 * rendering changes, so a reload shows the same thing.
 */
function withMentionLabels(text: string, mentions?: readonly ResolvedMention[]): ReactNode {
  if (!mentions?.length) return text
  const tokens = mentions.map((m) => ({ token: mentionToken(m), label: m.label }))
  const out: ReactNode[] = []
  let rest = text
  let k = 0
  while (rest) {
    let first: { i: number; token: string; label: string } | null = null
    for (const t of tokens) {
      const i = rest.indexOf(t.token)
      if (i >= 0 && (first === null || i < first.i)) first = { i, ...t }
    }
    if (!first) {
      out.push(rest)
      break
    }
    if (first.i > 0) out.push(rest.slice(0, first.i))
    out.push(
      <span className="mtok" key={k++} title={first.token}>
        @{first.label}
      </span>,
    )
    rest = rest.slice(first.i + first.token.length)
  }
  return out
}

const Item = memo(function Item({
  item,
  turn,
  onRespond,
}: {
  item: TranscriptItem
  turn?: SessionTurnSummary
  onRespond: Props['onRespond']
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          {item.images && item.images.length > 0 && (
            <div className="msgImages">
              {item.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt={img.name ?? 'Attached image'}
                  title={img.name}
                />
              ))}
            </div>
          )}
          {withMentionLabels(item.text, item.mentions)}
          {item.mentions && item.mentions.length > 0 && (
            <div className="msgMentions">
              {item.mentions.map((m) => (
                <MentionChip
                  key={`${m.kind}:${m.ref}`}
                  m={m}
                  muted={!m.inlined}
                  title={
                    m.error
                      ? `${m.kind === 'file' ? m.ref : m.label} — ${m.error}`
                      : m.kind === 'file'
                        ? `${m.ref}${m.bytes !== undefined ? ` · ${Math.max(1, Math.round(m.bytes / 1024))} KB` : ''}`
                        : m.label
                  }
                />
              ))}
            </div>
          )}
        </div>
      )
    case 'assistant':
      return (
        <div className="msg assistant">
          <Markdown text={item.text} />
        </div>
      )
    case 'thinking':
      return <div className="msg thinking">{item.text}</div>
    case 'error':
      return <ErrorCard text={item.text} />
    case 'meta':
      // A turn that changed files says so here, where it happened — the drawer
      // below answers "in total", this answers "in this turn".
      return (
        <div className="meta">
          <span className="metaText">{item.text}</span>
          {turn && turn.files > 0 && (
            <span className="turnChange">
              {turn.files} {turn.files === 1 ? 'file' : 'files'} <span className="pl">+{turn.insertions}</span>{' '}
              <span className="mn">−{turn.deletions}</span>
              {turn.overlapped.length > 0 && (
                <span className="warn" title={`Ran at the same time as ${turn.overlapped.join(', ')}`}>
                  {' '}
                  · concurrent with {overlapLabel(turn.overlapped)}
                </span>
              )}
            </span>
          )}
        </div>
      )
    case 'command':
      // Local command output is plain text the CLI already formatted (often
      // with its own alignment), so it is shown as-is rather than as markdown.
      return <pre className="msg commandOut">{item.text}</pre>
    case 'init':
      return <InitCard item={item} />
    case 'tool':
      return <ToolCard item={item} />
    case 'permission': {
      // AskUserQuestion arrives as a permission prompt, but it is a question
      // for the reader — render it as choices, not as JSON to approve.
      const questions = item.toolName === 'AskUserQuestion' ? parseQuestions(item.input) : null
      return questions ? (
        <AskCard item={item} questions={questions} onRespond={onRespond} />
      ) : (
        <PermissionCard item={item} onRespond={onRespond} />
      )
    }
  }
})

/**
 * The partially-streamed assistant message. Isolated in its own component so a
 * burst of token deltas re-renders this node alone — the rest of the transcript
 * is untouched between committed messages.
 */
function LiveLine({ sessionId, onGrow }: { sessionId: string; onGrow: () => void }) {
  const text = useLiveText(sessionId)
  useLayoutEffect(() => {
    if (text) onGrow()
  }, [text, onGrow])
  if (!text) return null
  return (
    <div className="msg assistant live">
      <Markdown text={text} />
    </div>
  )
}

/** Follows new output, unless the reader has scrolled up to look at something. */
function useStickToBottom() {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [])

  return { ref, scrollToBottom }
}

/**
 * A failed turn. When the text reads like a credentials problem, the card
 * also offers the fix — the Claude auth tab, opened directly.
 */
const AUTH_ERROR = /api[ -]?key|authenticat|unauthori[sz]ed|not logged in|\/login|\b401\b|credential|oauth|token (?:has )?expired|billing|insufficient credits/i

function ErrorCard({ text }: { text: string }) {
  const authy = AUTH_ERROR.test(text)
  return (
    <div className="msg error">
      {text}
      {authy && (
        <div className="fixRow">
          <span>This looks like a Claude auth problem in this workspace.</span>
          <button type="button" className="btn xs" onClick={() => openSettings('auth')}>
            <KeyRound size={11} aria-hidden="true" /> Fix in Settings
          </button>
        </div>
      )}
    </div>
  )
}
