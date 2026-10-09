/**
 * Due dates and the inbox's day sections — pure, browser-safe, local time.
 * Time is always an argument.
 *
 * An item is due on a *day* (local midnight, ms). Where the day comes from:
 *   explicit — the source said so (a Linear/Jira due date, "by EOD" read by a watch)
 *   you      — set from the inbox (t / m / w / l); survives rescans
 *   default  — nothing set: the label's default (labels.ts), resolved against
 *              now, so a default is never late — it is a section, not a date
 * A user-set Later is `you` with no day.
 *
 * Sections: Today (overdue rolls in), the next workday, This week (up to the
 * Friday after the next workday), Later.
 */
import { LABELS, type DueDefault, type Label } from './labels.js'

export type DueSource = 'explicit' | 'you' | 'default'
export type Section = DueDefault
export const SECTION_ORDER: Section[] = ['today', 'next-workday', 'this-week', 'later']

/** More than this in Today and the section says so: a day can't hold it. */
export const TODAY_LIMIT = 7

const DAY = 86_400_000

export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function addDays(dayMs: number, n: number): number {
  const d = new Date(dayMs)
  d.setDate(d.getDate() + n)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const isWorkday = (dayMs: number): boolean => {
  const wd = new Date(dayMs).getDay()
  return wd !== 0 && wd !== 6
}

/** The next Mon–Fri after today. */
export function nextWorkday(now: number): number {
  let d = addDays(startOfDay(now), 1)
  while (!isWorkday(d)) d = addDays(d, 1)
  return d
}

/** The Friday that closes This week: the first Friday after the next workday. */
export function weekEnd(now: number): number {
  let d = addDays(nextWorkday(now), 1)
  while (new Date(d).getDay() !== 5) d = addDays(d, 1)
  return d
}

/** The day a bucket means right now — what t / m / w set; Later has none. */
export function dueFor(bucket: Section, now: number): number | null {
  switch (bucket) {
    case 'today':
      return startOfDay(now)
    case 'next-workday':
      return nextWorkday(now)
    case 'this-week':
      return weekEnd(now)
    case 'later':
      return null
  }
}

export interface DueFields {
  label: Label
  dueAt?: number
  dueSource?: 'explicit' | 'you'
}

export interface DueView {
  section: Section
  source: DueSource
  /** the set day, when there is one */
  at: number | null
  /** whole days past due (explicit or yours); 0 = not late */
  late: number
}

/** Where an item sits today and why. */
export function dueOf(item: DueFields, now: number): DueView {
  if (!item.dueSource) {
    const section = LABELS[item.label]?.due ?? 'later'
    return { section, source: 'default', at: null, late: 0 }
  }
  const at = item.dueAt ?? null
  if (at == null) return { section: 'later', source: item.dueSource, at: null, late: 0 }
  return { section: sectionFor(at, now), source: item.dueSource, at, late: daysLate(at, now) }
}

export function sectionFor(at: number, now: number): Section {
  const day = startOfDay(at)
  if (day <= startOfDay(now)) return 'today'
  if (day <= nextWorkday(now)) return 'next-workday'
  if (day <= weekEnd(now)) return 'this-week'
  return 'later'
}

function daysLate(at: number, now: number): number {
  return Math.max(0, Math.round((startOfDay(now) - startOfDay(at)) / DAY))
}

const weekdayName = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { weekday: 'long' })

/** "Today", "Due Monday", "This week" (or "Next week" once the Friday is past this one), "Later". */
export function sectionTitle(section: Section, now: number): string {
  switch (section) {
    case 'today':
      return 'Today'
    case 'next-workday':
      return `Due ${weekdayName(nextWorkday(now))}`
    case 'this-week': {
      // From Thursday on, the Friday that closes it is next week's.
      return Math.round((weekEnd(now) - startOfDay(now)) / DAY) <= 6 ? 'This week' : 'Next week'
    }
    case 'later':
      return 'Later'
  }
}

/**
 * A due day as a short chip: "today", "tomorrow", "Fri", "Oct 21". Only
 * explicit deadlines get one; a section already says the rest.
 */
export function dueChip(at: number, now: number): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days > 1 && days < 7) return new Date(at).toLocaleDateString(undefined, { weekday: 'short' })
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * A deadline a source or a watch stated. A bare date ("2026-10-12") is that
 * local day, not UTC midnight — which in the Americas is the day before.
 */
export function parseDue(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const s = raw.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return Number.isFinite(d.getTime()) ? d.getTime() : null
  }
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? startOfDay(ms) : null
}
