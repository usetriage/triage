/**
 * A thin, styled wrapper around Radix's select — our one <select> idiom.
 *
 * Radix owns the hard parts (typeahead, keyboard nav, collision-aware
 * positioning, click-outside, Escape, the hidden native input that keeps
 * forms working); we own the pixels via the `uiSelect*` classes in
 * styles.css. The trigger is a sibling of `.prioBar` — same 36px bar, same
 * hairline that brightens on hover and while open — and the popup reuses the
 * `.uiMenu` surface, so menus and selects read as one system.
 *
 * Content is portaled out of the tree, so the styling never depends on where
 * the trigger sits. *Where* it lands is decided by `usePortalContainer` —
 * <body> normally, into the surrounding dialog when that dialog is a native
 * modal one. See portalContainer.ts for why; Menu.tsx shares it. The portal is a DOM portal only — React still
 * bubbles events through the *component* tree, so a click inside the popup
 * reaches whatever wraps the trigger. Several of these live inside dialogs
 * and clickable rows, so the content swallows click/keydown: picking a value
 * must not also select the row. Value changes run through `onValueChange`,
 * which Radix fires itself.
 *
 * One thing we absorb rather than pass on: Radix reserves the empty string as
 * "clear the selection" and throws if an item is given `value=""`. Our call
 * sites came from native <select>s where `<option value="">` is the ordinary
 * way to spell "none" / "default", so this file swaps `''` for a private
 * sentinel on the way down and swaps it back on the way up. A caller writes
 * `<SelectItem value="">None</SelectItem>` and gets `''` back in
 * `onValueChange`; the sentinel never escapes this module. Don't delete it as
 * dead code — removing it makes every empty-valued item throw at render.
 */
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { usePortalContainer } from './portalContainer.js'

function cx(base: string, extra?: string) {
  return extra ? `${base} ${extra}` : base
}

/** Stands in for `''`, which Radix reserves for clearing. Never exported. */
const EMPTY = '__empty__'

const toRadix = (v: string | undefined) => (v === '' ? EMPTY : v)
const fromRadix = (v: string) => (v === EMPTY ? '' : v)

type SelectProps = Omit<ComponentPropsWithoutRef<typeof SelectPrimitive.Root>, 'children'> & {
  children: ReactNode
  /** Shown in the trigger while nothing is selected. */
  placeholder?: string
  /** Goes on the trigger button. */
  className?: string
  /** Goes on the portaled popup, for width overrides and the like. */
  contentClassName?: string
  /** A leading glyph inside the trigger, before the value. */
  icon?: ReactNode
  'aria-label'?: string
  id?: string
  title?: string
}

export function Select({
  children,
  placeholder,
  className,
  contentClassName,
  icon,
  id,
  title,
  value,
  defaultValue,
  onValueChange,
  open,
  onOpenChange,
  'aria-label': ariaLabel,
  ...props
}: SelectProps) {
  const [selfOpen, setSelfOpen] = useState(false)
  // Where the popup lands, and why it is not always <body>: portalContainer.ts.
  const { anchorRef, container, resolve } = usePortalContainer(open ?? selfOpen)
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setSelfOpen(next)
      if (next) resolve()
      onOpenChange?.(next)
    },
    [onOpenChange, resolve],
  )

  return (
    <SelectPrimitive.Root
      {...props}
      value={toRadix(value)}
      defaultValue={toRadix(defaultValue)}
      onValueChange={onValueChange && ((v) => onValueChange(fromRadix(v)))}
      open={open}
      onOpenChange={handleOpenChange}
    >
      <SelectPrimitive.Trigger ref={anchorRef} className={cx('uiSelect', className)} id={id} title={title} aria-label={ariaLabel}>
        {icon}
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="caret" asChild>
          <ChevronDown size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={container}>
        <SelectPrimitive.Content
          className={cx('uiMenu uiSelectContent', contentClassName)}
          position="popper"
          sideOffset={6}
          collisionPadding={8}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <SelectPrimitive.ScrollUpButton className="uiSelectScroll">
            <ChevronUp size={13} />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="uiSelectScroll">
            <ChevronDown size={13} />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/**
 * `description` renders *outside* `ItemText` on purpose. Radix clones an
 * item's `ItemText` content into the trigger to show the current value, so
 * anything put in there for a second line would land in the trigger too —
 * which has one line to spend. Outside it, the row can be two lines while the
 * trigger stays the name alone.
 */
export function SelectItem({
  className,
  children,
  value,
  description,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & { description?: ReactNode }) {
  return (
    <SelectPrimitive.Item
      className={cx('uiMenuItem uiSelectItem', className)}
      value={value === '' ? EMPTY : value}
      {...props}
    >
      <span className="text">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {description != null && <span className="desc">{description}</span>}
      </span>
      <SelectPrimitive.ItemIndicator asChild>
        <Check className="check" size={14} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

export const SelectGroup = SelectPrimitive.Group

export function SelectLabel({ className, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cx('uiMenuCap', className)} {...props} />
}

export function SelectSeparator(props: ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className="uiMenuSep" {...props} />
}
