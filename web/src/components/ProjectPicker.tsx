import { Check, ChevronDown, Folder, Settings2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Project } from '../../../shared/protocol.js'
import { projectColor } from '../tabs.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'

const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/**
 * Picking a project, in the two senses the app means it.
 *
 * `ProjectPicker` chooses the *folder a session runs in* — selection is a
 * path, and a path that isn't a saved project is still a legal answer.
 * `ProjectIdPicker` tags a work item with a *project*, so selection is an id
 * and "no project" is a legal answer.
 *
 * Both render the same menu body below, deliberately: the colour dot, name,
 * repo and folder are what stop two similarly-named projects being confused,
 * and that shouldn't depend on which caller you are. Only the trigger, the
 * caption and what counts as "current" differ.
 */
type MenuBodyProps = {
  projects: readonly Project[]
  caption: string
  /** rendered above the saved projects — the "no project" / unsaved-cwd row */
  leading?: ReactNode
  isOn: (p: Project) => boolean
  onPick: (p: Project) => void
}

function ProjectMenuBody({ projects, caption, leading, isOn, onPick }: MenuBodyProps) {
  return (
    <MenuContent align="start" className="projMenu">
      <div className="projMenuHead">{caption}</div>
      {leading}
      {projects.map((p) => {
        const on = isOn(p)
        return (
          <MenuItem key={p.id} className={`projRowItem${on ? ' on' : ''}`} onSelect={() => onPick(p)}>
            <span className="pdot" style={{ background: projectColor(p.path) }} aria-hidden="true" />
            <span className="text">
              <span className="name">{p.name}</span>
              <span className="desc">
                {p.repo && <span className="repo">{p.repo}</span>}
                {p.repo && <span className="sep">·</span>}
                <span className="path">{homely(p.path)}</span>
              </span>
            </span>
            {on && <Check className="check" size={13} aria-hidden="true" />}
          </MenuItem>
        )
      })}
      {projects.length === 0 && <div className="projMenuEmpty">No projects yet. Add the folders you work in.</div>}
      <MenuSeparator />
      <MenuItem asChild>
        <a href="#/settings/projects">
          <Settings2 size={14} aria-hidden="true" />
          Manage projects…
        </a>
      </MenuItem>
      <MenuItem asChild>
        <a href="#/settings/projects">
          <Folder size={14} aria-hidden="true" />
          Add a project…
        </a>
      </MenuItem>
    </MenuContent>
  )
}

type Props = {
  projects: readonly Project[]
  /** the folder a session would start in */
  cwd: string
  onPick: (cwd: string) => void
  disabled?: boolean
}

/** Which folder a draft runs in. Selection is a path. */
export function ProjectPicker({ projects, cwd, onPick, disabled }: Props) {
  const current = projects.find((p) => p.path === cwd)
  const label = current?.name ?? homely(cwd).split('/').filter(Boolean).pop() ?? cwd

  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="chip ink pick" title={`Project folder: ${cwd}`} disabled={disabled}>
          <span className="pdot" style={{ background: projectColor(cwd) }} aria-hidden="true" />
          <span className="name">{label}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      </MenuTrigger>
      <ProjectMenuBody
        projects={projects}
        caption="Run in"
        isOn={(p) => p.path === cwd}
        onPick={(p) => onPick(p.path)}
        leading={
          !current && (
            // The cwd is a real folder that just isn't saved as a project. It
            // is still the current answer, so it gets a row of its own.
            <MenuItem className="projRowItem on" onSelect={() => onPick(cwd)}>
              <span className="pdot" style={{ background: projectColor(cwd) }} aria-hidden="true" />
              <span className="text">
                <span className="name">{label}</span>
                <span className="desc">
                  <span className="path">{homely(cwd)}</span>
                  <span className="sep">·</span>
                  <span>not a saved project</span>
                </span>
              </span>
              <Check className="check" size={13} aria-hidden="true" />
            </MenuItem>
          )
        }
      />
    </Menu>
  )
}

type IdProps = {
  projects: readonly Project[]
  /** the selected project's id; '' for none */
  value: string
  onChange: (id: string) => void
  caption?: string
  /** the trigger, given what to show — so each caller keeps its own chrome */
  children: (current: Project | undefined) => ReactNode
}

/** Which project a work item belongs to. Selection is an id; '' means none. */
export function ProjectIdPicker({ projects, value, onChange, caption = 'Project', children }: IdProps) {
  const current = projects.find((p) => p.id === value)

  return (
    <Menu>
      <MenuTrigger asChild>{children(current)}</MenuTrigger>
      <ProjectMenuBody
        projects={projects}
        caption={caption}
        isOn={(p) => p.id === value}
        onPick={(p) => onChange(p.id)}
        leading={
          <MenuItem className={`projRowItem none${current ? '' : ' on'}`} onSelect={() => onChange('')}>
            <span className="text">
              <span className="name">No project</span>
            </span>
            {!current && <Check className="check" size={13} aria-hidden="true" />}
          </MenuItem>
        }
      />
    </Menu>
  )
}
