import { Check, ChevronDown, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { PermissionMode } from '../../../shared/protocol.js'
import { findMode, PERMISSION_MODES } from '../permissionModes.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'

type Props = {
  mode?: PermissionMode
  onChange: (mode: PermissionMode) => void
  disabled?: boolean
}

/** How much a session asks before acting. Same chip idiom as the model picker. */
export function PermissionModePicker({ mode, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<PermissionMode | null>(null)

  const selected = findMode(mode)

  function pick(id: PermissionMode, e: Event) {
    // Turning off every check is the one choice that gets a second question:
    // it is the only mode where a mis-click has no later chance to be caught.
    // preventDefault keeps the menu open so the confirm can render in place.
    if (id === 'bypassPermissions' && mode !== id) {
      e.preventDefault()
      setConfirming(id)
      return
    }
    onChange(id)
  }

  return (
    <div className="permPicker">
      <Menu
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setConfirming(null)
        }}
      >
        <MenuTrigger asChild>
          <button
            type="button"
            className={`chip perm risk-${selected.risk}`}
            disabled={disabled}
            title={`${selected.name} — ${selected.description}`}
            aria-label={`Permissions: ${selected.name}`}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            <span className="name">{selected.name}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </MenuTrigger>

        <MenuContent className="perm" side="top" align="start">
          {PERMISSION_MODES.map((m) => (
            <MenuItem
              key={m.id}
              className={`wrap risk-${m.risk}${m.id === selected.id ? ' on' : ''}`}
              onSelect={(e) => pick(m.id, e)}
            >
              <span className="text">
                <span className="name">{m.name}</span>
                <span className="desc">{m.description}</span>
              </span>
              {m.id === selected.id && <Check className="check" size={14} aria-hidden="true" />}
            </MenuItem>
          ))}

          {confirming ? (
            <div className="uiMenuConfirm">
              <p>
                Bypass runs every command and edit without asking — including ones that delete work
                or reach the network. Turn it on only where you can afford the worst case.
              </p>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  onChange(confirming)
                  setOpen(false)
                }}
              >
                Turn off all checks
              </button>
              <button type="button" className="cancel" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <p className="uiMenuBlurb">
              Applies to this session, from the next tool call on.<span className="kbdHint"> <kbd>Shift+Tab</kbd> cycles.</span>
            </p>
          )}
        </MenuContent>
      </Menu>
    </div>
  )
}
