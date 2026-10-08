import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { SHORTCUTS } from '../keys.js'

export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog ref={dialog} id="helpOverlay" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <div className="helpHead">
        <h3>Keyboard shortcuts</h3>
        <button type="button" className="iconBtn" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <table>
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </dialog>
  )
}
