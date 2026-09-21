/**
 * Settings → MCP: how another agent connects to this inbox.
 *
 * The daemon serves its tools at `POST /mcp` (streamable HTTP), so connecting
 * is a URL, not a spawned process — which is the whole reason this tab can be
 * three copyable lines instead of a page of troubleshooting. The workspace
 * rides in that URL, so the snippet shown here is the one for the workspace
 * you are looking at; paste it somewhere else and it still files work here.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import type { SystemResponse, SystemStatus, Workspace } from '../../../shared/protocol.js'

type Client = 'claude' | 'codex' | 'cursor' | 'cloud' | 'stdio'

const CLIENTS: ReadonlyArray<{ id: Client; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'cloud', label: 'Codex Cloud' },
  { id: 'stdio', label: 'No HTTP support' },
]

/** A copyable line. Code lives in a well — mono on the card surface, never bare. */
function Snippet({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* a browser that refuses the clipboard still shows the text to select */
    }
  }
  return (
    <div className="mcpSnip">
      {label && <span className="cap">{label}</span>}
      <div className="row">
        <code>{text}</code>
        <button type="button" className="iconBtn" onClick={() => void copy()} title="Copy" aria-label={`Copy ${label ?? 'snippet'}`}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="mcpStep">
      <span className="n">{n}</span>
      <div className="b">{children}</div>
    </div>
  )
}

export function McpTab({ workspace }: { workspace: Workspace | null }) {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [client, setClient] = useState<Client>('claude')

  useEffect(() => {
    void fetch('/api/system')
      .then((r) => r.json() as Promise<SystemResponse>)
      .then((b) => (b.ok ? setStatus(b.status) : null))
      .catch(() => null)
  }, [])

  // Until the port is known, show the default rather than a spinner: it is
  // right on almost every machine, and a wrong port is a visible failure in
  // the client, not a silent one.
  const port = status?.port ?? 5178
  // The default workspace needs no parameter — a bare URL is the one people
  // remember, and it is also what a fresh install resolves to.
  const qs = workspace && !workspace.isDefault ? `?workspace=${workspace.id}` : ''
  const url = `http://localhost:${port}/mcp${qs}`
  const here = workspace?.name ?? 'this workspace'

  return (
    <>
      <section className="setSection">
        <h3>Endpoint</h3>
        <p className="hint">
          One URL, this machine only. Any MCP client that takes a URL can read and file work in <b>{here}</b> through it —
          the same tools a chat here has.
        </p>
        <Snippet text={url} label="url" />
        <div className="mcpNote">
          {qs ? (
            <>
              The <code>workspace</code> parameter takes a workspace <b>id</b>, not its display name. Drop it and the
              connection lands in the default workspace instead; get it wrong and the connection is refused outright,
              rather than quietly filing into the wrong inbox.
            </>
          ) : (
            <>
              This is the default workspace, so no <code>workspace</code> parameter is needed. Other workspaces append
              their id — switch workspace and this tab shows that one’s URL.
            </>
          )}
        </div>
      </section>

      <section className="setSection">
        <h3>Connect a client</h3>
        <p className="hint">Pick where the agent runs. Each of these is one command or one file.</p>
        <div className="seg" role="tablist" aria-label="Client">
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={client === c.id}
              className={`segBtn${client === c.id ? ' active' : ''}`}
              onClick={() => setClient(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="mcpBody">
          {client === 'claude' && (
            <>
              <Step n={1}>
                Run this anywhere. <b>--scope user</b> makes triage available in every folder.
                <Snippet text={`claude mcp add --transport http --scope user triage ${url}`} />
              </Step>
              <Step n={2}>
                Or keep it to one project — run it in that folder, and the entry lands in its <code>.mcp.json</code>.
                <Snippet text={`claude mcp add --transport http --scope project triage ${url}`} />
              </Step>
              <Step n={3}>
                Check it.
                <Snippet text="claude mcp get triage" />
              </Step>
            </>
          )}

          {client === 'codex' && (
            <>
              <Step n={1}>
                Codex config is global — one entry, every folder.
                <Snippet text={`codex mcp add triage --url ${url}`} />
              </Step>
              <Step n={2}>
                Check it.
                <Snippet text="codex mcp list" />
              </Step>
            </>
          )}

          {client === 'cursor' && (
            <>
              <Step n={1}>
                Put this in <code>~/.cursor/mcp.json</code> for every project, or <code>.cursor/mcp.json</code> inside one
                project for just that folder.
                <Snippet text={JSON.stringify({ mcpServers: { triage: { url } } }, null, 2)} />
              </Step>
              <Step n={2}>Reload Cursor, then check Settings → MCP shows triage with its tools.</Step>
            </>
          )}

          {client === 'cloud' && (
            <>
              <div className="mcpWarn">
                <TriangleAlert size={13} aria-hidden="true" />
                <div>
                  Cloud agents run off this machine, so <code>localhost</code> means <i>their</i> machine, not yours. Reaching
                  this inbox from there means publishing it to the internet — and the endpoint has <b>no authentication</b>,
                  so whoever finds the URL can read every work item and file new ones. Only do this for a run you are
                  watching, and close the tunnel after.
                </div>
              </div>
              <Step n={1}>
                Open a tunnel to the daemon. It prints an https URL.
                <Snippet text={`cloudflared tunnel --url http://localhost:${port}`} />
              </Step>
              <Step n={2}>
                Point the cloud agent at that URL, keeping the path and the workspace.
                <Snippet text={`https://<your-tunnel>.trycloudflare.com/mcp${qs}`} />
              </Step>
              <Step n={3}>Stop the tunnel when the run is done — Ctrl-C in that terminal is the whole revocation story.</Step>
            </>
          )}

          {client === 'stdio' && (
            <>
              <p className="hint">
                For a client that spawns a process instead of taking a URL. Same tools, same rules — it just forwards to
                the daemon over the same API.
              </p>
              <Step n={1}>
                Install triage globally, so the <code>triage-mcp</code> bin is on PATH.
                <Snippet text="npm i -g usetriage" />
              </Step>
              <Step n={2}>
                Point the client at the bin. The environment carries what the URL otherwise would.
                <Snippet
                  text={JSON.stringify(
                    {
                      mcpServers: {
                        triage: {
                          command: 'triage-mcp',
                          env: { TRIAGE_URL: `http://localhost:${port}`, ...(qs ? { TRIAGE_WORKSPACE: workspace?.id } : {}) },
                        },
                      },
                    },
                    null,
                    2,
                  )}
                />
              </Step>
            </>
          )}
        </div>
      </section>

      <section className="setSection">
        <h3>If a client says it failed</h3>
        <div className="mcpNote">
          Three things, in order. <b>Is the daemon up</b> — this page is served by it, so if you are reading this, it is.
          <b> Is the port right</b> — it is {port} here; a dev daemon runs on 5188 and the Vite dev server on 5189 is not the
          API. <b>Is the workspace id real</b> — an id that matches nothing is refused with the list of ids that do.
        </div>
        <div className="mcpNote">
          A chat <i>inside</i> triage never needs any of this: it gets the same tools in-process, bound to its own
          workspace. If such a chat lists a server named <code>triage</code> as failed while its <code>mcp__triage__*</code>{' '}
          tools work, that row belongs to a same-named entry in <code>~/.claude</code> — the in-process one wins the name.
        </div>
      </section>
    </>
  )
}
