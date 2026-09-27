/**
 * Mermaid diagrams for ```mermaid fences (rendered by components/Markdown.tsx).
 *
 * Mermaid is a megabyte of grammar and layout code, so it is a lazy import — a
 * page without diagrams never pays for it. Rendering is async and slow enough
 * to see, while markdown re-renders on every token of a streaming message, so
 * every diagram is cached by (theme, source): the second render of the same
 * fence is a map lookup. A source that does not parse caches as `null`, which
 * is how the caller knows to keep showing the code block instead.
 */
import DOMPurify from 'dompurify'
import type { Mermaid, MermaidConfig } from 'mermaid'
import type { Theme } from './themes.js'

export type DiagramTheme = Theme

/** `string` = rendered SVG, `null` = not a valid diagram, `undefined` = not rendered yet. */
const cache = new Map<string, string | null>()
const cacheKey = (theme: DiagramTheme, code: string) => `${theme.id}\n\n${code}`

export function diagram(theme: DiagramTheme, code: string): string | null | undefined {
  return cache.get(cacheKey(theme, code))
}

let loading: Promise<Mermaid> | null = null
const load = () => (loading ??= import('mermaid').then((m) => m.default))

/**
 * Mermaid bakes its palette into each SVG as it renders, so the config is read
 * back off the live CSS variables rather than hard-coded. A theme flip renders
 * again under a new cache key — the SVGs already on the page are not restyled.
 */
function config(theme: DiagramTheme): MermaidConfig {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    startOnLoad: false,
    // Diagram sources arrive in assistant output and in artifacts, so treat
    // them as untrusted: strict escapes label text and refuses click handlers.
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: v('--sans'),
    // Root fontSize wins over each diagram's own defaults (sequence otherwise
    // draws its actors at 16px), so one value keeps every diagram type in step.
    fontSize: 13,
    // Labels as SVG text, not HTML in a <foreignObject>: DOMPurify drops
    // foreignObject by design (it is a namespace-confusion vector), so an
    // HTML-labelled diagram would arrive on the page with empty boxes.
    htmlLabels: false,
    flowchart: { useMaxWidth: true },
    sequence: { useMaxWidth: true },
    themeVariables: {
      darkMode: theme.scheme === 'dark',
      background: v('--card'),
      fontFamily: v('--sans'),
      fontSize: '13px',
      primaryColor: v('--elev'),
      primaryTextColor: v('--ink'),
      primaryBorderColor: v('--stone'),
      secondaryColor: v('--card'),
      tertiaryColor: v('--deep'),
      mainBkg: v('--elev'),
      nodeBorder: v('--stone'),
      lineColor: v('--ash'),
      textColor: v('--ink'),
      titleColor: v('--ink'),
      edgeLabelBackground: v('--card'),
      clusterBkg: v('--deep'),
      clusterBorder: v('--stone'),
      noteBkgColor: v('--elev'),
      noteTextColor: v('--ink'),
      noteBorderColor: v('--stone'),
    },
  }
}

let configured: string | null = null
let seq = 0

async function renderOne(mermaid: Mermaid, code: string): Promise<string | null> {
  try {
    // parse() first: render() plants an error graphic in the document when the
    // source is bad, and a bad source is routine here (someone is mid-sentence).
    await mermaid.parse(code)
    const { svg } = await mermaid.render(`triage-mermaid-${++seq}`, code)
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } })
  } catch {
    return null
  }
}

/**
 * Render every source not already cached for `theme`. Resolves to true when
 * the cache changed — i.e. when the caller has something new to show.
 */
export async function renderDiagrams(theme: DiagramTheme, codes: string[]): Promise<boolean> {
  if (!codes.some((code) => !cache.has(cacheKey(theme, code)))) return false
  const mermaid = await load()
  if (configured !== theme.id) {
    mermaid.initialize(config(theme))
    configured = theme.id
  }
  let changed = false
  // Serially: mermaid queues render() calls internally anyway, and one message
  // rarely holds more than a diagram or two.
  for (const code of codes) {
    const key = cacheKey(theme, code)
    if (cache.has(key)) continue
    cache.set(key, await renderOne(mermaid, code))
    changed = true
  }
  return changed
}
