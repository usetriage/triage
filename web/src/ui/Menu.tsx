/**
 * A thin, styled wrapper around Radix's dropdown-menu — our one menu idiom.
 *
 * Radix owns the hard parts (focus trapping, keyboard nav, collision-aware
 * positioning, click-outside, Escape, submenu timing); we own the pixels via
 * the `uiMenu*` classes in styles.css.
 *
 * Content is portaled out of the tree, so the styling never depends on where
 * the trigger sits. *Where* it lands is decided by `usePortalContainer` —
 * <body> normally, into the surrounding dialog when that dialog is a native
 * modal one, which the browser paints above everything else. See
 * portalContainer.ts for why; Select.tsx shares it. That is what the plumbing
 * below buys: the root tracks open state and resolves the container, the
 * trigger is the anchor it measures from, and the content reads the answer
 * off context.
 *
 * The portal is a DOM portal only — React still bubbles events through the
 * *component* tree, so a click on a menu item reaches whatever wraps the
 * trigger. Our menus live inside clickable rows (sessions, terminals), so the
 * content swallows click/keydown: picking "Delete" must not also select the
 * row. Item actions run through `onSelect`, which Radix fires itself.
 */
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { createContext, useContext, useMemo, useState } from 'react'
import type { ComponentProps, ComponentPropsWithoutRef, Ref } from 'react'
import { usePortalContainer } from './portalContainer.js'

function cx(base: string, extra?: string) {
  return extra ? `${base} ${extra}` : base
}

/**
 * The root tracks where its content should portal to (see portalContainer.ts)
 * and hands it down, so `MenuContent` doesn't need to know anything about the
 * dialog it might be sitting in. The trigger is the anchor we measure from —
 * it is the one node of a menu that lives in the normal tree.
 */
type MenuCtx = { anchorRef: (node: HTMLElement | null) => void; container: HTMLElement | undefined }
const MenuContext = createContext<MenuCtx>({ anchorRef: () => {}, container: undefined })

export function Menu({
  open,
  onOpenChange,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Root>) {
  const [selfOpen, setSelfOpen] = useState(false)
  const { anchorRef, container, resolve } = usePortalContainer(open ?? selfOpen)
  const ctx = useMemo(() => ({ anchorRef, container }), [anchorRef, container])
  return (
    <MenuContext.Provider value={ctx}>
      <DropdownMenu.Root
        {...props}
        open={open}
        onOpenChange={(next) => {
          setSelfOpen(next)
          if (next) resolve()
          onOpenChange?.(next)
        }}
      />
    </MenuContext.Provider>
  )
}

/**
 * Composes any caller-supplied ref with our anchor rather than letting one
 * win: under React 19 `ref` is an ordinary prop, so a spread would silently
 * drop whichever came first — and dropping the anchor makes exactly one menu
 * quietly stop escaping its dialog, with nothing to show why.
 */
export function MenuTrigger({ ref, ...props }: ComponentProps<typeof DropdownMenu.Trigger>) {
  const { anchorRef } = useContext(MenuContext)
  return (
    <DropdownMenu.Trigger
      {...props}
      ref={(node: HTMLButtonElement | null) => {
        anchorRef(node)
        if (typeof ref === 'function') ref(node)
        else if (ref) (ref as { current: HTMLButtonElement | null }).current = node
      }}
    />
  )
}

export const MenuSub = DropdownMenu.Sub

export function MenuContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  align = 'start',
  onClick,
  onKeyDown,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  const { container } = useContext(MenuContext)
  return (
    <DropdownMenu.Portal container={container}>
      <DropdownMenu.Content
        className={cx('uiMenu', className)}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        align={align}
        onClick={(e) => {
          onClick?.(e)
          e.stopPropagation()
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          e.stopPropagation()
        }}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

export function MenuItem({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item className={cx('uiMenuItem', className)} {...props} />
}

export function MenuSubTrigger({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.SubTrigger>) {
  return <DropdownMenu.SubTrigger className={cx('uiMenuItem uiMenuSubTrigger', className)} {...props} />
}

export function MenuSubContent({
  className,
  sideOffset = 4,
  collisionPadding = 8,
  onClick,
  onKeyDown,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.SubContent>) {
  const { container } = useContext(MenuContext)
  return (
    <DropdownMenu.Portal container={container}>
      <DropdownMenu.SubContent
        className={cx('uiMenu', className)}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        onClick={(e) => {
          onClick?.(e)
          e.stopPropagation()
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          e.stopPropagation()
        }}
        {...props}
      />
    </DropdownMenu.Portal>
  )
}

export function MenuSeparator(props: ComponentPropsWithoutRef<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className="uiMenuSep" {...props} />
}

/**
 * The same menu, opened by right-click instead of a trigger button. Radix
 * gives us cursor positioning and the long-press gesture; the pixels are the
 * `uiMenu*` classes above, so a context menu looks like every other menu.
 */
export function CtxMenu({ open, onOpenChange, ...props }: ComponentProps<typeof ContextMenu.Root>) {
  const [selfOpen, setSelfOpen] = useState(false)
  const { anchorRef, container, resolve } = usePortalContainer(open ?? selfOpen)
  const ctx = useMemo(() => ({ anchorRef, container }), [anchorRef, container])
  return (
    <MenuContext.Provider value={ctx}>
      <ContextMenu.Root
        {...props}
        open={open}
        onOpenChange={(next) => {
          setSelfOpen(next)
          if (next) resolve()
          onOpenChange?.(next)
        }}
      />
    </MenuContext.Provider>
  )
}

/** The right-clicked area is the anchor — the context-menu equivalent of a trigger button. */
export function CtxMenuTrigger({ ref, ...props }: ComponentProps<typeof ContextMenu.Trigger>) {
  const { anchorRef } = useContext(MenuContext)
  return (
    <ContextMenu.Trigger
      {...props}
      ref={(node: HTMLSpanElement | null) => {
        anchorRef(node)
        if (typeof ref === 'function') ref(node)
        else if (ref) (ref as { current: HTMLSpanElement | null }).current = node
      }}
    />
  )
}

export function CtxMenuContent({
  className,
  collisionPadding = 8,
  onClick,
  onKeyDown,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenu.Content>) {
  const { container } = useContext(MenuContext)
  return (
    <ContextMenu.Portal container={container}>
      <ContextMenu.Content
        className={cx('uiMenu', className)}
        collisionPadding={collisionPadding}
        onClick={(e) => {
          onClick?.(e)
          e.stopPropagation()
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          e.stopPropagation()
        }}
        {...props}
      />
    </ContextMenu.Portal>
  )
}

export function CtxMenuItem({ className, ...props }: ComponentPropsWithoutRef<typeof ContextMenu.Item>) {
  return <ContextMenu.Item className={cx('uiMenuItem', className)} {...props} />
}

export function CtxMenuSeparator(props: ComponentPropsWithoutRef<typeof ContextMenu.Separator>) {
  return <ContextMenu.Separator className="uiMenuSep" {...props} />
}
