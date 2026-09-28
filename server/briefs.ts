/**
 * Briefs (.docs/next-version.md, phase 2) — the parts with no runtime state:
 * playbooks and dispatch templates as files, the headless contract a brief
 * session runs under, and the prompt that carries the variable material.
 *
 *   ~/.triage/workspaces/<id>/playbooks/<ItemKind>.md   how to brief this kind
 *   ~/.triage/workspaces/<id>/dispatch/<ItemKind>.md    how a dispatched session opens
 *
 * Both are seeded with defaults on boot and never overwritten once present —
 * they are the user's to edit, like a skill. These two files are the only
 * places the pipeline is customisable in prose; everything else is code.
 *
 * The queue, the runner and the routes live in server/index.ts beside the
 * watch runs; this module is imported by it and imports nothing from it.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ItemKind, WorkItem } from '../core/work/types.js'
import { BASE } from '../core/work/score.js'

export const PLAYBOOK_KINDS = Object.keys(BASE) as ItemKind[]

const KIND_RE = /^[a-z][a-z0-9-]{0,40}$/
export const isPlaybookName = (v: unknown): v is string => typeof v === 'string' && KIND_RE.test(v)

// ---------------------------------------------------------------------------
// Playbook defaults — suggested headings per kind, not a schema. The body is
// free markdown; the model may add or drop sections.
// ---------------------------------------------------------------------------

const COMMON_TAIL = `
Write for the person who will act on this in the next ten minutes: lead with the verdict or the
one thing they must decide, keep it under ~600 words, and put anything you could not verify under
**Open questions** rather than guessing. Use the work item's own words for names and identifiers.`

const PLAYBOOK_DEFAULTS: Record<string, string> = {
  'review-requested': `# Review request → risk brief

Read the pull request (\`gh pr view\`, \`gh pr diff\`, \`gh pr checks\`, and the comments). Do NOT post a review.

Suggested sections:
- **Verdict** — safe to merge / needs changes / needs a human look, in one line, and why.
- **What it changes** — two or three sentences a reviewer can repeat in standup.
- **Risky hunks** — the specific files and lines that deserve eyes, each with the concern.
- **Blast radius** — who and what this touches beyond the diff (callers, migrations, config, users).
- **CI and bots** — what the checks and any bot comments flagged, and whether it matters.
- **How to verify** — the shortest manual check that would catch a regression.
- **Open questions**
${COMMON_TAIL}`,

  'reply-needed': `# Someone is waiting on your reply

Read the thread in full and everything it links to. Do NOT post anything.

Suggested sections:
- **What they need** — the actual ask, in one line.
- **Context you'd want** — the facts from the thread and the code that decide the answer.
- **Suggested reply** — a draft in the user's voice, ready to paste, marked as a draft.
- **If you can't answer yet** — what you'd need to find out, and where.
- **Open questions**
${COMMON_TAIL}`,

  'slack-reply-pending': `# A Slack thread awaits your reply

Read the thread and anything it references (PRs, tickets, docs). Do NOT post to Slack.

Suggested sections:
- **What happened** — the thread in three sentences.
- **What they need from you** — the ask, and by when if stated.
- **Suggested reply** — a draft in the user's voice, ready to paste.
- **Related** — PRs, tickets or code that bear on the answer.
- **Open questions**
${COMMON_TAIL}`,

  'slack-mention': `# You were mentioned in Slack

Read the thread and anything it references. Do NOT post to Slack.

Suggested sections:
- **Why you were pulled in** — one line.
- **What's being asked or decided**
- **Your likely position** — grounded in the code or history, with the evidence.
- **Suggested reply** — a short draft, ready to paste.
- **Open questions**
${COMMON_TAIL}`,

  mention: `# You were mentioned

Read the thread or issue in full (\`gh\` for GitHub). Do NOT post anything.

Suggested sections:
- **Why you were pulled in**
- **What's being asked**
- **What you know** — from the code and the history, with pointers.
- **Suggested reply** — a draft, ready to paste.
- **Open questions**
${COMMON_TAIL}`,

  'own-pr-approved': `# Your PR is approved

Check what stands between it and merged (\`gh pr view\`, \`gh pr checks\`). Do NOT merge or push.

Suggested sections:
- **Ready to merge?** — yes / not yet, and the blocker if any (checks, conflicts, branch protection).
- **Last look** — anything in the final diff worth a second glance before merging.
- **After merge** — follow-ups the PR itself mentions (docs, flags, announcements).
${COMMON_TAIL}`,

  'own-pr-conflicting': `# Your PR has conflicts

Inspect the conflict (\`gh pr view\`, \`git\` read commands). Do NOT rebase, push or edit files.

Suggested sections:
- **What conflicts** — files and the competing changes, in plain words.
- **Resolution plan** — the order to resolve in and what to keep from each side.
- **Risk** — whether the conflict hints at a design collision, not just overlapping lines.
${COMMON_TAIL}`,

  'own-pr-stale': `# Your PR has gone quiet

Find out why nothing is moving (\`gh pr view\`, comments, checks, reviewers). Do NOT post.

Suggested sections:
- **Where it's stuck** — waiting on whom, for what.
- **What would unstick it** — the concrete next move (ping, split, rebase, close).
- **Suggested message** — if a nudge is the move, a one-line draft.
${COMMON_TAIL}`,

  'own-pr-open': `# Your open PR

Summarise where it stands (\`gh pr view\`, \`gh pr checks\`). Do NOT post.

Suggested sections:
- **State** — reviews, checks, size, age.
- **Next step** — the one thing that moves it.
${COMMON_TAIL}`,

  'ticket-assigned': `# A ticket assigned to you

Read the ticket and find the relevant code. Do NOT change anything.

Suggested sections:
- **What's broken or wanted** — restated precisely.
- **Repro or evidence** — steps you could reproduce it with, or why you couldn't.
- **Where in the code** — files and functions involved, with a line on each.
- **Plan** — the steps you'd take, in order, with a rough size.
- **Open questions**
${COMMON_TAIL}`,

  'watch-hit': `# A watch matched this

Read the matched content and what it references. Do NOT post or change anything.

Suggested sections:
- **What this is** — in two sentences.
- **Why it matters to the user** — or whether it does.
- **Suggested action** — read / reply (with a draft) / work it (with a plan) / dismiss.
- **Open questions**
${COMMON_TAIL}`,

  manual: `# A to-do the user added

Work out what it means and what it would take, in this codebase. Do NOT change anything.

Suggested sections:
- **What this means** — restated precisely; name the design, doc or thread it refers to if you can find it.
- **Concerned code** — the files and functions involved, one line each on what they do today.
- **Approach** — the steps, in the order you'd do them.
- **Open questions** — what only the user can answer; keep these sharp, they'll answer inline.
- **Effort** — one line.
${COMMON_TAIL}`,

  fyi: `# For your information

Read it and say whether it needs anything. Do NOT post.

Suggested sections:
- **Summary** — three sentences.
- **Does this need you?** — yes / no, and why.
- **If yes** — the smallest useful action.
${COMMON_TAIL}`,
}

const GENERIC_PLAYBOOK = `# Brief

Read everything the work item points at. Do NOT change or post anything.

Suggested sections:
- **What this is**
- **What it needs from the user**
- **Suggested next step**
- **Open questions**
${COMMON_TAIL}`

export const defaultPlaybook = (kind: string): string => PLAYBOOK_DEFAULTS[kind] ?? GENERIC_PLAYBOOK

/** Write any missing default; never touch a file that exists. */
export async function seedPlaybooks(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const kind of PLAYBOOK_KINDS) {
    const file = path.join(dir, `${kind}.md`)
    if (!existsSync(file)) await writeFile(file, defaultPlaybook(kind), 'utf8')
  }
}

