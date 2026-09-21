// End-to-end smoke test for the MCP surface, against a running server.
//
// Two halves, because triage speaks MCP through two doors and both have
// broken silently before:
//
//   1. POST /mcp — the streamable-HTTP endpoint external clients (Claude
//      Code, Codex) point a URL at. Free: no model, no subprocess.
//   2. Two *concurrent* chat sessions — the in-process server every web chat
//      gets. Regression test for the bug where one server instance was shared
//      across a workspace, so the second live session got `status: "failed"`
//      and a chat with no mcp__triage__* tools. One cheap turn each.
//
// Usage: node scripts/smoke-mcp.mjs   (PORT=5188 for the dev daemon)
import { WebSocket } from 'ws'

const PORT = Number(process.env.PORT || 5178)
const BASE = `http://localhost:${PORT}`
const CWD = process.env.SMOKE_CWD || '~/Code/prnl/triage-dev'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const rpc = async (body, { workspace, origin } = {}) => {
  const url = workspace ? `${BASE}/mcp?workspace=${encodeURIComponent(workspace)}` : `${BASE}/mcp`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON body is itself the finding */
  }
  return { status: res.status, json, text }
}

async function httpEndpoint() {
  console.log(`\n# POST ${BASE}/mcp`)

  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  check('initialize answers', init.status === 200 && init.json?.result?.serverInfo?.name === 'triage', `status ${init.status}`)
  check('initialize carries instructions', typeof init.json?.result?.instructions === 'string')

  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = (tools.json?.result?.tools ?? []).map((t) => t.name)
  check('tools/list returns the contract', names.includes('list_work_items') && names.includes('create_work_item'), `${names.length} tools`)

  const ws = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_workspace', arguments: {} } })
  const body = ws.json?.result?.content?.[0]?.text ?? ''
  check('get_workspace reads the daemon', ws.json?.result?.isError === false && body.includes('"current"'))

  // The whole point of putting the workspace in the URL: a wrong id is refused
  // at connect time instead of quietly filing work into the default inbox.
  const bad = await rpc({ jsonrpc: '2.0', id: 4, method: 'initialize' }, { workspace: 'no-such-workspace' })
  check('unknown workspace is refused', bad.status === 404 && Array.isArray(bad.json?.known), `status ${bad.status}`)

  const cross = await rpc({ jsonrpc: '2.0', id: 5, method: 'ping' }, { origin: 'https://evil.example' })
  check('cross-origin POST is refused', cross.status === 403, `status ${cross.status}`)

  const get = await fetch(`${BASE}/mcp`)
  check('GET is 405 (no SSE offered)', get.status === 405, `status ${get.status}`)

  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  check('notification gets 202, no body', note.status === 202 && note.text === '')
}

/**
 * One chat session; resolves with whether it actually got the triage tools.
 *
 * Checked on the tool list, not on the server's status row: a same-named
 * entry in ~/.claude can be the row that gets reported while the in-process
 * server is the one serving, so the status alone both false-alarms and, if it
 * ever read the other way, would hide a real outage.
 */
function sessionTriageStatus(label) {
  return new Promise((resolve) => {
    const sock = new WebSocket(`ws://localhost:${PORT}/ws`)
    let sessionId = null
    const done = (v) => {
      try {
        sock.close()
      } catch {
        /* already closing */
      }
      resolve(v)
    }
    const timer = setTimeout(() => done('timeout'), 120000)
    sock.on('open', () =>
      sock.send(
        JSON.stringify({
          type: 'create_session',
          title: `mcp smoke ${label}`,
          cwd: CWD,
          firstMessage: 'Reply with exactly: OK. No tools.',
        }),
      ),
    )
    sock.on('error', () => done('ws error'))
    sock.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      if (m.type === 'session_created') sessionId = m.session.id
      if (m.type !== 'session_event' || m.sessionId !== sessionId) return
      const ev = m.event
      if (ev.kind === 'permission_request')
        sock.send(JSON.stringify({ type: 'permission_response', sessionId, requestId: ev.id, behavior: 'deny' }))
      if (ev.kind !== 'sdk') return
      const msg = ev.message
      if (msg.type === 'system' && msg.subtype === 'init') {
        const tools = (msg.tools ?? []).filter((t) => t.startsWith('mcp__triage__'))
        const row = (msg.mcp_servers ?? []).find((s) => s.name === 'triage')
        clearTimeout(timer)
        done(tools.length > 0 ? 'serving' : `no tools (row says ${row?.status ?? 'absent'})`)
      }
    })
  })
}

async function concurrentSessions() {
  console.log('\n# two concurrent chat sessions (in-process server)')
  const [a, b] = await Promise.all([sessionTriageStatus('a'), sessionTriageStatus('b')])
  check('first session has the triage tools', a === 'serving', a)
  check('second concurrent session has the triage tools', b === 'serving', b)
}

const health = await fetch(`${BASE}/api/health`).catch(() => null)
if (!health?.ok) {
  console.log(`no triage daemon on ${BASE} — start one first (\`triage start\`, or \`npm run dev\` with PORT=5188)`)
  process.exit(2)
}

await httpEndpoint()
if (process.env.SMOKE_HTTP_ONLY) console.log('\n(skipping session checks: SMOKE_HTTP_ONLY)')
else await concurrentSessions()

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
