import { useCallback, useEffect, useState } from 'react'
import type {
  EffortLevel,
  ImageAttachment,
  Mention,
  FastModeDisabledReason,
  FastModeState,
  PermissionMode,
  Project,
  ProjectsResponse,
  SessionStatus,
} from '../../../shared/protocol.js'
import { composerDrafts, useComposerDraft } from '../composerDrafts.js'
import { PromptBox } from './PromptBox.js'
import { PromptHead } from './PromptHead.js'

type Props = {
  /** The live session this composer steers — keys its unsent draft. */
  sessionId: string
  status: SessionStatus
  cwd: string
  branch?: string
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  fastModeState?: FastModeState
  fastModeDisabledReason?: FastModeDisabledReason
  permissionMode?: PermissionMode
  onSend: (text: string, images?: ImageAttachment[], mentions?: Mention[]) => void
  onInterrupt: () => void
  onModelChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  onFastModeChange: (fastMode: boolean) => void
  onPermissionModeChange: (mode: PermissionMode) => void
}

/**
 * The session composer — the same prompt box the draft tab uses, headed by the
 * folder the session runs in, plus the interrupt button while a turn is live.
 */
export function Composer({
  sessionId,
  status,
  cwd,
  branch,
  model,
  effort,
  fastMode,
  fastModeState,
  fastModeDisabledReason,
  permissionMode,
  onSend,
  onInterrupt,
  onModelChange,
  onFastModeChange,
  onPermissionModeChange,
}: Props) {
  // The unsent draft lives in a per-session store, not local state, so leaving
  // this session for another tab and coming back keeps what you had typed.
  const text = useComposerDraft(sessionId)
  const setText = useCallback((next: string) => composerDrafts.set(sessionId, next), [sessionId])
  const [projects, setProjects] = useState<Project[]>([])
  const running = status === 'running' || status === 'starting'

  // Only to name the project in the header — the folder itself is already fixed.
  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  return (
    <PromptBox
      head={<PromptHead projects={projects} cwd={cwd} branch={branch} />}
      cwd={cwd}
      text={text}
      onTextChange={setText}
      placeholder={running ? 'Steer the session… (queued until this turn ends)' : 'Steer the session…'}
      sendTitle="Send (Enter)"
      onSubmit={(trimmed, images, mentions) => {
        onSend(trimmed, images, mentions)
        setText('')
      }}
      model={model}
      effort={effort}
      fastMode={fastMode}
      fastModeState={fastModeState}
      fastModeDisabledReason={fastModeDisabledReason}
      permissionMode={permissionMode}
      onModelChange={onModelChange}
      onFastModeChange={onFastModeChange}
      onPermissionModeChange={onPermissionModeChange}
      running={running}
      onInterrupt={onInterrupt}
    />
  )
}
