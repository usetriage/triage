#!/usr/bin/env node
/**
 * Triage MCP server (stdio) — the ingestion contract as MCP tools, so any
 * external scanner (a Claude Code routine, a cron'd headless session, a gh-aw
 * workflow) can *be* a watch-runner: "read #channel, find X, call
 * upsert_work_item" — and cannot create duplicates or clobber user state,
 * because every rule is enforced server-side (.docs/watches.md).
 *
 * A thin shim: JSON-RPC 2.0 over stdio (newline-delimited, per the MCP stdio
 * transport), forwarding to the running triage server's HTTP API. Hand-rolled
 * on purpose — no MCP SDK dependency (vision principle 5), and the SQLite
 * single-writer stays the server process.
 *
 *   claude mcp add triage -- npx tsx /path/to/server/mcp.ts
 *   TRIAGE_URL overrides the default http://localhost:5178
 *   TRIAGE_WORKSPACE names the workspace to act in (.docs/workspaces.md);
 *   unset = the default workspace — an external agent never writes into an
 *   ambiguous workspace. A *set* id that no workspace matches is refused, not
 *   silently resolved to the default: a typo must not write into the wrong
 *   inbox. Only get_workspace still answers, so the mismatch is diagnosable.
 */
import readline from 'node:readline'
import { TRIAGE_MCP_INSTRUCTIONS } from '../shared/triageContext.js'
import { callTool, PROTOCOL_VERSION, TOOLS } from '../core/mcp/tools.js'

const BASE_URL = (process.env.TRIAGE_URL || 'http://localhost:5178').replace(/\/$/, '')
const WORKSPACE = process.env.TRIAGE_WORKSPACE || ''

type JsonRpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

/** A failure of the connection itself, not of the call — reported as tool text. */
class ShimError extends Error {}

/** What to tell the caller to run, picked from the URL they configured. */
const startHint =
  BASE_URL === 'http://localhost:5178'
    ? 'start it with `triage start`'
    : `start the daemon serving ${BASE_URL} (the dev one is \`npm run dev\`, port 5188)`

async function api(path: string, body?: unknown, method?: string): Promise<unknown> {
  // Scope every call to the configured workspace (?workspace= wins server-side).
  if (WORKSPACE) path += `${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(WORKSPACE)}`
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new ShimError(
      `triage daemon not reachable at ${BASE_URL} — ${startHint}. (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  // The API answers JSON for its own failures too ({ ok: false, error }), so a
  // body that will not parse means we are not talking to a triage server at
  // all — a wrong port (the Vite dev server serves HTML on 5189) or a proxy.
  const text = await res.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ShimError(
      `${BASE_URL} answered ${res.status} with a non-JSON body for ${path} — that is not the triage API. Check TRIAGE_URL.`,
    )
  }
}

/**
 * Refuse to act on a workspace the caller did not ask for. `TRIAGE_WORKSPACE`
 * is resolved server-side with a silent fallback to the default, so a typo'd
 * id would quietly write into the wrong inbox; checked once here instead, and
 * only the success is cached (a workspace created later heals on the next
 * call, without a restart).
 */
let workspaceOk = false
async function workspaceRefusal(): Promise<string | null> {
  if (!WORKSPACE || workspaceOk) return null
  const body = (await api('/api/workspace')) as {
    ok: boolean
    current?: { id: string }
    workspaces?: { id: string }[]
    error?: string
  }
  if (!body.ok || !body.current) throw new ShimError(`could not read the workspace roster: ${body.error ?? 'no workspace'}`)
  if (body.current.id === WORKSPACE) {
    workspaceOk = true
    return null
  }
  const known = (body.workspaces ?? []).map((w) => w.id).join(', ')
  return `refusing to act: TRIAGE_WORKSPACE="${WORKSPACE}" matches no workspace on ${BASE_URL}, which would silently fall back to "${body.current.id}". Known ids: ${known || '(none)'}. Fix TRIAGE_WORKSPACE (ids, not display names) or unset it to use the default.`
}

function reply(id: number | string, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id: number | string, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  void (async () => {
    let msg: JsonRpcRequest
    try {
      msg = JSON.parse(line) as JsonRpcRequest
    } catch {
      return // not a JSON-RPC frame — ignore
    }
    if (msg.id === undefined) return // notification (e.g. notifications/initialized)
    try {
      switch (msg.method) {
        case 'initialize':
          reply(msg.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'triage', version: '0.2.0' },
            // The same self-description the in-process server carries — an
            // external Claude Code session should learn what triage is from
            // the same string a web chat does (shared/triageContext.ts).
            instructions: TRIAGE_MCP_INSTRUCTIONS,
          })
          break
        case 'ping':
          reply(msg.id, {})
          break
        case 'tools/list':
          reply(msg.id, { tools: TOOLS })
          break
        case 'tools/call': {
          const name = String(msg.params?.name ?? '')
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
          // get_workspace is the diagnostic for a workspace mismatch, so it
          // answers even when the requested id is wrong; nothing else does.
          const refusal = name === 'get_workspace' ? null : await workspaceRefusal()
          const { text, isError } = refusal
            ? { text: refusal, isError: true }
            : await callTool(api, { serverUrl: BASE_URL, requestedWorkspace: WORKSPACE || null }, name, args)
          reply(msg.id, { content: [{ type: 'text', text }], isError })
          break
        }
        default:
          replyError(msg.id, -32601, `method not found: ${msg.method}`)
      }
    } catch (err) {
      // A dead daemon or a wrong TRIAGE_URL is the caller's problem to fix, not
      // a protocol fault: hand it back as tool text they can read and act on.
      if (err instanceof ShimError && msg.method === 'tools/call') {
        reply(msg.id, { content: [{ type: 'text', text: err.message }], isError: true })
        return
      }
      replyError(msg.id, -32603, err instanceof Error ? err.message : String(err))
    }
  })()
})
