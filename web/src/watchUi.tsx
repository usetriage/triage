/**
 * Shared bits for the Watches surfaces: integration labels and icons, and the
 * schedule presets the form and the table both speak.
 */
import { FilePen, GitBranch, Globe, Hash, Layers, Plug, type LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
import type { WatchOutput, WatchRunStatus, WatchRunTrigger, WatchToolGrant } from '../../shared/protocol.js'
import { grantLabel, type BuiltinToolId } from '../../core/watch/tools.js'
import cronstrue from 'cronstrue'
import { describeCron, nextScheduled } from '../../core/watch/cron.js'

export const BUILTINS: Array<{ id: BuiltinToolId; label: string; icon: ComponentType<LucideProps>; hint: string }> = [
  { id: 'web', label: 'Web', icon: Globe, hint: 'Search and read web pages' },
  { id: 'github', label: 'GitHub', icon: GitBranch, hint: 'Read PRs, issues and runs with your gh login' },
  { id: 'files-write', label: 'Write files', icon: FilePen, hint: 'Write and edit files in the project folder — a write permission' },
]

const SERVER_ICONS: Record<string, ComponentType<LucideProps>> = { 'claude.ai Slack': Hash, 'claude.ai Linear': Layers }

/** The icon for one grant: built-ins have their own, a known server its own, anything else a plug. */
export function grantIcon(g: WatchToolGrant): ComponentType<LucideProps> {
  if (g.source.kind === 'builtin') {
    const id = g.source.id
    return BUILTINS.find((b) => b.id === id)?.icon ?? Plug
  }
  return SERVER_ICONS[g.source.server] ?? Plug
}

export { grantLabel }

/** "ok (caught up)", "failed ×3", … — a run status the way the list shows it. */
export function runStatusText(status: WatchRunStatus | undefined, trigger?: WatchRunTrigger, failures = 0): string {
  if (!status) return 'never'
  if (status === 'ok') return trigger === 'catch_up' ? 'ok (caught up)' : 'ok'
  if ((status === 'failed' || status === 'timeout') && failures > 1) return `${status} ×${failures}`
  return status
}

/** A future time, compactly: "in 12m", "in 3h", "Mon 09:00". */
export function fmtUntil(at: number, now = Date.now()): string {
  const s = Math.round((at - now) / 1000)
  if (s < 60) return 'in <1m'
  if (s < 3600) return `in ${Math.round(s / 60)}m`
  if (s < 86400) return `in ${Math.round(s / 3600)}h`
  const d = new Date(at)
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const TRIGGER_LABEL: Record<WatchRunTrigger, string> = { scheduled: 'scheduled', catch_up: 'caught up', manual: 'manual' }

/** The schedule presets — a preset plus a local time renders to one cron line. */
export type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'

export const PRESETS: Array<{ id: SchedulePreset; label: string }> = [
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'custom', label: 'Custom' },
]

export function presetToCron(preset: Exclude<SchedulePreset, 'custom'>, time: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time)
  const h = m ? Math.min(23, Number(m[1])) : 9
  const min = m ? Math.min(59, Number(m[2])) : 0
  if (preset === 'hourly') return `${min} * * * *`
  if (preset === 'daily') return `${min} ${h} * * *`
  if (preset === 'weekdays') return `${min} ${h} * * 1-5`
  return `${min} ${h} * * 1`
}

/** Recognise a cron line as one of the presets (with its time), else custom. */
export function cronToPreset(cron: string): { preset: SchedulePreset; time: string } {
  const pad = (n: string) => n.padStart(2, '0')
  let m = /^(\d+) \* \* \* \*$/.exec(cron)
  if (m) return { preset: 'hourly', time: `09:${pad(m[1])}` }
  m = /^(\d+) (\d+) \* \* (\*|1-5|1)$/.exec(cron)
  if (m) {
    const time = `${pad(m[2])}:${pad(m[1])}`
    return { preset: m[3] === '*' ? 'daily' : m[3] === '1-5' ? 'weekdays' : 'weekly', time }
  }
  return { preset: 'custom', time: '09:00' }
}

/** What a run produces. */
export const OUTPUTS: Array<{ id: WatchOutput; label: string; hint: string }> = [
  { id: 'items', label: 'Work items', hint: 'One item per match, deduped by its link.' },
  { id: 'digest', label: 'Digest', hint: 'One rolling item with a markdown report. Each run rewrites it and it returns to the inbox.' },
]

/**
 * A cron line in words. Our own phrasing for the shapes the presets make
 * ("Weekdays at 9:00 AM"), cronstrue for everything else, the raw line only
 * when neither can read it.
 */
export function cronText(expr: string): string {
  const ours = describeCron(expr)
  if (ours !== expr) return ours
  try {
    return cronstrue.toString(expr, { throwExceptionOnParseError: true, use24HourTimeFormat: false })
  } catch {
    return expr
  }
}

/** The next `n` slots after `from`. */
export function nextRuns(expr: string, from: number, n = 3): number[] {
  const out: number[] = []
  let at: number | null = from
  while (out.length < n && (at = nextScheduled(expr, at)) != null) out.push(at)
  return out
}

/** "Today 3:02 AM", "Tomorrow 9:00 AM", "Sat 3:02 AM", "Mon, Nov 3 9:00 AM" past a week. */
export function fmtSlot(at: number, now = Date.now()): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const day = (t: number) => new Date(t).toDateString()
  if (day(at) === day(now)) return `Today ${time}`
  if (day(at) === day(now + 86_400_000)) return `Tomorrow ${time}`
  if (at - now < 6 * 86_400_000) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`
}
