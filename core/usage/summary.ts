/**
 * Folding raw usage entries into the shape the Usage tab draws: totals, one
 * row per day (gaps included, so the chart has an even x-axis), one row per
 * model, one row per project folder.
 */
import type {
  SessionSpend,
  UsageByModel,
  UsageModelSlice,
  UsageByProject,
  UsageDay,
  UsageSummary,
  UsageTotals,
} from '../../shared/protocol.js'
import { entryCost, type UsageEntry } from './ledger.js'

/** Local calendar day, `YYYY-MM-DD` — the daemon runs on the user's machine. */
const dayKey = (ts: number) => {
  const d = new Date(ts)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const emptyTotals = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  tokens: 0,
  cost: 0,
  messages: 0,
  sessions: 0,
  unpricedMessages: 0,
})

export function summarize(entries: UsageEntry[], since: number, now: number): UsageSummary {
  const totals = emptyTotals()
  const sessions = new Set<string>()
  const unpriced = new Set<string>()

  const days = new Map<string, { cost: number; tokens: number; byModel: Map<string, { cost: number; tokens: number }> }>()
  const models = new Map<string, UsageByModel>()
  const projects = new Map<string, { row: UsageByProject; sessions: Set<string> }>()

  for (const e of entries) {
    const tokens = e.input + e.output + e.cacheWrite5m + e.cacheWrite1h + e.cacheRead
    const cost = entryCost(e)
    if (cost === undefined) {
      unpriced.add(e.model)
      totals.unpricedMessages++
    }
    const money = cost ?? 0

    totals.input += e.input
    totals.output += e.output
    totals.cacheWrite += e.cacheWrite5m + e.cacheWrite1h
    totals.cacheRead += e.cacheRead
    totals.tokens += tokens
    totals.cost += money
    totals.messages++
    if (e.sessionId) sessions.add(e.sessionId)

    const key = dayKey(e.ts)
    const day = days.get(key) ?? { cost: 0, tokens: 0, byModel: new Map() }
    day.cost += money
    day.tokens += tokens
    const split = day.byModel.get(e.model) ?? { cost: 0, tokens: 0 }
    split.cost += money
    split.tokens += tokens
    day.byModel.set(e.model, split)
    days.set(key, day)

    const m = models.get(e.model) ?? {
      model: e.model,
      messages: 0,
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      tokens: 0,
      cost: 0,
      priced: cost !== undefined,
    }
    m.messages++
    m.input += e.input
    m.output += e.output
    m.cacheWrite += e.cacheWrite5m + e.cacheWrite1h
    m.cacheRead += e.cacheRead
    m.tokens += tokens
    m.cost += money
    models.set(e.model, m)

    if (e.cwd) {
      const p = projects.get(e.cwd) ?? {
        row: { path: e.cwd, sessions: 0, messages: 0, tokens: 0, cost: 0 },
        sessions: new Set<string>(),
      }
      p.row.messages++
      p.row.tokens += tokens
      p.row.cost += money
      if (e.sessionId) p.sessions.add(e.sessionId)
      projects.set(e.cwd, p)
    }
  }
  totals.sessions = sessions.size

  // Every day in the window, including the silent ones — a chart with holes
  // punched out of it reads as "no data", not "no work".
  const daily: UsageDay[] = []
  for (let t = since; t <= now; t += 86_400_000) {
    const key = dayKey(t)
    const hit = days.get(key)
    daily.push({
      date: key,
      cost: hit?.cost ?? 0,
      tokens: hit?.tokens ?? 0,
      byModel: hit ? Object.fromEntries(hit.byModel) : {},
    })
  }
  // A window that starts mid-day can land two stamps on one calendar day.
  const seen = new Set<string>()
  const uniqueDaily = daily.filter((d) => !seen.has(d.date) && seen.add(d.date))

  return {
    from: dayKey(since),
    to: dayKey(now),
    days: uniqueDaily.length,
    totals,
    daily: uniqueDaily,
    models: [...models.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    projects: [...projects.values()]
      .map((p) => ({ ...p.row, sessions: p.sessions.size }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    unpricedModels: [...unpriced],
    scan: { files: 0, reread: 0, ms: 0 },
  }
}

/**
 * Spend folded by Claude session id — the join key onto a triage session's
 * `sdkSessionId`. Kept beside `summarize()` rather than inside it: the item
 * page wants one number per session and none of the day/model/project rollups.
 *
 * Note the same caveat the window carries elsewhere: `entries` is whatever
 * `scanUsage` was asked for, so a session whose transcript predates the window
 * simply isn't in here — the caller reports that, it is not an error.
 */
export function summarizeBySession(entries: UsageEntry[]): Map<string, SessionSpend> {
  const out = new Map<string, SessionSpend>()
  for (const e of entries) {
    if (!e.sessionId) continue
    const row = out.get(e.sessionId) ?? {
      cost: 0,
      tokens: 0,
      messages: 0,
      priced: true,
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
    }
    const cost = entryCost(e)
    if (cost === undefined) row.priced = false
    row.cost += cost ?? 0
    row.tokens += e.input + e.output + e.cacheWrite5m + e.cacheWrite1h + e.cacheRead
    row.input += e.input
    row.output += e.output
    row.cacheWrite += e.cacheWrite5m + e.cacheWrite1h
    row.cacheRead += e.cacheRead
    row.messages++
    out.set(e.sessionId, row)
  }
  return out
}

/**
 * Spend folded by model, largest first — the split behind a cost readout.
 * A sibling of `summarize()` for callers that want only this slice: the item
 * page asks about one item's sessions, not the whole machine.
 */
export function summarizeModels(entries: UsageEntry[]): UsageModelSlice[] {
  const out = new Map<string, UsageModelSlice>()
  for (const e of entries) {
    const row = out.get(e.model) ?? { model: e.model, cost: 0, tokens: 0, priced: true }
    const cost = entryCost(e)
    if (cost === undefined) row.priced = false
    row.cost += cost ?? 0
    row.tokens += e.input + e.output + e.cacheWrite5m + e.cacheWrite1h + e.cacheRead
    out.set(e.model, row)
  }
  return [...out.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
}
