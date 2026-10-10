# Triage.app — architecture

A native macOS window over the local triage daemon. Electron, because the
server is Node: nothing in `server/` or `core/` is ported.

## Decisions

- **The app attaches, it does not own.** The daemon (`server/index.ts`) keeps
  running when the app quits — live Claude sessions and watches must survive
  closing a window. The app finds a running triage via `GET /api/health`
  (`{ app: 'triage', … }`) and loads it in a `BrowserWindow`.
- **If nothing is running, the app starts the bundled daemon**, detached, using
  the same path `triage start` uses: `<bundled node> <bundled cli.js> start`.
  If the user's LaunchAgent (`~/Library/LaunchAgents/sh.usetriage.triage.plist`)
  is installed, `cli.js start` loads it instead — the CLI already handles that.
- **Bundled runtime = an official Node binary**, not Electron-as-node. The
  server needs `node:sqlite` (Node ≥ 22.5) and the Agent SDK spawns `node` for
  Claude Code; node-pty is N-API so it works unchanged. Layout inside the app:

  ```
  Triage.app/Contents/Resources/
    node/bin/node                   official Node 22 LTS for the target arch
    triage/                         the usetriage package: dist/, package.json,
      dist/server/cli.js            production node_modules (npm ci --omit=dev)
      node_modules/…
  ```

  In dev (`npm start` in `desktop/`, unpackaged) the runtime falls back to the
  system `node` and the repo root (`../dist/server/cli.js`, after `npm run build`).
- **PATH comes from the login shell.** A Finder-launched app gets
  `/usr/bin:/bin:/usr/sbin:/sbin`; `claude`, `gh`, `git` would not resolve.
  The app reads `$SHELL -ilc 'printf %s "$PATH"'` once (5 s timeout, falls back
  to Homebrew + `~/.local/bin` defaults) and prepends the bundled `node/bin`.
- **Port** = `TRIAGE_APP_PORT` env, else `5178` (`DEFAULT_PORT` in
  `server/state.ts`). `TRIAGE_HOME` passes through unchanged. These exist so
  the app can be tested against an isolated daemon without touching prod.
- **URL** = `http://localhost:<port>/`. Loopback socket + loopback `Host`
  counts as "local" in `server/remote.ts`, so no pairing.
- **Distribution without an Apple Developer ID**: ad-hoc signed
  (`codesign --force --deep -s -`), shipped as a zip on the GitHub release,
  installed by `curl -fsSL https://usetriage.sh/install.sh | sh` (curl sets no
  quarantine xattr; the script strips it anyway). Homebrew is not an escape
  hatch — unsigned casks are gone from the official tap.

## Files

| file | owns |
|---|---|
| `src/daemon.ts` | find / start / restart the daemon, login-shell PATH, bundled runtime paths |
| `src/main.ts` | app lifecycle, single instance, window, menu, tray, external links, window state |
| `src/preload.cjs` | tiny preload (CommonJS): exposes `window.triageDesktop` |
| `src/splash.html` | the "starting triage…" / error page shown before the daemon answers |
| `scripts/build.mjs` | root build → stage server → fetch Node → electron-builder → ad-hoc sign → zip/dmg |
| `scripts/icon.mjs` | `build/icon.icns` from `web/public/icon-1024.png` |
| `electron-builder.yml` | packaging config |
| `../install.sh` | the `curl \| sh` installer |
| `../.github/workflows/desktop.yml` | CI build of the app on a release tag |

## `src/daemon.ts` contract (consumed by `main.ts`)

```ts
export type DaemonHealth = { app: 'triage'; version: string; pid: number; port: number; db: string; liveSessions: number }
export const PORT: number                                   // TRIAGE_APP_PORT ?? 5178
export function daemonUrl(): string                         // http://localhost:PORT/
export async function probe(): Promise<DaemonHealth | 'other' | null>   // null = nothing listening
export async function ensureDaemon(onStatus?: (msg: string) => void): Promise<DaemonHealth>
  // probe → if triage, return; if 'other', throw a readable Error; else start the
  // bundled daemon via `cli.js start` and poll health up to 20 s; throws with the
  // last 20 lines of the log on failure.
export async function restartDaemon(): Promise<DaemonHealth>   // `cli.js restart`, then poll
export function runtime(): { node: string; cli: string; bundled: boolean }
export async function loginShellEnv(): Promise<NodeJS.ProcessEnv>  // cached
export function logFile(): string                            // $TRIAGE_HOME/server.log or ~/.triage/server.log
```
