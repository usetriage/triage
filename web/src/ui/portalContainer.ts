/**
 * Where a portaled popup (menu, select) has to land so it is actually visible.
 *
 * Normally `<body>` is right. The exception is a native `<dialog>` opened with
 * `showModal()`: the browser paints those in the *top layer*, above the whole
 * normal stacking order, so a body-portaled popup opens behind the dialog and
 * no z-index can rescue it. For those we portal into the dialog itself.
 *
 * Two details this encodes, both learned the hard way:
 *
 * - **Modal only.** A plain `<dialog open>` is used elsewhere purely as a
 *   styling shell. It never enters the top layer, and it may carry a
 *   `transform` — which would make it the containing block for the popper's
 *   `position: fixed` and shift the popup by the dialog's own offset. Those
 *   stay on `<body>`.
 * - **Resolved on open, never on mount.** Our dialogs render their children
 *   first and call `showModal()` from an effect, so at mount time `:modal` is
 *   still false. Latching the answer then silently disables the whole thing.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

export function usePortalContainer(open: boolean) {
  const anchorNode = useRef<HTMLElement | null>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)

  // A callback ref so it can be handed to any element type, including through
  // Radix's `asChild`.
  const anchorRef = useCallback((node: HTMLElement | null) => {
    anchorNode.current = node
  }, [])

  const resolve = useCallback(() => {
    const dialog = anchorNode.current?.closest('dialog') ?? null
    setContainer(dialog?.matches(':modal') ? dialog : null)
  }, [])

  // Layout, not passive: on a controlled open the content mounts in the same
  // commit, and a passive effect would let it paint once in the wrong place.
  useLayoutEffect(() => {
    if (open) resolve()
  }, [open, resolve])

  /** `undefined` is Radix's "use the default", i.e. `<body>`. */
  return { anchorRef, container: container ?? undefined, resolve }
}
