/**
 * The watch form's integrations field (watch-spec.md, item 1): the built-ins
 * (Web, GitHub, writing files) plus every MCP server Claude Code can load in
 * the watch's project folder — claude.ai connectors, global, local and project
 * servers — discovered by the server's probe, so a newly connected server
 * shows up without a triage release.
 *
 * Selecting a server checks its default tools: our curated preset when we
 * have one, else the tools the server marks read-only. Everything else stays
 * unchecked and labelled; the read-only flag is the server's own claim.
 */
import * as Checkbox from '@radix-ui/react-checkbox'
import * as Collapsible from '@radix-ui/react-collapsible'
import * as Tabs from '@radix-ui/react-tabs'
import { AlertTriangle, Check, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Connector, ConnectorScope, ConnectorsResponse, ConnectorTool, WatchToolGrant } from '../../../shared/protocol.js'
import { builtinGrant, defaultToolsFor, grantKey, looksReadOnly, serverLabel, type BuiltinToolId } from '../../../core/watch/tools.js'
import { relTime } from '../itemUi.js'
import { BUILTINS, grantIcon } from '../watchUi.js'

const SCOPE_LABEL: Record<ConnectorScope, string> = {
  claudeai: 'claude.ai connectors',
  user: 'Global',
  project: 'This project (.mcp.json)',
  local: 'This folder (private)',
  plugin: 'Plugins',
  managed: 'Managed',
  unknown: 'Other',
}
const SCOPE_ORDER: ConnectorScope[] = ['claudeai', 'user', 'project', 'local', 'plugin', 'managed', 'unknown']

/** Tabs by where a server comes from. "folder" = this project's shared + private servers. */
type TabId = 'all' | 'claudeai' | 'global' | 'folder' | 'other'
const TABS: Array<{ id: TabId; label: string; scopes: ConnectorScope[] }> = [
  { id: 'all', label: 'All', scopes: SCOPE_ORDER },
  { id: 'claudeai', label: 'claude.ai', scopes: ['claudeai'] },
  { id: 'global', label: 'Global', scopes: ['user'] },
  { id: 'folder', label: 'This folder', scopes: ['project', 'local'] },
  { id: 'other', label: 'Plugins & other', scopes: ['plugin', 'managed', 'unknown'] },
]

/** A server from an older triage server carries no scope — read it as "unknown", never drop it. */
const scopeOf = (c: Connector): ConnectorScope => (SCOPE_ORDER.includes(c.scope) ? c.scope : 'unknown')

const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

type Probe =
  | { phase: 'loading' }
  | { phase: 'ready'; connectors: Connector[]; probedAt: number; elsewhere: Array<{ name: string; folder: string }>; stale: boolean }
  | { phase: 'error'; message: string }