export async function readPlaybook(dir: string, kind: string): Promise<{ body: string; custom: boolean; path: string }> {
  if (!isPlaybookName(kind)) throw new Error('not a playbook name')
  const file = path.join(dir, `${kind}.md`)
  try {
    const body = await readFile(file, 'utf8')
    return { body, custom: body !== defaultPlaybook(kind), path: file }
  } catch {
    return { body: defaultPlaybook(kind), custom: false, path: file }
  }
}

export async function writePlaybook(dir: string, kind: string, body: string): Promise<void> {
  if (!isPlaybookName(kind)) throw new Error('not a playbook name')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${kind}.md`), body, 'utf8')
}

export async function listPlaybooks(dir: string): Promise<{ kind: string; custom: boolean; path: string }[]> {
  const kinds = new Set<string>(PLAYBOOK_KINDS)
  try {
    for (const f of await readdir(dir)) if (f.endsWith('.md')) kinds.add(f.slice(0, -3))
  } catch {
    // not seeded yet
  }
  const out: { kind: string; custom: boolean; path: string }[] = []
  for (const kind of [...kinds].filter(isPlaybookName).sort()) {
    const p = await readPlaybook(dir, kind)
    out.push({ kind, custom: p.custom, path: p.path })
  }
  return out
}

// ---------------------------------------------------------------------------
// The headless contract — appended to Claude Code's own system prompt for every
// brief session, so it survives `resume` and every iteration runs under it.
// ---------------------------------------------------------------------------

export const BRIEF_SYSTEM_APPEND = `
You are running headless inside triage to write a BRIEF about one work item. Nobody is watching this
session and nobody can answer a question, so never ask one — decide, and record the assumption under
"Open questions". Read whatever you need: files, \`gh\` and \`git\` read-only commands, connectors. Make
NO changes anywhere: do not edit or create files, do not push, comment, post, send, or resolve anything.
When you are done, call the \`write_brief\` tool exactly once with the complete brief — a short title and
the full markdown body. That tool call is the only output that is kept; text you reply with is not
saved. If a brief already exists for this item, rewrite it whole; do not append to it.`

export type BriefPromptInput = {
  item: WorkItem
  /** the ranked reason, when the item is in the open inbox */
  reason?: string
  playbookName: string
  playbook: string
  /** the user's context note from the Create-brief modal, or their feedback on iteration */
  note?: string | null
  /** the brief that exists now (a re-run or an iteration rewrites it) */
  existing?: string | null
  /** true when this message continues the session that wrote `existing` */
  iteration: boolean
  /** screenshots attached to the item, carried as image blocks on this message */
  imageCount?: number
}

/** The first user message of a brief run: the variable material, in one message. */
export function composeBriefPrompt(input: BriefPromptInput): string {
  const { item } = input
  const itemLines = [
    `id: ${item.id}`,
    `title: ${item.title}`,
    `kind: ${item.kind} (${item.source})`,
    item.url && `url: ${item.url}`,
    item.repo && `where: ${item.repo}`,
    item.author && `author: ${item.author}`,
    `last activity: ${item.updatedAt}`,
    input.reason && `rank: ${input.reason}`,
    item.why && `why it surfaced: ${item.why}`,
    item.urls?.length ? `links: ${item.urls.join(', ')}` : undefined,
    item.refs?.length ? `refs: ${item.refs.join(', ')}` : undefined,
  ].filter((l): l is string => typeof l === 'string' && l.length > 0)

  const parts: string[] = []
  if (input.iteration) {
    parts.push(
      `The user has read the brief you wrote for this work item and has feedback. Take it into account, re-read whatever you need, and call \`write_brief\` again with the whole brief rewritten (not appended).`,
    )
    if (input.note) parts.push(`# Feedback from the user\n\n${input.note.trim()}`)
  } else {
    parts.push(`Write the brief for this work item by following the playbook below, then call \`write_brief\` once.`)
    parts.push(`# Playbook: ${input.playbookName}\n\n${input.playbook.trim()}`)
  }
  parts.push(`# Work item\n\n${itemLines.join('\n')}`)
  if (item.description) parts.push(`# Description (the user's own words)\n\n${item.description.trim()}`)
  if (input.imageCount)
    parts.push(
      `# Screenshots\n\n${input.imageCount} image${input.imageCount === 1 ? ' is' : 's are'} attached to this message — the user put ${input.imageCount === 1 ? 'it' : 'them'} on the work item as context. Read ${input.imageCount === 1 ? 'it' : 'them'} before you start.`,
    )
  if (!input.iteration && input.note) parts.push(`# The user's note for this brief\n\n${input.note.trim()}`)
  if (input.existing) parts.push(`# The current brief (rewrite it whole)\n\n${input.existing.trim()}`)
  return parts.join('\n\n')
}

/** One brief file per item: `briefs/github-owner-repo-123.md`. */
export const briefRelPath = (itemId: string): string =>
  `briefs/${itemId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item'}.md`

// ---------------------------------------------------------------------------
// Dispatch templates — how a dispatched session opens, per kind. A tiny
// mustache subset: {{var}}, {{#var}}…{{/var}} (when set), {{^var}}…{{/var}} (when not).
// ---------------------------------------------------------------------------

export const DEFAULT_DISPATCH_TEMPLATE = `Work item from the triage inbox — {{kind}}:
{{title}}
{{#url}}{{url}}
{{/url}}{{#description}}Description: {{description}}
{{/description}}{{#reason}}Why it ranked: {{reason}}
{{/reason}}{{#note}}Note: {{note}}
{{/note}}
{{#brief}}A brief for this item is attached — read it first, then get started.{{/brief}}{{^brief}}{{#source}}Use \`gh\` (or the relevant connector) to pull the full context and get started.{{/source}}{{^source}}Get started.{{/source}}{{/brief}}`

export async function seedDispatchTemplates(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const kind of PLAYBOOK_KINDS) {
    const file = path.join(dir, `${kind}.md`)
    if (!existsSync(file)) await writeFile(file, DEFAULT_DISPATCH_TEMPLATE, 'utf8')
  }
}

