import { Check, ChevronRight, Loader, X } from 'lucide-react'
import { memo } from 'react'
import { toolLine, toolResultNote, toolsDuration, truncate, type ToolItem, type TranscriptItem } from '../transcript.js'

type Group = Extract<TranscriptItem, { kind: 'toolGroup' }>
type State = 'busy' | 'ok' | 'fail'

const stateOf = (t: ToolItem): State => (t.result ? (t.result.isError ? 'fail' : 'ok') : 'busy')

function Glyph({ state, size }: { state: State; size: number }) {
  return (
    <span className={`glyph ${state}`} aria-label={state}>
      {state === 'busy' ? (
        <Loader size={size} aria-hidden="true" />
      ) : state === 'ok' ? (
        <Check size={size} aria-hidden="true" />
      ) : (
        <X size={size} aria-hidden="true" />
      )}
    </span>
  )
}

/** What a call is doing, in words: Bash's own `description`, else tool + target. */
function label(t: ToolItem): string {
  if (t.name === 'Bash' && typeof t.input.description === 'string' && t.input.description) return t.input.description
  const l = toolLine(t.name, t.input)
  return [l.verb, l.target, l.server && `· ${l.server}`].filter(Boolean).join(' ')
}

/**
 * A run of tool calls as one pill, sized to its text so it reads as an aside
 * between sentences. It says what the run set out to do (its first call), how
 * many steps it took and how long. The label holds still while calls stream in
 * — only the step count moves — so the pill doesn't change width under the
 * reader. A failed call opens it, since that one needs reading.
 */
export const ToolGroup = memo(function ToolGroup({ item }: { item: Group }) {
  const tools = item.members.filter((m): m is ToolItem => m.kind === 'tool')
  const busy = tools.some((t) => !t.result)
  const failed = tools.filter((t) => t.result?.isError).length
  const state: State = busy ? 'busy' : failed ? 'fail' : 'ok'
  const steps = `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`
  const count = busy
    ? `step ${tools.length}`
    : [tools.length > 1 || failed ? steps : '', failed ? `${failed} failed` : '', toolsDuration(tools)]
        .filter(Boolean)
        .join(' · ')

  return (
    <details className={`toolGroup ${state}`} open={failed > 0}>
      <summary>
        <Glyph state={state} size={11} />
        <span className="tgLabel">{label(tools[0])}</span>
        {count && <span className="tgCount mono">{count}</span>}
        <ChevronRight size={11} className="chev" aria-hidden="true" />
      </summary>
      <div className="tgBody">
        {item.members.map((m) =>
          m.kind === 'tool' ? (
            <ToolLine key={m.key} item={m} open={tools.length === 1} />
          ) : (
            <div key={m.key} className="msg thinking">
              {m.text}
            </div>
          ),
        )}
      </div>
    </details>
  )
})

/** One call inside a group: a flat line that opens to the raw input and output. */
function ToolLine({ item, open }: { item: ToolItem; open: boolean }) {
  const l = toolLine(item.name, item.input)
  const note = [toolResultNote(item), toolsDuration([item])].filter(Boolean).join(' · ')
  const command = typeof item.input.command === 'string' ? `$ ${item.input.command}` : null
  return (
    <details className="tline" open={open}>
      <summary>
        <Glyph state={stateOf(item)} size={12} />
        <span className="tlVerb">{l.verb}</span>
        <span className="tlTarget mono" title={item.name === 'Bash' ? command ?? undefined : undefined}>
          {item.name === 'Bash' ? label(item) : l.target}
          {l.server && <span className="tlServer"> · {l.server}</span>}
        </span>
        {note && <span className={`tlNote mono${item.result?.isError ? ' fail' : ''}`}>{note}</span>}
      </summary>
      <pre className="well">{truncate(command ?? JSON.stringify(item.input, null, 2), 2000)}</pre>
      {item.result && (
        <pre className={`well result${item.result.isError ? ' fail' : ''}`}>
          {truncate(item.result.text || '(no output)', 2000)}
        </pre>
      )}
    </details>
  )
}
