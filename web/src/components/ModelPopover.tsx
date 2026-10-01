/**
 * One control for how a session thinks: model and effort. The chip reads
 * "Opus · high"; the popover holds a filterable model list, who is paying
 * (the workspace's Claude auth), and effort as a segmented row with the
 * levels a model cannot do struck through. Fast mode stays its own chip.
 */
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Search, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { EffortLevel, ModelOption } from '../../../shared/protocol.js'
import { useWorkspaceId, useWorkspaces } from '../hooks.js'
import { EFFORT_LABEL, findModel, useModels } from '../models.js'
import { isMobile } from '../useMobile.js'

type Props = {
  /** The current model — an alias the user picked, or the wire id the SDK reported. */
  model?: string
  effort?: EffortLevel
  /** `undefined` on either side means "whatever Claude Code defaults to". */
  onModelChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  disabled?: boolean
}

const ALL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

const AUTH_LABEL = {
  inherit: 'your Claude login',
  'api-key': 'an API key',
  'config-dir': "this workspace's own Claude login",
} as const

export function ModelPopover({
  model,
  effort,
  onModelChange,
  disabled,
}: Props) {
  const models = useModels()
  const workspaces = useWorkspaces()
  const workspaceId = useWorkspaceId()
  const workspace = workspaces.find((w) => w.id === workspaceId)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const selected = findModel(models, model)
  const efforts = selected?.efforts ?? []

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? models.filter((m) => `${m.name} ${m.description}`.toLowerCase().includes(needle)) : models
  }, [models, q])

  function pickModel(m: ModelOption) {
    // A model that cannot do the current effort level drops it rather than
    // carrying a setting the next turn would silently ignore.
    const keep = effort && m.efforts.includes(effort) ? effort : undefined
    onModelChange(m.id, keep)
  }

  function pickEffort(level: EffortLevel | undefined) {
    // `selected.id` rather than `model`: when nothing was ever picked, `model`
    // is the wire id the SDK reported, and passing it back would silently pin
    // the session to that exact model instead of leaving it on the default.
    onModelChange(selected?.id ?? model, level)
  }

  const label = selected?.name ?? (models.length ? 'Model' : 'Loading models…')

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQ('')
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="chip model"
          disabled={disabled || models.length === 0}
          title="Model and effort for this session"
          aria-label={`Model: ${label}${effort ? `, ${EFFORT_LABEL[effort].toLowerCase()} effort` : ''}`}
        >
          <Sparkles size={12} aria-hidden="true" />
          <span className="name">{label}</span>
          {effort && <span className="eff">{EFFORT_LABEL[effort].toLowerCase()}</span>}
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="mpop"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          // Desktop: Radix focuses the search box, the first thing in here. A
          // phone would pop its keyboard over the list — show the current
          // model instead.
          onOpenAutoFocus={(e) => {
            if (!isMobile()) return
            e.preventDefault()
            requestAnimationFrame(() => document.querySelector('.mpOpt.sel')?.scrollIntoView({ block: 'nearest' }))
          }}
        >
          <label className="mpSearch">
            <Search size={13} aria-hidden="true" />
            <input
              id="modelSearch"
              placeholder="Search models…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>

          {workspace && (
            <div className="mpAuth">
              <span className="dot sm" style={{ background: workspace.color }} aria-hidden="true" />
              <span>
                Runs on {AUTH_LABEL[workspace.authBackend]}
                {workspace.authBackend === 'api-key' && workspace.apiKeyHint ? ` (${workspace.apiKeyHint})` : ''}
              </span>
              <span className="pill mute">{workspace.name}</span>
            </div>
          )}

          <div className="mpList" role="listbox" aria-label="Model">
            {shown.map((m) => {
              const on = m === selected
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`mpOpt${on ? ' sel' : ''}`}
                  onClick={() => pickModel(m)}
                >
                  <span className="n">{m.name}</span>
                  <span className="d">{m.description}</span>
                  <Check size={13} aria-hidden="true" className="chk" />
                </button>
              )
            })}
            {shown.length === 0 && <div className="mpEmpty">No model matches.</div>}
          </div>

          <div className="mpFoot" role="radiogroup" aria-label="Effort">
            <span className="lbl">Effort</span>
            <button
              type="button"
              role="radio"
              aria-checked={!effort}
              className={`eff${!effort ? ' on' : ''}`}
              title="Whatever Claude Code defaults to"
              onClick={() => pickEffort(undefined)}
            >
              Default
            </button>
            {ALL_EFFORTS.map((level) => {
              const can = efforts.length === 0 || efforts.includes(level)
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={effort === level}
                  disabled={!can}
                  className={`eff${effort === level ? ' on' : ''}${can ? '' : ' blocked'}`}
                  title={can ? EFFORT_LABEL[level] : `${selected?.name ?? 'This model'} does not offer ${EFFORT_LABEL[level].toLowerCase()}`}
                  onClick={() => pickEffort(level)}
                >
                  {EFFORT_LABEL[level]}
                </button>
              )
            })}
          </div>

        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
