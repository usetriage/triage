/**
 * The system sheet — anchored top-right under the gauge icon. An icon rail of
 * three views (status · activity · logs) beside the body, the way the design's
 * "Usage & providers" sheet is laid out.
 */
import { Activity, Gauge, RefreshCw, ScrollText } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActivityResponse,
  ActivityRun,
  LogEntry,
  LogLevel,
  LogsResponse,
  SystemResponse,
  SystemStatus,
} from '../../../shared/protocol.js'
import type { ConnState } from '../store.js'
import { Select, SelectItem } from '../ui/Select.js'

function rel(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function uptime(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

export type SystemTab = 'status' | 'activity' | 'logs'

const TABS: Array<{ id: SystemTab; label: string; icon: typeof Gauge }> = [
  { id: 'status', label: 'Status', icon: Gauge },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'logs', label: 'Logs', icon: ScrollText },
]

export function SystemModal({
  open,
  initialTab = 'status',
  conn,
  onClose,
}: {
  open: boolean
  initialTab?: SystemTab
  conn: ConnState
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<SystemTab>(initialTab)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      el.showModal()
      setTab(initialTab)
    }
    if (!open && el.open) el.close()
  }, [open, initialTab])

  const title = TABS.find((t) => t.id === tab)?.label ?? ''

  return (
    <dialog ref={dialog} className="sheet" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <div className="sheetRail" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            title={label}
            className={`sheetTab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={15} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="sheetBody">
        <div className="sheetHead">
          <span className="title">{title}</span>
          <span className="sub">{tab === 'status' ? 'the daemon and its sources' : tab === 'activity' ? 'recent watch runs' : 'daemon log'}</span>
          <span className="right">
            <button type="button" className="iconBtn" title="Refresh" onClick={() => setNonce((n) => n + 1)}>
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          </span>
        </div>
        {open && tab === 'status' && <StatusTab key={nonce} conn={conn} />}
        {open && tab === 'activity' && <ActivityTab key={nonce} />}
        {open && tab === 'logs' && <LogsTab key={nonce} />}
      </div>
    </dialog>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' | 'dim' }) {
  return (
    <div className="sysRow">
      <span className="sysLabel">{label}</span>
      <span className={`sysValue${tone ? ' ' + tone : ''}`} title={value}>
        {value}
      </span>
    </div>
  )
}

function StatusTab({ conn }: { conn: ConnState }) {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    void fetch('/api/system')
      .then((r) => r.json() as Promise<SystemResponse>)
      .then((b) => (b.ok ? setStatus(b.status) : setError(b.error)))
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  if (error) return <div className="msg error">{error}</div>
  if (!status) return <div className="pickerLoading">Loading…</div>

  const slack =
    status.slackConnected === true
      ? ['connected', 'ok']
      : status.slackConnected === false
        ? ['disconnected', 'bad']
        : ['probing…', 'dim']
  return (
    <div className="card soft sysCard">
      <div className="sysHead">
        <span className={`dot lg ${conn === 'connected' ? 'green' : 'red'}`} />
        <span>{conn === 'connected' ? 'Daemon running' : 'Reconnecting…'}</span>
        <span className="sysSub">
          v{status.version} · up {uptime(status.uptimeMs)}
        </span>
      </div>
      <Row label="Port" value={String(status.port)} tone="dim" />
      <Row label="Database" value={status.db} tone="dim" />
      <Row label="Live sessions" value={String(status.liveSessions)} />
      <Row label="Slack connector" value={slack[0]} tone={slack[1] as 'ok' | 'bad' | 'dim'} />
      <Row
        label="Connectors"
        value={status.connectorCount == null ? 'probing…' : `${status.connectorCount} · ${rel(status.connectorsProbedAt)}`}
        tone="dim"
      />
      <Row label="Scheduler last tick" value={rel(status.schedulerLastTickAt)} tone={status.schedulerLastTickAt ? 'ok' : 'warn'} />
      <Row label="Watch runs in flight" value={String(status.runningWatches)} />
      <Row label="Inbox last synced" value={rel(status.inboxSyncedAt)} />
      <Row
        label="GitHub last reconcile"
        value={status.githubNotice ? status.githubNotice : rel(status.githubReconcileAt)}
        tone={status.githubNotice ? 'bad' : 'dim'}
      />
      <Row
        label="Watches"
        value={`${status.watches.enabled}/${status.watches.total} enabled${status.watches.failing ? ` · ${status.watches.failing} failing` : ''}${status.watches.overdue ? ` · ${status.watches.overdue} overdue` : ''}`}
        tone={status.watches.failing ? 'bad' : status.watches.overdue ? 'warn' : 'ok'}
      />
      <Row label="Logs" value={status.logDir ?? 'in-memory only'} tone="dim" />
    </div>
  )
}

export function ActivityTab() {
  const [runs, setRuns] = useState<ActivityRun[] | null>(null)
  useEffect(() => {
    void fetch('/api/activity')
      .then((r) => r.json() as Promise<ActivityResponse>)
      .then((b) => setRuns(b.ok ? b.runs.slice(0, 30) : []))
      .catch(() => setRuns([]))
  }, [])
  if (!runs) return <div className="pickerLoading">Loading…</div>
  if (runs.length === 0) return <div className="pickerLoading">No runs yet.</div>
  return (
    <div>
      {runs.map((r) => {
        const st = r.status ?? 'running'
        return (
          <div key={r.sessionId} className="sysRunRow">
            <span className={`runStatus ${st}`}>{st}</span>
            <span className="sysRunTitle">{r.watchTitle}</span>
            <span className="sysRunMeta">
              {rel(r.startedAt)}
              {r.status === 'ok' && ` · ${r.matches ?? 0} filed`}
              {r.error && ` · ${r.error}`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

const LEVELS: (LogLevel | 'all')[] = ['all', 'info', 'warn', 'error']

export function LogsTab() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null)
  const [subsystems, setSubsystems] = useState<string[]>([])
  const [level, setLevel] = useState<LogLevel | 'all'>('all')
  const [subsystem, setSubsystem] = useState('all')
  const [q, setQ] = useState('')

  const load = useCallback(() => {
    const p = new URLSearchParams()
    if (level !== 'all') p.set('level', level)
    if (subsystem !== 'all') p.set('subsystem', subsystem)
    if (q.trim()) p.set('q', q.trim())
    void fetch(`/api/logs?${p.toString()}`)
      .then((r) => r.json() as Promise<LogsResponse>)
      .then((b) => {
        if (b.ok) {
          setEntries(b.entries)
          setSubsystems(b.subsystems)
        }
      })
      .catch(() => setEntries([]))
  }, [level, subsystem, q])

  useEffect(() => {
    load()
    const t = setInterval(load, 5_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="sysBody logs">
      <div className="logFilters">
        <div className="logTabs">
          {LEVELS.map((l) => (
            <button key={l} type="button" className={`logTab${level === l ? ' active' : ''}`} onClick={() => setLevel(l)}>
              {l}
            </button>
          ))}
        </div>
        <Select
          className="logSelect"
          aria-label="Subsystem"
          value={subsystem}
          onValueChange={setSubsystem}
        >
          <SelectItem value="all">all subsystems</SelectItem>
          {subsystems.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </Select>
        <input className="logFilterInput" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="logLines">
        {entries === null ? (
          <div className="pickerLoading">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="pickerLoading">No log lines.</div>
        ) : (
          entries.map((e) => (
            <div key={e.seq} className={`logLine ${e.level}`} title={e.fields ? JSON.stringify(e.fields, null, 2) : undefined}>
              <span className="logTime">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={`logLevel ${e.level}`}>{e.level}</span>
              <span className="logSub">{e.subsystem}</span>
              <span className="logMsg">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
