// Runs the two dev processes as one command: the node server (API + WebSocket,
// :5188) and the Vite dev server (:5189, proxying /ws and /api back to it).
//
// Deliberately not `tsx watch` for the server — a restart drops every live
// Claude subprocess. Restart it by hand when you change server code.
import { spawn } from 'node:child_process'
import './dev-home.mjs' // TRIAGE_HOME → ~/.triage-dev unless already set

process.env.PORT ||= '5188'

const procs = [
  { name: 'server', color: '\x1b[33m', cmd: 'tsx', args: ['server/index.ts'] },
  { name: 'web   ', color: '\x1b[36m', cmd: 'vite', args: [] },
].map(({ name, color, cmd, args }) => {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: process.platform === 'win32',
  })
  const prefix = `${color}[${name}]\x1b[0m `
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) console.log(prefix + line)
    })
  }
  child.on('exit', (code) => {
    console.log(`${prefix}exited (${code})`)
    shutdown(code ?? 0)
  })
  return child
})

let shuttingDown = false
function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const p of procs) p.kill('SIGTERM')
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
