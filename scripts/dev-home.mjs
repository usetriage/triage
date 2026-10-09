// Dev keeps its data apart from prod's ~/.triage: migrations, watch schedulers,
// server.json, phone pairing and logs all live under TRIAGE_HOME. An explicit
// TRIAGE_HOME (e.g. `TRIAGE_HOME=~/.triage npm run dev`) wins unchanged.
//
// Imported by scripts/dev.mjs, and preloaded (`tsx --import`) by `dev:server`
// so the value is set before server/state.ts reads it.
import os from 'node:os'
import path from 'node:path'

export const DEV_HOME = path.join(os.homedir(), '.triage-dev')

export function applyDevHome(env = process.env) {
  env.TRIAGE_HOME ||= DEV_HOME
  return env.TRIAGE_HOME
}

applyDevHome()
