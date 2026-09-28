/**
 * Markdown rendering for assistant output: marked (GFM) → DOMPurify → HTML.
 * Sanitized even though the text comes from our own agent — tool results and
 * quoted web content flow through assistant messages, so treat it as untrusted.
 *
 * A ```mermaid fence renders as a diagram. The parse emits a placeholder that
 * still holds the source as a code block; mermaid.ts renders the SVG off to one
 * side and a layout effect swaps it in, so a diagram that is still rendering,
 * still streaming, or simply invalid degrades to the code block it was before.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useTheme } from '../appearance.js'
import { diagram, renderDiagrams } from '../mermaid.js'

marked.setOptions({
  gfm: true,
  breaks: true, // chat prose treats single newlines as line breaks
})

// Links out of assistant text open in a new tab, never navigate the app away.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Is the fence terminated? An assistant mid-sentence produces a `code` token
 * for the half-written block too, and trying to draw that is a guaranteed
 * parse error on every keystroke — so diagrams wait for the closing fence.
 */
const closedFence = (raw: string) => /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$/.test(raw.trimEnd())

// marked.parse is synchronous, so the renderer can collect into a module-level
// array that renderMarkdown swaps in around the call.
let collecting: string[] = []

marked.use({
  renderer: {
    code(token) {
      if (token.lang?.trim().toLowerCase() === 'mermaid' && closedFence(token.raw)) {
        const index = collecting.push(token.text) - 1
        return `<figure class="mermaid" data-mermaid="${index}"><pre><code class="language-mermaid">${escapeHtml(token.text)}</code></pre></figure>`
      }
      const lang = token.lang?.trim().split(/\s+/)[0]
      const codeClass = lang ? ` class="language-${escapeHtml(lang)}"` : ''
      const isMarkdown = lang?.toLowerCase() === 'markdown' || lang?.toLowerCase() === 'md'
      const previewBtn = isMarkdown
        ? '<button type="button" class="codeCopyBtn" data-preview-code aria-label="Preview markdown">Preview</button>'
        : ''
      return `<div class="codeBlock"><div class="codeToolbar">${previewBtn}<button type="button" class="codeCopyBtn" data-copy-code aria-label="Copy code">Copy</button></div><pre><code${codeClass}>${escapeHtml(token.text)}</code></pre></div>`
    },
  },
})

function renderMarkdown(text: string): { html: string; diagrams: string[] } {
  const previous = collecting
  collecting = []
  try {
    const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string)
    return { html, diagrams: collecting }
  } finally {
    collecting = previous
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const theme = useTheme()
  const [rendered, redraw] = useReducer((n: number) => n + 1, 0)
  const [zoomed, setZoomed] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewCopied, setPreviewCopied] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const { html, diagrams } = useMemo(() => renderMarkdown(text), [text])

  // Setting innerHTML wipes the SVGs, so they go back in after every change to
  // the markup — before paint, which is what keeps a streaming message steady.
  // `rendered` ticks when a diagram finishes, which is the other way in here.
  useLayoutEffect(() => {
    const root = host.current
    if (!root) return
    for (const figure of root.querySelectorAll<HTMLElement>('figure.mermaid')) {
      if (figure.classList.contains('ready')) continue // already swapped in this markup
      const index = Number(figure.dataset.mermaid)
      const code = diagrams[index]
      if (code === undefined) continue
      const svg = diagram(theme, code)
      if (svg === undefined) continue // still rendering — the code block stands in
      if (svg === null) {
        figure.classList.add('failed')
        continue
      }
      figure.classList.add('ready')
      figure.innerHTML = `<div class="mermaidCanvas">${svg}</div><button type="button" class="mermaidZoom" data-mermaid-expand="${index}" aria-label="Expand diagram">Expand</button>`
    }
  }, [html, diagrams, theme, rendered])

  useEffect(() => {
    if (diagrams.length === 0) return
    let live = true
    void renderDiagrams(theme, diagrams).then((changed) => {
      if (changed && live) redraw()
    })
    return () => {
      live = false
    }
  }, [diagrams, theme])

  const onClick = useCallback(
    (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const expandButton = target.closest<HTMLElement>('[data-mermaid-expand]')
      if (expandButton) {
        const code = diagrams[Number(expandButton.dataset.mermaidExpand)]
        const svg = code === undefined ? undefined : diagram(theme, code)
        if (svg) setZoomed(svg)
        return
      }
      const copyButton = target.closest<HTMLElement>('[data-copy-code]')
      if (copyButton) {
        const code = copyButton.closest('.codeBlock')?.querySelector('code')?.textContent ?? ''
        void navigator.clipboard.writeText(code).then(() => {
          copyButton.textContent = 'Copied'
          copyButton.classList.add('copied')
          setTimeout(() => {
            copyButton.textContent = 'Copy'
            copyButton.classList.remove('copied')
          }, 1400)
        })
        return
      }
      const previewButton = target.closest<HTMLElement>('[data-preview-code]')
      if (previewButton) {
        const code = previewButton.closest('.codeBlock')?.querySelector('code')?.textContent ?? ''
        setPreview(code)
      }
    },
    [diagrams, theme],
  )

  // Copies the rendered markdown as rich text (HTML + a plain-text fallback)
  // so pasting into a rich editor — email, Slack, docs — keeps the formatting,
  // not just the raw source the code block already offers.
  const copyPreview = useCallback(async () => {
    if (preview === null) return
    const { html } = renderMarkdown(preview)
    try {
      if (typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([preview], { type: 'text/plain' }),
          }),
        ])
      } else {
        await navigator.clipboard.writeText(preview)
      }
    } catch {
      await navigator.clipboard.writeText(preview).catch(() => {
        /* a browser that refuses the clipboard still shows the text to select */
      })
    }
    setPreviewCopied(true)
    setTimeout(() => setPreviewCopied(false), 1400)
  }, [preview])

  return (
    <>
      <div className="md" ref={host} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      <Dialog.Root open={zoomed !== null} onOpenChange={(open) => !open && setZoomed(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="settingsOverlay" />
          <Dialog.Content className="mermaidModal" aria-describedby={undefined}>
            <Dialog.Title className="sr-only">Diagram</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="iconBtn mermaidModalClose" title="Close (Esc)" aria-label="Close diagram">
                <X size={15} aria-hidden="true" />
              </button>
            </Dialog.Close>
            <div className="mermaidModalBody" dangerouslySetInnerHTML={{ __html: zoomed ?? '' }} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="settingsOverlay" />
          <Dialog.Content className="markdownPreviewModal" aria-describedby={undefined}>
            <Dialog.Title className="sr-only">Markdown preview</Dialog.Title>
            <div className="markdownPreviewToolbar">
              <button type="button" className="btn sm" onClick={() => void copyPreview()}>
                {previewCopied ? 'Copied' : 'Copy'}
              </button>
              <Dialog.Close asChild>
                <button type="button" className="iconBtn markdownPreviewClose" title="Close (Esc)" aria-label="Close preview">
                  <X size={15} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <div className="markdownPreviewBody">{preview !== null && <Markdown text={preview} />}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
})
