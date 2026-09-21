import { memo } from 'react'
import type { TranscriptItem } from '../transcript.js'

type Init = Extract<TranscriptItem, { kind: 'init' }>

/** `mcp__<server>__<tool>` → the server name, with the SDK's own escaping undone. */
const serverOf = (tool: string) => tool.slice(5).split('__')[0] ?? ''

/**
 * The session's opening line: model, tool count, and every MCP server it
 * loaded. Status is a dot, not a colour wash — connected green, anything else
 * dim — so a long connector list reads as inventory, not as a wall of alarms.
 *
 * The status a server reports is not always the truth about this session. Two
 * servers can claim one name — triage's own in-process server always wins the
 * name `triage` over anything in ~/.claude — and the card would then show the
 * loser's status next to the winner's tools. So a server whose tools are in
 * the session reads as working, whatever its row said.
 */
export const InitCard = memo(function InitCard({ item }: { item: Init }) {
  const serving = new Set(item.mcpTools.map(serverOf))
  const live = (name: string, status: string) => status === 'connected' || serving.has(name)
  const connected = item.servers.filter((s) => live(s.name, s.status)).length
  return (
    <details className="init">
      <summary>
        session ready · model <b>{item.model ?? '?'}</b> · {item.toolCount} tools
        {item.servers.length > 0 && (
          <>
            {' '}
            · {connected}/{item.servers.length} servers connected
          </>
        )}
      </summary>
      {item.servers.length > 0 && (
        <div className="mcp">
          {[...item.servers]
            .sort((a, b) => Number(live(b.name, b.status)) - Number(live(a.name, a.status)))
            .map((s) => {
              const ok = live(s.name, s.status)
              const title = ok && s.status !== 'connected' ? `${s.status} — but its tools are loaded (a server of the same name is serving them)` : s.status
              return (
                <span key={s.name} className="pill mute" title={title}>
                  <span className={`dot sm ${ok ? 'green' : s.status === 'failed' ? 'red' : 'stone'}`} />
                  {s.name}
                </span>
              )
            })}
        </div>
      )}
    </details>
  )
})
