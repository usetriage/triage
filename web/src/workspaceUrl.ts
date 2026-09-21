/**
 * Which workspace this browser *tab* is bound to.
 *
 * The daemon already scopes every request to one workspace (`?workspace=`
 * param, else the `triage_ws` cookie, else the default). The cookie is
 * per-browser though, so two tabs could never hold two workspaces at once.
 * The tab's own answer lives in its URL instead — `/w/<id>/#/inbox` — and
 * rides the wire as the query param the server already honours, so the
 * address bar stays clean and none of the ~100 fetch call sites change.
 *
 * The cookie stays as the fallback: a bare `http://localhost:5178` bookmark
 * still has to land somewhere, and the server's precedence (param → cookie →
 * default) already covers it.
 */

/** `/w/<id>` or `/w/<id>/` at the front of the path; anything after is the SPA's. */
const PREFIX_RE = /^\/w\/([^/]+)\/?/

/** Bound at module load, before anything fetches. '' = no prefix, cookie decides. */
let bound = readPath()

function readPath(pathname = location.pathname): string {
  const m = PREFIX_RE.exec(pathname)
  return m ? decodeURIComponent(m[1]) : ''
}

/** The workspace this tab is pinned to, or '' until `hello` says otherwise. */
export const boundWorkspace = (): string => bound

/** Where the SPA is mounted for a workspace — always the trailing-slash form. */
export const basePath = (id: string): string => `/w/${encodeURIComponent(id)}/`

/**
 * Tag a server path with this tab's workspace. Only `/api/…` is touched: the
 * SPA's own hash routes and any absolute URL are left alone.
 */
export function withWorkspace(url: string): string {
  if (!bound || !url.startsWith('/api/')) return url
  return `${url}${url.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(bound)}`
}

/**
 * Make every `/api/…` request carry the tab's workspace. Wrapping fetch once
 * beats threading a helper through every call site, and it cannot be forgotten
 * by a later one. Every call in the app passes a string path (checked), so the
 * Request/URL forms fall through untouched.
 */
export function installWorkspaceFetch(): void {
  const original = window.fetch.bind(window)
  window.fetch = (input, init) =>
    typeof input === 'string' ? original(withWorkspace(input), init) : original(input, init)
}

/**
 * Pin the tab to the workspace the server actually resolved (from `hello`).
 * Covers three cases in one: a bare URL gets canonicalised to `/w/<id>/` so a
 * reload is stable, a missing trailing slash is repaired, and an id the daemon
 * no longer knows is replaced by the one it fell back to rather than 404ing.
 */
export function adoptWorkspace(id: string): void {
  if (!id) return
  bound = id
  const want = basePath(id)
  if (location.pathname === want) return
  const rest = location.pathname.replace(PREFIX_RE, '')
  history.replaceState(null, '', want + rest + location.search + location.hash)
}

/**
 * Move this tab to another workspace. A full navigation, not a hash change:
 * every page refetches on mount, and the old hash is dropped because session
 * and item ids do not survive the boundary.
 */
export function gotoWorkspace(id: string): void {
  location.href = basePath(id)
}
