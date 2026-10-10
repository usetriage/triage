import { Plus, Users } from 'lucide-react'
import { useState } from 'react'
import type { ScoredItem, TeamPickerOption, TeamPlanResponse } from '../../../shared/protocol.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'
import { loadTeamPicker, teamsCall, usd } from '../teams.js'

type Props = {
  item: ScoredItem
  /** the lead's session opened — go to it */
  onStarted: (sessionId: string) => void
  onError: (message: string) => void
}

/**
 * Dispatch to a team (Teams v2): the suggested team first, Solo next, the rest,
 * then "Create a team". Picking one opens a lead session that proposes a team
 * card — nothing runs until you approve it. Costs shown are only ever what this
 * team's finished runs really spent.
 */
export function TeamPicker({ item, onStarted, onError }: Props) {
  const [options, setOptions] = useState<TeamPickerOption[] | null>(null)
  const [suggested, setSuggested] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (open: boolean) => {
    if (!open) return
    loadTeamPicker(item.kind)
      .then((b) => {
        const rank = (o: TeamPickerOption) => (o.team === b.suggested ? 0 : o.team === 'solo' ? 1 : 2)
        setOptions([...b.options].sort((a, z) => rank(a) - rank(z) || a.label.localeCompare(z.label)))
        setSuggested(b.suggested)
      })
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
  }

  const plan = (team: string | null) => {
    setBusy(true)
    teamsCall<Extract<TeamPlanResponse, { ok: true }>>('POST', 'plan', { itemId: item.id, team })
      .then((b) => onStarted(b.sessionId))
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <Menu onOpenChange={load}>
      <MenuTrigger asChild>
        <button type="button" className="btn wide" disabled={busy} title="A lead plans a team for this item and shows you its card — nothing runs until you approve it">
          <Users size={12} aria-hidden="true" /> {busy ? 'Opening the lead…' : 'Dispatch to a team'}
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="teamPickMenu">
        <div className="uiMenuCap">Team</div>
        {options === null && <div className="uiMenuCap">loading…</div>}
        {options?.length === 0 && <div className="uiMenuCap">no usable team files — check Settings → Teams</div>}
        {options?.map((o) => (
          <MenuItem key={o.team} className="wrap" onSelect={() => plan(o.team)}>
            <span className="text">
              <span className="name">
                {o.label}
                {o.team === suggested && <span className="teamPickTag">suggested</span>}
              </span>
              <span className="desc mono">{o.steps.join(' → ')}</span>
            </span>
            <span className="val mono" title={o.runs ? `${o.runs} finished run${o.runs === 1 ? '' : 's'}` : 'No finished runs yet — this is the cap, not an estimate'}>
              {o.avgUsd !== undefined ? `avg ${usd(o.avgUsd)}` : `≤ ${usd(o.budgetUsd)}`}
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem className="wrap" onSelect={() => plan(null)}>
          <Plus size={13} aria-hidden="true" />
          <span className="text">
            <span className="name">Create a team</span>
            <span className="desc">The lead picks a saved team if one fits, or drafts one for this item</span>
          </span>
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
