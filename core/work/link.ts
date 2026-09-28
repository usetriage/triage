/**
 * Cross-source linking (.docs/watches.md): two items about the same work get
 * linked, not merged. The scanner *extracts* refs (verifiable); this module
 * canonicalizes them and folds items sharing a canonical ref into one card.
 * No shared ref → never auto-linked. No LLM anywhere.
 */
import type { ScoredItem, WorkItem } from './types.js'

// Canonical ref = the same scheme work-item ids use, so a Slack thread that
// mentions a PR links to the PR's own inbox item by string equality.
const GITHUB_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/
const GITHUB_SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/
const LINEAR_URL = /linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]+-\d+)/
const LINEAR_KEY = /^[A-Z][A-Z0-9]+-\d+$/

/** One extracted string (URL or key) → canonical ref, or null if unrecognized. */
export function canonicalizeRef(raw: string): string | null {
  const s = raw.trim()
  const gh = GITHUB_URL.exec(s) ?? GITHUB_SHORT.exec(s)
  if (gh) return `github:${gh[1]}/${gh[2]}#${gh[3]}`
  const linUrl = LINEAR_URL.exec(s)
  if (linUrl) return `linear:${linUrl[1]}`
  if (LINEAR_KEY.test(s)) return `linear:${s}`
  // already-canonical refs pass through (external scanners may send them)
  if (/^(github|linear|slack|web):\S+$/.test(s)) return s
  // any other web page: one item per page, tracking noise stripped
  const web = webRef(s)
  if (web) return web
  return null
}

/** `web:<host/path>` for an http(s) URL — lowercase host, no hash, no utm_* params, no trailing slash. */
export function webRef(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw)) return null
  try {
    const u = new URL(raw)
    if (!u.hostname.includes('.')) return null
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) u.searchParams.delete(k)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    const q = u.searchParams.toString()
    return `web:${host}${path}${q ? `?${q}` : ''}`
  } catch {
    return null
  }
}

export function canonicalizeRefs(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const refs = [...new Set(raw.filter((r): r is string => typeof r === 'string').map(canonicalizeRef).filter((r): r is string => r !== null))]
  return refs.length > 0 ? refs : undefined
}

/**
 * Fold items sharing a canonical ref into one card: the highest-scored item
 * stays, gains a +10 multi-source bonus (two signals about the same work =
 * more urgent) and carries the others as `linked`. An item's own id counts as
 * a ref, so "Slack asks for review of PR #123" folds into the PR's item.
 */
export function linkByRefs(items: ScoredItem[]): ScoredItem[] {
  // union-find over shared refs
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const p = parent.get(id)
    if (p === undefined || p === id) return id
    const root = find(p)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const byRef = new Map<string, string>() // canonical ref → first item id seen
  for (const item of items) {
    parent.set(item.id, item.id)
    for (const ref of [item.id, ...(item.refs ?? [])]) {
      const owner = byRef.get(ref)
      if (owner === undefined) byRef.set(ref, item.id)
      else union(owner, item.id)
    }
  }

  const groups = new Map<string, ScoredItem[]>()
  for (const item of items) {
    const root = find(item.id)
    const g = groups.get(root)
    if (g) g.push(item)
    else groups.set(root, [item])
  }

  const out: ScoredItem[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0])
      continue
    }
    const [primary, ...rest] = [...group].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    out.push({
      ...primary,
      score: Math.round((primary.score + 10) * 10) / 10,
      linked: rest.map((i) => ({ id: i.id, title: i.title, source: i.source, url: i.url, repo: i.repo })),
    })
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

/**
 * A canonical ref back to a URL a browser can open — or null when the ref is
 * lossy. `github:` goes to /issues/N, which GitHub redirects to /pull/N for a
 * PR; `linear:` and `slack:` refs dropped the workspace, so they have none.
 */
export function refUrl(ref: string): string | null {
  const gh = /^github:([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ref)
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}/issues/${gh[3]}`
  if (ref.startsWith('web:')) return `https://${ref.slice(4)}`
  return null
}

export type UrlKind = 'github-pr' | 'github-issue' | 'slack' | 'linear' | 'web'

/** What a link points at, for its row on the item page: "org/repo #12", "Slack thread", "NOV-4". */
export function describeUrl(raw: string): { kind: UrlKind; label: string } {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { kind: 'web', label: raw }
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const gh = host === 'github.com' ? /^\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/.exec(u.pathname) : null
  if (gh) return { kind: gh[3] === 'pull' ? 'github-pr' : 'github-issue', label: `${gh[1]}/${gh[2]} #${gh[4]}` }
  if (host.endsWith('.slack.com') && u.pathname.startsWith('/archives/'))
    return { kind: 'slack', label: /\/p\d+/.test(u.pathname) ? 'Slack thread' : 'Slack channel' }
  const lin = host === 'linear.app' ? /\/issue\/([A-Z][A-Z0-9]+-\d+)/.exec(u.pathname) : null
  if (lin) return { kind: 'linear', label: lin[1] }
  const path = u.pathname.replace(/\/+$/, '')
  return { kind: 'web', label: `${host}${path}` }
}

/** One row of an item's links: where it came from decides whether the user can remove it. */
export type ItemLink = {
  url: string
  kind: UrlKind
  label: string
  /** source = the item's own url; mentioned = a scanner-extracted ref; added = the user's `urls` */
  origin: 'source' | 'mentioned' | 'added'
}

/**
 * Everything an item links to, deduplicated by canonical ref so a PR that is
 * both the source and a pasted link shows once: the item's own url first,
 * then the user's links, then refs the scanner saw in the content.
 */
export function itemLinks(item: Pick<WorkItem, 'id' | 'url' | 'urls' | 'refs'>): ItemLink[] {
  const seen = new Set<string>([item.id])
  const out: ItemLink[] = []
  const add = (url: string, origin: ItemLink['origin']) => {
    const key = canonicalizeRef(url) ?? url
    if (seen.has(key) && origin !== 'source') return
    seen.add(key)
    out.push({ url, origin, ...describeUrl(url) })
  }
  if (item.url) add(item.url, 'source')
  for (const url of item.urls ?? []) add(url, 'added')
  for (const ref of item.refs ?? []) {
    const url = refUrl(ref)
    if (url) add(url, 'mentioned')
  }
  return out
}