const healthy = (c: Connector) => c.status === 'connected'
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function WatchToolPicker({
  projectId,
  value,
  onChange,
}: {
  projectId: string
  value: WatchToolGrant[]
  onChange: (grants: WatchToolGrant[]) => void
}) {
  const [probe, setProbe] = useState<Probe>({ phase: 'loading' })
  const [nonce, setNonce] = useState(0)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<TabId>('all')
  const [query, setQuery] = useState('')
  const [showUnavailable, setShowUnavailable] = useState(false)
  const [showElsewhere, setShowElsewhere] = useState(false)

  useEffect(() => {
    if (!projectId) return
    let live = true
    setProbe({ phase: 'loading' })
    const qs = new URLSearchParams({ projectId, ...(nonce ? { refresh: '1' } : {}) })
    void fetch(`/api/connectors?${qs}`)
      .then((r) => r.json() as Promise<ConnectorsResponse>)
      .then((b) => {
        if (!live) return
        setProbe(
          b.ok
            ? {
                phase: 'ready',
                connectors: b.connectors,
                probedAt: b.probedAt,
                elsewhere: b.elsewhere ?? [],
                // a server older than this page reports no scope or tools
                stale: b.connectors.some((c) => c.scope === undefined || c.tools === undefined),
              }
            : { phase: 'error', message: b.error },
        )
      })
      .catch((err) => live && setProbe({ phase: 'error', message: String(err) }))
    return () => {
      live = false
    }
  }, [projectId, nonce])

  const byKey = useMemo(() => new Map(value.map((g) => [grantKey(g.source), g])), [value])
  const hasBuiltin = (id: BuiltinToolId) => byKey.has(`builtin:${id}`)

  const toggleBuiltin = (id: BuiltinToolId) =>
    onChange(hasBuiltin(id) ? value.filter((g) => grantKey(g.source) !== `builtin:${id}`) : [...value, builtinGrant(id)])

  const setServerTools = (c: Connector, tools: string[]) => {
    const key = `mcp:${c.server}`
    const rest = value.filter((g) => grantKey(g.source) !== key)
    onChange(tools.length ? [...rest, { source: { kind: 'mcp', server: c.server, scope: c.scope }, tools }] : rest)
  }

  const toggleServer = (c: Connector) => {
    const current = byKey.get(`mcp:${c.server}`)
    if (current) return setServerTools(c, [])
    const defaults = defaultToolsFor(c.server, c.tools)
    if (defaults.length) setServerTools(c, defaults)
    // open it: show what got checked, or — nothing read-only to pre-check — let the user pick
    setOpen((s) => new Set(s).add(c.server))
  }

  const connectors = probe.phase === 'ready' ? probe.connectors : []
  const known = new Set(connectors.map((c) => c.server))
  // Saved grants for servers this folder's probe doesn't report — kept, flagged, removable.
  const orphans = value.filter((g) => g.source.kind === 'mcp' && probe.phase === 'ready' && !known.has(g.source.server))

  // Connected servers (and any server this watch already uses) are listed by
  // scope; the rest — usually a long tail of connectors awaiting auth — fold
  // into one line so they don't bury the ones that work. Tabs split by source,
  // the search narrows by server or tool name.
  const listed = (c: Connector) => healthy(c) || byKey.has(`mcp:${c.server}`)
  const q = query.trim().toLowerCase()
  const matches = (c: Connector) => !q || c.name.toLowerCase().includes(q) || (c.tools ?? []).some((t) => t.name.toLowerCase().includes(q))
  const tabScopes = TABS.find((t) => t.id === tab)!.scopes
  const inTab = (c: Connector) => tabScopes.includes(scopeOf(c)) && matches(c)
  const groups = SCOPE_ORDER.filter((scope) => tabScopes.includes(scope))
    .map((scope) => ({ scope, items: connectors.filter((c) => scopeOf(c) === scope && listed(c) && matches(c)) }))
    .filter((g) => g.items.length)
  const unavailable = connectors.filter((c) => inTab(c) && !listed(c))
  const elsewhere = probe.phase === 'ready' && (tab === 'all' || tab === 'folder') ? probe.elsewhere.filter((e) => !q || e.name.toLowerCase().includes(q)) : []
  const tabCount = (t: (typeof TABS)[number]) => connectors.filter((c) => t.scopes.includes(scopeOf(c)) && listed(c)).length
  const visibleTabs = TABS.filter((t) => t.id === 'all' || tabCount(t) > 0 || (t.id === 'folder' && probe.phase === 'ready' && probe.elsewhere.length > 0))
  const empty = groups.length === 0 && unavailable.length === 0 && elsewhere.length === 0

  return (
    <div className="toolPicker">
      <div className="chipRow">
        {BUILTINS.map((b) => {
          const on = hasBuiltin(b.id)
          const Icon = on ? Check : b.icon
          return (
            <button
              key={b.id}
              type="button"
              className={`cchip${on ? ' on' : ''}${b.id === 'files-write' && on ? ' warn' : ''}`}
              aria-pressed={on}
              title={b.hint}
              onClick={() => toggleBuiltin(b.id)}
            >
              <Icon size={13} aria-hidden="true" className={on ? 'tick' : undefined} />
              {b.label}
            </button>
          )
        })}
      </div>
      {hasBuiltin('files-write') && (
        <span className="hint warnText">
          <AlertTriangle size={12} aria-hidden="true" /> Runs may write and edit files inside this project’s folder.
        </span>
      )}

      <div className="card toolServers">
        <div className="tsHead">
          <span>MCP servers</span>
          <span className="m">
            {probe.phase === 'loading'
              ? 'Checking what connects in this folder…'
              : probe.phase === 'ready'
                ? `${value.filter((g) => g.source.kind === 'mcp').length} selected · ${connectors.filter(healthy).length} connected · checked ${relTime(probe.probedAt)}`
                : 'Could not check'}
          </span>
          <button type="button" className="iconBtn" onClick={() => setNonce((n) => n + 1)} disabled={probe.phase === 'loading'} aria-label="Check again" title="Check again">
            <RefreshCw size={12} aria-hidden="true" className={probe.phase === 'loading' ? 'spin' : undefined} />
          </button>
        </div>

        {probe.phase === 'error' && <div className="tsEmpty">{probe.message}</div>}
        {probe.phase === 'ready' && probe.stale && (
          <div className="tsEmpty warnText">
            <AlertTriangle size={12} aria-hidden="true" /> The triage server is older than this page, so servers can’t be grouped. Restart it (e.g. <code>npm run dev</code>) to see every connection.
          </div>
        )}

        {probe.phase === 'ready' && connectors.length > 0 && (
          <Tabs.Root value={tab} onValueChange={(v) => setTab(v as TabId)} className="tsTabs">
            <div className="tsBar">
              <Tabs.List className="tsTabList" aria-label="Where servers come from">
                {visibleTabs.map((t) => (
                  <Tabs.Trigger key={t.id} value={t.id} className="tsTab">
                    {t.label}
                    <span className="n">{tabCount(t)}</span>
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              <label className="tsSearch">
                <Search size={12} aria-hidden="true" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search servers or tools" aria-label="Search servers or tools" />
              </label>
            </div>
          </Tabs.Root>
        )}

        <div className="tsScroll">
          {probe.phase === 'ready' && connectors.length === 0 && (
            <div className="tsEmpty">No MCP servers found. Connect one at claude.ai/settings/connectors, or add it to this project’s .mcp.json.</div>
          )}
          {probe.phase === 'ready' && connectors.length > 0 && empty && (
            <div className="tsEmpty">{q ? `Nothing matches “${query.trim()}”.` : 'No servers here.'}</div>
          )}

          {groups.map((g) => (
            <div key={g.scope} className="tsGroup">
              <div className="tsScope">{SCOPE_LABEL[g.scope]}</div>
              {g.items.map((c) => (
                <ServerRow
                  key={c.server}
                  connector={c}
                  grant={byKey.get(`mcp:${c.server}`)}
                  open={open.has(c.server)}
                  onOpenChange={(o) =>
                    setOpen((s) => {
                      const n = new Set(s)
                      if (o) n.add(c.server)
                      else n.delete(c.server)
                      return n
                    })
                  }
                  onToggle={() => toggleServer(c)}
                  onTools={(tools) => setServerTools(c, tools)}
                />
              ))}
            </div>
          ))}

          {elsewhere.length > 0 && (
            <Collapsible.Root open={showElsewhere || Boolean(q)} onOpenChange={setShowElsewhere} className="tsGroup">
              <Collapsible.Trigger asChild>
                <button type="button" className="tsScope tsMore">
                  <ChevronRight size={11} aria-hidden="true" className={showElsewhere || q ? 'rot' : undefined} />
                  {elsewhere.length} local in other folders · pick that folder’s project to use them
                </button>
              </Collapsible.Trigger>
              <Collapsible.Content>
                {elsewhere.map((e) => (
                  <div key={`${e.folder}:${e.name}`} className="tsRow off">
                    <div className="tsLine">
                      <span className="tsPick" aria-disabled="true">
                        <span className="box" />
                        <span className="name">{e.name}</span>
                      </span>
                      <span className="count" title={e.folder}>
                        {tilde(e.folder)}
                      </span>
                    </div>
                  </div>
                ))}
              </Collapsible.Content>
            </Collapsible.Root>
          )}

          {unavailable.length > 0 && (
            <Collapsible.Root open={showUnavailable || Boolean(q)} onOpenChange={setShowUnavailable} className="tsGroup">
              <Collapsible.Trigger asChild>
                <button type="button" className="tsScope tsMore">
                  <ChevronRight size={11} aria-hidden="true" className={showUnavailable || q ? 'rot' : undefined} />
                  {unavailable.length} not connected · {unavailable.every((c) => scopeOf(c) === 'claudeai') ? 'connect them at claude.ai/settings/connectors' : 'they need auth or failed to start'}
                </button>
              </Collapsible.Trigger>
              <Collapsible.Content>
                {unavailable.map((c) => (
                  <div key={c.server} className="tsRow off">
                    <div className="tsLine">
                      <span className="tsPick" aria-disabled="true">
                        <span className="box" />
                        <span className="name">{c.name}</span>
                      </span>
                      <span className="pill red" title={c.error}>
                        {c.status}
                      </span>
                    </div>
                  </div>
                ))}
              </Collapsible.Content>
            </Collapsible.Root>
          )}
        </div>

        {orphans.map((g) => {
          const Icon = grantIcon(g)
          const server = g.source.kind === 'mcp' ? g.source.server : ''
          return (
            <div key={server} className="tsRow orphan">
              <Icon size={13} aria-hidden="true" />
              <span className="name">{serverLabel(server)}</span>
              <span className="pill yellow">not found in this folder</span>
              <span className="count">{plural(g.tools.length, 'tool')} saved</span>
              <button type="button" className="btn ghost sm" onClick={() => onChange(value.filter((x) => x !== g))}>
                Remove
              </button>
            </div>
          )
        })}
      </div>
      <span className="hint">Only the checked tools exist for a run. Read-only labels are each server’s own claim.</span>
    </div>
  )
}

function ServerRow({
  connector: c,
  grant,
  open,
  onOpenChange,
  onToggle,
  onTools,
}: {
  connector: Connector
  grant: WatchToolGrant | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onToggle: () => void
  onTools: (tools: string[]) => void
}) {
  const ok = healthy(c)
  const on = Boolean(grant)
  const checked = new Set(grant?.tools ?? [])
  const Icon = grantIcon({ source: { kind: 'mcp', server: c.server, scope: c.scope }, tools: [] })
  const flip = (t: ConnectorTool) => {
    const next = new Set(checked)
    if (next.has(t.fullName)) next.delete(t.fullName)
    else next.add(t.fullName)
    onTools(c.tools.map((x) => x.fullName).filter((n) => next.has(n)))
  }

  return (
    <Collapsible.Root open={open && ok} onOpenChange={onOpenChange} className={`tsRow${on ? ' on' : ''}${ok ? '' : ' off'}`}>
      <div className="tsLine">
        <button type="button" className="tsPick" disabled={!ok} aria-pressed={on} onClick={onToggle} title={ok ? (on ? 'Remove this server' : 'Use this server') : c.error ?? c.status}>
          <span className="box">{on && <Check size={11} aria-hidden="true" />}</span>
          <Icon size={13} aria-hidden="true" />
          <span className="name">{c.name}</span>
        </button>
        {ok ? (
          <span className="count">{on ? `${checked.size} of ${plural(c.tools.length, 'tool')}` : plural(c.tools.length, 'tool')}</span>
        ) : (
          <span className="pill red" title={c.error}>
            {c.status}
          </span>
        )}
        {ok && c.tools.length > 0 && (
          <Collapsible.Trigger asChild>
            <button type="button" className="iconBtn tsExpand" aria-label={open ? 'Hide tools' : 'Show tools'}>
              <ChevronRight size={13} aria-hidden="true" className={open ? 'rot' : undefined} />
            </button>
          </Collapsible.Trigger>
        )}
      </div>
      <Collapsible.Content className="tsTools">
        {c.tools.map((t) => {
          const read = t.readOnly === true && t.destructive !== true
          return (
            <label key={t.fullName} className="tsTool" title={t.description}>
              <Checkbox.Root className="cbox" checked={checked.has(t.fullName)} onCheckedChange={() => flip(t)}>
                <Checkbox.Indicator>
                  <Check size={10} aria-hidden="true" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <span className="tname">{t.name}</span>
              {read ? (
                <span className="pill green">read</span>
              ) : t.destructive ? (
                <span className="pill red">destructive</span>
              ) : looksReadOnly(t.name) ? (
                <span className="pill mute">looks read-only</span>
              ) : (
                <span className="pill yellow">may write</span>
              )}
            </label>
          )
        })}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
