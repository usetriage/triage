// End-to-end smoke test: create a session over WS, send one trivial prompt,
// print init info (model + MCP servers) and the assistant's reply.
import { WebSocket } from 'ws'

const PORT = Number(process.env.PORT || 5178)
const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
let sessionId = null
let assistantText = ''
const timeout = setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 180000)

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'create_session',
    title: 'smoke test',
    cwd: '~/Code/prnl/novus-triage/triage-dev',
    firstMessage: 'Reply with exactly the text: POC OK. Nothing else, no tools.',
  }))
})

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.type === 'session_created') {
    sessionId = m.session.id
    console.log('session created:', sessionId)
  }
  if (m.type === 'session_event' && m.sessionId === sessionId) {
    const ev = m.event
    if (ev.kind === 'error') { console.log('ERROR EVENT:', ev.message); process.exit(1) }
    if (ev.kind === 'permission_request') {
      console.log('permission requested (denying for smoke test):', ev.toolName)
      ws.send(JSON.stringify({ type: 'permission_response', sessionId, requestId: ev.id, behavior: 'deny' }))
    }
    if (ev.kind === 'sdk') {
      const msg = ev.message
      if (msg.type === 'system' && msg.subtype === 'init') {
        console.log('INIT model:', msg.model)
        console.log('INIT tools:', (msg.tools || []).length)
        console.log('INIT mcp_servers:', JSON.stringify(msg.mcp_servers || []))
        console.log('INIT plugins:', JSON.stringify(msg.plugins || msg.loaded_plugins || 'n/a'))
      }
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const b of msg.message.content) if (b.type === 'text') assistantText += b.text
      }
      if (msg.type === 'result') {
        console.log('RESULT:', msg.subtype, 'cost:', msg.total_cost_usd, 'turns:', msg.num_turns)
        console.log('ASSISTANT SAID:', assistantText.trim())
        clearTimeout(timeout)
        process.exit(assistantText.includes('POC OK') ? 0 : 1)
      }
    }
  }
})

ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1) })
