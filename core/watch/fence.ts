/**
 * The run fence (watch-spec.md, items 1 and 2): one decision per tool call,
 * wired in as a PreToolUse hook on every watch run. It is the real fence —
 * the allowlist keeps granted tools from prompting, this denies everything
 * else, including tools the user's own global allow rules would let through.
 * Server-only (node:path).
 */
import path from 'node:path'
import { hasBuiltin, runAllowedTools, type RunOutput, type WatchToolGrant } from './tools.js'

export type Fence = {
  /** exact tool names allowed (non-Bash, non-pattern) */
  exact: Set<string>
  /** allowed Bash command prefixes, e.g. "gh pr list" */
  bash: string[]
  /** file tools read here; always the project folder */
  root: string
  /** Write/Edit allowed (inside root) */
  write: boolean
}

export function fenceFor(grants: WatchToolGrant[], output: RunOutput, root: string): Fence {
  const exact = new Set<string>(['TodoWrite'])
  const bash: string[] = []
  for (const t of runAllowedTools(grants, output)) {
    const m = /^Bash\((.+):\*\)$/.exec(t)
    if (m) bash.push(m[1])
    else exact.add(t)
  }
  return { exact, bash, root: path.resolve(root), write: hasBuiltin(grants, 'files-write') }
}

export type FenceDecision = { allow: true } | { allow: false; reason: string }

const SHELL_META = /[;&|`$<>\n\r(){}\\]/

const inside = (root: string, p: string): boolean => {
  const abs = path.resolve(root, p)
  return abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/**
 * Decide one tool call. Deny anything outside the grants; fence file paths to
 * the project folder; allow Bash only for a granted command prefix with no
 * shell metacharacters (no chaining, redirects, or substitution).
 */
export function fenceDecision(f: Fence, toolName: string, input: unknown): FenceDecision {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof i[k] === 'string' ? (i[k] as string) : undefined)

  if (toolName === 'Bash') {
    const cmd = (str('command') ?? '').trim()
    if (!cmd) return { allow: false, reason: 'empty command' }
    if (SHELL_META.test(cmd)) return { allow: false, reason: 'watch runs may not chain, redirect, or substitute shell commands' }
    const ok = f.bash.some((p) => cmd === p || cmd.startsWith(p + ' '))
    return ok ? { allow: true } : { allow: false, reason: `this watch may only run: ${f.bash.join(', ') || 'no shell commands'}` }
  }

  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' || toolName === 'Write' || toolName === 'Edit') {
    if ((toolName === 'Write' || toolName === 'Edit') && !f.write) {
      return { allow: false, reason: 'this watch may not write files' }
    }
    if (!f.exact.has(toolName) && !(f.write && (toolName === 'Write' || toolName === 'Edit'))) {
      return { allow: false, reason: `${toolName} is not granted to this watch` }
    }
    const target = toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' ? str('file_path') : str('path')
    if (target !== undefined && !inside(f.root, target)) {
      return { allow: false, reason: `outside this watch's folder (${f.root})` }
    }
    if (toolName === 'Glob') {
      const pat = str('pattern') ?? ''
      if (path.isAbsolute(pat) && !inside(f.root, pat.replace(/[*?[{].*$/, ''))) {
        return { allow: false, reason: `outside this watch's folder (${f.root})` }
      }
    }
    return { allow: true }
  }

  if (f.exact.has(toolName)) return { allow: true }
  return { allow: false, reason: `${toolName} is not granted to this watch` }
}