export async function readDispatchTemplate(dir: string, kind: string): Promise<string> {
  if (!isPlaybookName(kind)) return DEFAULT_DISPATCH_TEMPLATE
  try {
    return await readFile(path.join(dir, `${kind}.md`), 'utf8')
  } catch {
    return DEFAULT_DISPATCH_TEMPLATE
  }
}

export async function writeDispatchTemplate(dir: string, kind: string, body: string): Promise<void> {
  if (!isPlaybookName(kind)) throw new Error('not a template name')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${kind}.md`), body, 'utf8')
}

export function renderTemplate(tpl: string, vars: Record<string, string | boolean | undefined>): string {
  const truthy = (k: string) => {
    const v = vars[k]
    return v !== undefined && v !== false && v !== ''
  }
  let out = tpl
  // Sections first (innermost-last is fine for this depth), then scalars.
  for (let i = 0; i < 4; i++) {
    out = out.replace(/\{\{([#^])([\w-]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, op: string, k: string, body: string) =>
      (op === '#') === truthy(k) ? body : '',
    )
  }
  out = out.replace(/\{\{([\w-]+)\}\}/g, (_, k: string) => {
    const v = vars[k]
    return typeof v === 'string' ? v : ''
  })
  return out.replace(/\n{3,}/g, '\n\n').trim()
}
