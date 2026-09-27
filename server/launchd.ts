/**
 * The macOS LaunchAgent that keeps triage running (watch-spec.md, item 3.7).
 * Watches only run while the server runs; a detached `triage start` dies on
 * reboot or crash. A user LaunchAgent with KeepAlive restarts it, and runs as
 * the user, so it can reach the login keychain where Claude's credentials live.
 * Ported from wakecron's launchd.ts. Shared by the CLI (install/uninstall/
 * start/stop) and the server (System status shows whether it is installed).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const LAUNCH_AGENT_LABEL = 'sh.usetriage.triage'
export const launchAgentPlist = (): string => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
const domain = (): string => `gui/${process.getuid?.() ?? 501}`
const service = (): string => `${domain()}/${LAUNCH_AGENT_LABEL}`

/** Installed = the plist exists. null off macOS, where there is no LaunchAgent. */
export function launchAgentInstalled(): boolean | null {
  if (process.platform !== 'darwin') return null
  return existsSync(launchAgentPlist())
}

/** Is the agent loaded into launchd right now? */
export async function launchAgentLoaded(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    await execFileP('launchctl', ['print', service()])
    return true
  } catch {
    return false
  }
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export type LaunchAgentSpec = {
  /** absolute node binary */
  node: string
  /** absolute path of the triage CLI script; the agent runs `<node> <script> serve` */
  script: string
  port: number
  logFile: string
  /** passed through to the server: PATH (so claude/gh/git resolve), HOME, TRIAGE_HOME… */
  env: Record<string, string>
}

export function plistFor(spec: LaunchAgentSpec): string {
  const env = { ...spec.env, PORT: String(spec.port) }
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(spec.node)}</string>
      <string>${xml(spec.script)}</string>
      <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(spec.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(spec.logFile)}</string>
  </dict>
</plist>
`
}

/** Write the plist and load it. Replaces an existing agent. */
export async function installLaunchAgent(spec: LaunchAgentSpec): Promise<void> {
  const file = launchAgentPlist()
  mkdirSync(path.dirname(file), { recursive: true })
  await execFileP('launchctl', ['bootout', service()]).catch(() => {})
  writeFileSync(file, plistFor(spec), { mode: 0o644 })
  await execFileP('launchctl', ['bootstrap', domain(), file])
}

/** Unload and delete the plist. */
export async function uninstallLaunchAgent(): Promise<boolean> {
  const file = launchAgentPlist()
  const had = existsSync(file)
  await execFileP('launchctl', ['bootout', service()]).catch(() => {})
  rmSync(file, { force: true })
  return had
}

/** Load an installed agent (after `triage stop` unloaded it). */
export async function loadLaunchAgent(): Promise<void> {
  if (await launchAgentLoaded()) return
  await execFileP('launchctl', ['bootstrap', domain(), launchAgentPlist()])
}

/** Unload without deleting: KeepAlive would otherwise restart a stopped server. */
export async function unloadLaunchAgent(): Promise<void> {
  await execFileP('launchctl', ['bootout', service()]).catch(() => {})
}

/** Restart the agent's process in place. */
export async function kickstartLaunchAgent(): Promise<void> {
  await execFileP('launchctl', ['kickstart', '-k', service()])
}
