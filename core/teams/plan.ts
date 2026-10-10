/**
 * The team Plan (Teams v2): one artifact per run, on the work item and the lead
 * session. It is the plan you approve, the ledger every agent orients from, and
 * — at the end — the outcome. triage's code is its only writer: it is rendered
 * from the run's state after every change, so no agent can mark a task done
 * that isn't, and you change it through the drawer, never by editing the file.
 * Pure, so the rendering is tested without a server.
 */
import { outputsOf, renderHandoff, runSpent, type TeamRun } from './engine.js'

const usd = (n: number) => `$${n.toFixed(2)}`
const bullet = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n')

const STATE: Record<TeamRun['state'], string> = {
  proposed: 'proposed — waiting for your approval',
  running: 'running',
  gate: 'waiting for you',
  paused: 'paused',
  stopped: 'stopped',
  done: 'done',
}

export const planTitle = (run: TeamRun): string => `Plan · ${run.title}`.slice(0, 120)

/** Where the run stands, in one line — the plan's subtitle and the item page's status. */
export function planStatus(run: TeamRun): string {
  const n = run.card.tasks.length
  const done = run.card.tasks.filter((t) => run.tasks[t.id]?.status === 'done' || run.tasks[t.id]?.status === 'unresolved').length
  const where =
    run.state === 'running' || run.state === 'gate' || run.state === 'paused'
      ? n && run.task !== null
        ? ` · task ${run.task + 1} of ${n}`
        : ` · step ${run.step + 1} of ${run.recipe.steps.length}`
      : run.state === 'done' && n
        ? ` · ${done} of ${n} tasks`
        : ''
  const money = run.state === 'proposed' ? `cap ${usd(run.card.budgetUsd)}` : `${usd(runSpent(run))} of ${usd(run.budgetUsd)}`
  return `${run.recipe.label} team · ${STATE[run.state]}${where} · ${money}`
}

export function renderPlan(run: TeamRun): string {
  const c = run.card
  const out: string[] = [`# ${planTitle(run)}`, planStatus(run)]
  if (c.note) out.push(`> ${c.note.replace(/\n/g, '\n> ')}`)
  out.push(`## Goal\n${c.goal}`, `## Done when\n${bullet(c.criteria)}`)
  if (c.outOfScope.length) out.push(`## Out of scope\n${bullet(c.outOfScope)}`)

  if (c.tasks.length) {
    const lines = c.tasks.map((t) => {
      const st = run.tasks[t.id] ?? { status: 'todo', round: 0 }
      const mark = st.status === 'done' ? '[x]' : st.status === 'running' ? '[~]' : st.status === 'unresolved' ? '[!]' : '[ ]'
      const verdict = outputsOf(run, run.recipe.steps.find((s) => s.output === 'verdict' && s.forEach)?.id ?? '', t.id)[0]
      const detail =
        st.status === 'running'
          ? ` — ${run.recipe.steps[run.step]?.id ?? ''}${st.round ? `, fix round ${st.round}` : ''}`
          : st.status === 'done'
            ? ` — ✓${st.round ? ` after ${st.round} fix round${st.round === 1 ? '' : 's'}` : ''}${verdict ? ` · ${verdict.summary}` : ''}`
            : st.status === 'unresolved'
              ? ` — unresolved: ${st.why ?? ''}`
              : ''
      const crit = t.criteria.length ? `\n${t.criteria.map((x) => `  - ${x}`).join('\n')}` : ''
      return `- ${mark} **${t.id}** ${t.title}${detail}${crit}`
    })
    out.push(`## Tasks\n${lines.join('\n')}`)
  }

  if (run.revision) {
    out.push(`## Proposed change — waiting for you\n${run.revision.why}\n\n${run.revision.tasks.map((t) => `- ${t.id} ${t.title}`).join('\n')}`)
  }
  if (c.decisions.length) out.push(`## Decisions\n${bullet(c.decisions)}`)
  if (run.notes.length) out.push(`## Notes for whoever builds next\n${run.notes.map((n) => `- ${n.task ? `${n.task} · ` : ''}${n.text}`).join('\n')}`)

  const steps = run.recipe.steps.map((s) => {
    const who = s.agent === 'lead' ? 'lead' : s.agent === 'checks' ? 'checks' : run.agents.find((a) => a.name === s.agent)?.label ?? s.agent
    const model = run.card.steps.find((x) => x.id === s.id)?.model ?? s.model
    return `${s.forEach ? '↻ ' : ''}${s.id} (${who}${model ? ` · ${model}` : ''}${s.fanOut ? ` ×≤${s.fanOut.max}` : ''})`
  })
  out.push(`## Team\n${steps.join(' → ')}${run.recipe.steps.some((s) => s.forEach) ? '\n\n↻ = once per task' : ''}${run.team ? `\n\nFrom teams/${run.team}.md.` : ''}`)

  if (run.state === 'done' || run.state === 'stopped') {
    const last = run.recipe.steps[run.recipe.steps.length - 1]
    const report = last?.output === 'report' ? outputsOf(run, last.id)[0] : undefined
    const outcome = report
      ? report.body
      : run.state === 'stopped'
        ? 'Stopped before the end.'
        : run.recipe.steps.flatMap((s) => outputsOf(run, s.id)).slice(-3).map(renderHandoff).join('\n\n') || 'No handoffs.'
    out.push(`## Outcome\n${outcome}${run.unresolved ? `\n\n**Unresolved:** ${run.unresolved}` : ''}\n\n${usd(runSpent(run))} spent of ${usd(run.budgetUsd)}.`)
  }
  return out.join('\n\n') + '\n'
}
