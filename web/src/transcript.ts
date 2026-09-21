/**
 * Folds a session's event log into a flat list of renderable items.
 *
 * Pure and memoisable: the events array only ever grows by append, so this runs
 * once per committed event, not once per token. Tool results arrive in a later
 * `user` message than the `tool_use` that produced them, so they are stitched
 * back onto their card here rather than in a component.
 */
import {
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  type ImageAttachment,
  type ResolvedMention,
  type McpServerInfo,
  type PermissionBehavior,
  type QuestionAnswers,
  type RawBlock,
  type SessionEvent,
  type ToolEffect,
} from '../../shared/protocol.js'

export type ToolResult = { text: string; isError: boolean }

export type TranscriptItem =
  | { key: string; kind: 'user'; text: string; images?: ImageAttachment[]; mentions?: ResolvedMention[] }
  | { key: string; kind: 'assistant'; text: string }
  | { key: string; kind: 'thinking'; text: string }
  | { key: string; kind: 'error'; text: string }
  | { key: string; kind: 'meta'; text: string; /** 1-based turn this marker ends, for the changeset line */ turn?: number }
  | { key: string; kind: 'init'; model?: string; toolCount: number; servers: McpServerInfo[]; mcpTools: string[] }
  /** What a local command (`/usage`, `/context`) printed — not the model talking. */
  | { key: string; kind: 'command'; text: string }
  | {
      key: string
      kind: 'tool'
      name: string
      input: Record<string, unknown>
      result?: ToolResult
    }
  | {
      key: string
      kind: 'permission'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      canAlwaysAllow?: boolean
      effect?: ToolEffect
      resolved?: PermissionBehavior | 'expired'
      /** AskUserQuestion only: what the user picked, for the replayed card. */
      answers?: QuestionAnswers
    }

export function buildTranscript(events: readonly SessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  // A second init in one log means the subprocess was restarted (`resume`) —
  // render those as a one-line marker instead of repeating the full card.
  let initSeen = false
  // Turns are counted the way the server counts them: one per `result`, so a
  // marker can be matched to the snapshot pair that bracketed it.
  let turnSeq = 0
  // Items are rebuilt on every append, so late-arriving results and permission
  // verdicts are patched onto the item objects created earlier in this pass.
  const toolsById = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>()
  const permsById = new Map<string, Extract<TranscriptItem, { kind: 'permission' }>>()

  events.forEach((ev, i) => {
    switch (ev.kind) {
      case 'local_user':
        items.push({ key: `u${i}`, kind: 'user', text: ev.text, images: ev.images, mentions: ev.mentions })
        break
      case 'error':
        items.push({ key: `e${i}`, kind: 'error', text: ev.message })
        break
      case 'permission_request': {
        const item = {
          key: `p${i}`,
          kind: 'permission' as const,
          id: ev.id,
          toolName: ev.toolName,
          input: ev.input,
          title: ev.title,
          canAlwaysAllow: ev.canAlwaysAllow,
          effect: ev.effect,
        }
        permsById.set(ev.id, item)
        items.push(item)
        break
      }
      case 'permission_resolved': {
        const item = permsById.get(ev.id)
        if (item) {
          item.resolved = ev.behavior
          item.answers = ev.answers
        }
        break
      }
      case 'sdk': {
        const m = ev.message
        if (m.type === 'system' && m.subtype === 'init') {
          if (initSeen) {
            items.push({ key: `i${i}`, kind: 'meta', text: `— session resumed · ${m.model ?? '?'} —` })
          } else {
            initSeen = true
            items.push({
              key: `i${i}`,
              kind: 'init',
              model: m.model,
              toolCount: m.tools?.length ?? 0,
              servers: m.mcp_servers ?? [],
              // Which servers actually put tools on the table. The status a
              // server reports and the tools a session got can disagree: the
              // in-process triage server always wins its name, so a same-named
              // entry from ~/.claude that failed is the status being shown
              // while the working tools are right there in the list.
              mcpTools: (m.tools ?? []).filter((t) => t.startsWith('mcp__')),
            })
          }
        } else if (m.type === 'system' && m.subtype === 'local_command_output') {
          // A command the CLI answers by itself — `/usage`, `/context`. Without
          // this the message would send and visibly do nothing, which is
          // exactly what someone tries a command picker on first.
          if (m.content?.trim()) items.push({ key: `lc${i}`, kind: 'command', text: m.content })
        } else if (m.type === 'assistant') {
          for (const [j, b] of (m.message?.content ?? []).entries()) {
            if (isTextBlock(b) && b.text.trim()) {
              items.push({ key: `a${i}.${j}`, kind: 'assistant', text: b.text })
            } else if (isThinkingBlock(b) && b.thinking) {
              items.push({ key: `t${i}.${j}`, kind: 'thinking', text: truncate(b.thinking, 400) })
            } else if (isToolUseBlock(b)) {
              const item = {
                key: `c${i}.${j}`,
                kind: 'tool' as const,
                name: b.name,
                input: b.input,
              }
              toolsById.set(b.id, item)
              items.push(item)
            }
          }
        } else if (m.type === 'user') {
          for (const b of m.message?.content ?? []) {
            if (!isToolResultBlock(b)) continue
            const item = toolsById.get(b.tool_use_id)
            if (item) item.result = { text: resultText(b.content), isError: b.is_error === true }
          }
        } else if (m.type === 'result') {
          const cost = m.total_cost_usd != null ? ` · $${m.total_cost_usd.toFixed(4)}` : ''
          const secs = ((m.duration_ms ?? 0) / 1000).toFixed(1)
          turnSeq += 1
          items.push({
            key: `r${i}`,
            kind: 'meta',
            turn: turnSeq,
            text: `— turn done · ${secs}s · ${m.num_turns ?? 0} turns${cost} —`,
          })
        }
        break
      }
    }
  })

  return items
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + ' …' : s
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as RawBlock[])
      .map((c) => (isTextBlock(c) ? c.text : `[${c.type}]`))
      .join('\n')
  }
  return JSON.stringify(content)
}

/** The one-line hint shown next to a tool name in the collapsed card. */
export function toolHint(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'pattern', 'url', 'description']) {
    const v = input[k]
    if (typeof v === 'string' && v) return ' — ' + truncate(v, 80)
  }
  return ''
}
