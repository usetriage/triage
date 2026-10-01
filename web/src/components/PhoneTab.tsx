/**
 * Settings → Phone: let a phone on the same network use this triage.
 *
 * One switch, then a QR code. The code carries the pairing token
 * (server/remote.ts), so scanning it is the whole sign-in; the phone keeps a
 * cookie and comes straight in afterwards. Managed from the Mac only — a
 * paired phone sees that it is paired and nothing it could leak.
 */
import * as RadioGroup from '@radix-ui/react-radio-group'
import * as Switch from '@radix-ui/react-switch'
import { Globe, Wifi } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useState } from 'react'
import type { RemoteStatus } from '../../../shared/protocol.js'
import { Select, SelectItem } from '../ui/Select.js'
import { Snippet, Step } from './McpTab.js'

type Local = Extract<RemoteStatus, { local: true }>

const REACH = [
  { id: 'wifi', icon: Wifi, title: 'Same Wi-Fi', body: 'Phones on this Mac’s network. Nothing is exposed to the internet.' },
  { id: 'anywhere', icon: Globe, title: 'Anywhere', body: 'Wi-Fi or mobile data, through a public ngrok address. Only paired phones get in.' },
] as const

/** The QR code as an SVG path: one square per dark module, crisp at any size. */
function QrCode({ text }: { text: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
    return { n, d }
  }, [text])
  // Four modules of quiet zone, as the spec asks; the card is the white.
  return (
    <svg className="phoneQr" viewBox={`-4 -4 ${n + 8} ${n + 8}`} role="img" aria-label="QR code that pairs a phone with this triage" shapeRendering="crispEdges">
      <rect x={-4} y={-4} width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

export function PhoneTab() {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [host, setHost] = useState('')

  // Polled while access is on: a code is single use and short-lived, so the
  // one on screen has to follow the server's — used, expired, or burned.
  const enabled = status?.local === true && status.enabled
  const starting = status?.local === true && status.tunnel && status.tunnelStatus.state === 'starting'
  useEffect(() => {
    const load = () =>
      void fetch('/api/remote')
        .then((r) => r.json() as Promise<RemoteStatus>)
        .then(setStatus)
        .catch((e) => setError(String(e)))
    load()
    if (!enabled) return
    // Every second while ngrok comes up, so its address lands as soon as it exists.
    const t = setInterval(load, starting ? 1000 : 4000)
    return () => clearInterval(t)
  }, [enabled, starting])

  const post = async (body: { enabled?: boolean; rotate?: boolean; newCode?: boolean; tunnel?: boolean }) => {
    setBusy(true)
    setError('')
    try {
      const r = await fetch('/api/remote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      setStatus((await r.json()) as RemoteStatus)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return error ? <div className="msg error">{error}</div> : <div className="pickerLoading">Loading…</div>
  }

  if (!status.local) {
    return (
      <section className="setSection">
        <h3>This device is paired</h3>
        <p className="hint">
          You are using the triage that runs on your Mac. Phone access — switching it off, or resetting the pairing code to sign
          every device out — is managed from the Mac itself.
        </p>
      </section>
    )
  }

  return (
    <>
      <section className="setSection">
        <h3>Phone access</h3>
        <p className="hint">
          Use triage from a phone or tablet. Devices get in only by pairing with this Mac, and switching this off cuts every
          device at once.
        </p>
        <div className="setRow">
          <div className="lbl">
            <b>Allow other devices</b>
            <small>Off: triage only answers this Mac, as it always has.</small>
          </div>
          <div className="ctl">
            <Switch.Root
              className="uiSwitch"
              checked={status.enabled}
              disabled={busy}
              onCheckedChange={(on) => void post({ enabled: on })}
              aria-label="Allow other devices"
            >
              <Switch.Thumb className="uiSwitchThumb" />
            </Switch.Root>
          </div>
        </div>
        {status.enabled && (
          <div className="reachPick">
            <span className="reachLbl" id="reach-label">
              Where you’ll use it from
            </span>
            <RadioGroup.Root
              className="reachCards"
              aria-labelledby="reach-label"
              value={status.tunnel ? 'anywhere' : 'wifi'}
              disabled={busy}
              onValueChange={(v) => void post({ tunnel: v === 'anywhere' })}
            >
              {REACH.map(({ id, icon: Icon, title, body }) => (
                <RadioGroup.Item key={id} value={id} className="reachCard">
                  <span className="reachHead">
                    <span className="reachDot" aria-hidden="true">
                      <RadioGroup.Indicator className="reachDotOn" />
                    </span>
                    <Icon size={15} aria-hidden="true" />
                    {title}
                  </span>
                  <span className="reachBody">{body}</span>
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
          </div>
        )}
        {status.enabled && status.tunnel && <TunnelLine status={status.tunnelStatus} onRetry={() => void post({ tunnel: true })} />}
        {error && <div className="msg error">{error}</div>}
      </section>

      {status.enabled && <PairSection status={status} host={host} onHost={setHost} onNewCode={() => void post({ newCode: true })} />}

      {status.enabled && (
        <section className="setSection">
          <h3>Paired devices</h3>
          <p className="hint">
            Lost a phone? This signs every paired device out and makes a new QR code; pair again on the ones you keep.
          </p>
          <div className="setActions">
            <button type="button" className="btn" disabled={busy} onClick={() => void post({ rotate: true })}>
              Sign out all devices
            </button>
          </div>
        </section>
      )}
    </>
  )
}

function PairSection({
  status,
  host,
  onHost,
  onNewCode,
}: {
  status: Local
  host: string
  onHost: (h: string) => void
  onNewCode: () => void
}) {
  // The page's own port: in dev that is Vite's, which proxies on to the daemon.
  const port = location.port ? `:${location.port}` : ''
  const hosts = [...status.addresses.map((a) => a.address), ...(status.hostname ? [status.hostname] : [])]
  const chosen = hosts.includes(host) ? host : hosts[0]
  if (!chosen) {
    return (
      <section className="setSection">
        <h3>Pair a device</h3>
        <div className="msg error">This Mac is not on a network right now — join Wi-Fi, then reopen this tab.</div>
      </section>
    )
  }
  const base = `${location.protocol}//${chosen}${port}`
  const pairUrl = `${base}/api/pair?token=${encodeURIComponent(status.token)}`
  // Anywhere: the same pairing link, on the tunnel's address. No address
  // picker and no typed code — over the internet only the QR code pairs.
  const ts = status.tunnelStatus
  if (status.tunnel) {
    if (ts.state !== 'up') return null
    return (
      <section className="setSection">
        <h3>Pair a device</h3>
        <p className="hint">Scan with the phone’s camera — on Wi-Fi or mobile data, anywhere.</p>
        <div className="phonePair">
          <div className="phoneQrCard">
            <QrCode text={`${ts.url}/api/pair?token=${encodeURIComponent(status.token)}`} />
          </div>
          <div className="phoneSteps">
            <Step n={1}>
              Point the camera at the code and open the link. ngrok shows a one-time warning page first — tap <b>Visit Site</b>.
            </Step>
            <Step n={2}>
              Share → <b>Add to Home Screen</b> to open triage like an app.
            </Step>
            <Step n={3}>
              Keep this Mac awake: while it sleeps, the address stops answering.
            </Step>
          </div>
        </div>
      </section>
    )
  }
  return (
    <section className="setSection">
      <h3>Pair a device</h3>
      <p className="hint">Scan with the phone’s camera. The phone must be on the same Wi-Fi as this Mac.</p>
      <div className="phonePair">
        <div className="phoneQrCard">
          <QrCode text={pairUrl} />
        </div>
        <div className="phoneSteps">
          <Step n={1}>
            Point the camera at the code and open the link. The phone is paired from then on — no code to type.
          </Step>
          <Step n={2}>
            Share → <b>Add to Home Screen</b> to open triage like an app.
          </Step>
          <Step n={3}>
            Nothing loads? Check that the phone is on the same network, and that macOS Firewall lets <b>node</b> accept incoming
            connections.
          </Step>
        </div>
      </div>
      {hosts.length > 1 && (
        <div className="setRow">
          <div className="lbl">
            <b>Address</b>
            <small>The <code>.local</code> name survives your router handing this Mac a new IP; some Android phones cannot resolve it.</small>
          </div>
          <div className="ctl">
            <Select className="setSelect" value={chosen} onValueChange={onHost} aria-label="Address the phone connects to">
              {hosts.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </Select>
          </div>
        </div>
      )}
      {import.meta.env.DEV && (
        <p className="hint">
          Dev server: Vite answers the network only when started as <code>TRIAGE_DEV_LAN=1 npm run dev</code>.
        </p>
      )}
      <Snippet label="open on the phone" text={base} />
      {status.code && <PairCodeBlock code={status.code} onNew={onNewCode} />}
    </section>
  )
}

/** The typeable alternative to the QR code: six digits, grouped for reading aloud, with how long they last. */
function PairCodeBlock({ code, onNew }: { code: { digits: string; expiresAt: number }; onNew: () => void }) {
  const mins = Math.max(1, Math.ceil((code.expiresAt - Date.now()) / 60_000))
  return (
    <div className="phoneCode">
      <span className="cap">or type this code on the phone</span>
      <div className="row">
        <span className="digits" aria-label={`Pairing code ${code.digits.split('').join(' ')}`}>
          {code.digits.slice(0, 3)}
          <span className="gap" aria-hidden="true" />
          {code.digits.slice(3)}
        </span>
        <button type="button" className="btn sm ghost" onClick={onNew}>
          New code
        </button>
      </div>
      <span className="note">Works once · expires in {mins} min · five wrong tries and it is replaced</span>
    </div>
  )
}

/** Where the ngrok tunnel is: coming up, live, or why it is not. */
function TunnelLine({ status, onRetry }: { status: Local['tunnelStatus']; onRetry: () => void }) {
  if (status.state === 'starting')
    return (
      <p className="tunnelLine">
        <span className="dot live" aria-hidden="true" /> Starting ngrok — your public address appears here in a moment…
      </p>
    )
  if (status.state === 'up')
    return (
      <div className="tunnelUp">
        <p className="tunnelLine">
          <span className="dot green" aria-hidden="true" /> Live — this address leads to this Mac from anywhere:
        </p>
        <Snippet label="public address" text={status.url} />
      </div>
    )
  if (status.state === 'error')
    return (
      <div className="msg error">
        {status.error}{' '}
        <button type="button" className="tlink" onClick={onRetry}>
          Try again
        </button>
      </div>
    )
  return null
}
