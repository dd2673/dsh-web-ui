/**
 * Git workbench browser surface: the branch selector is mounted in the
 * official `conversation.input.left` composer slot, beside the built-in
 * access and plan controls. All git facts arrive through the host
 * /git routes (this package's own host half); the inject face carries the
 * business verbs, the components stay pure props.
 *
 * The session-scoped chip hides itself when the session has no workspace or
 * the workspace is not a Git repository.
 * @module dsh-git-graph/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the official ui-conversation SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BranchesView, GitActionResult, GitError, GraphView, RepoStatus, SwitchResult, WorkbenchView,
} from '../core/types.ts'
import { GitApi, subscribeChanges } from './api.ts'
import { BranchChip } from './chips/BranchChip.tsx'
import { en, zh, type GitGraphKey } from './locales.ts'

export type { GitGraphKey } from './locales.ts'
export { BranchChip } from './chips/BranchChip.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The git-graph chip copy. */
    'git-graph': GitGraphKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'git-graph'

/** Required services: slots for the composer entry, sessions for cwd lookup, and locale. */
export const inject = ['slots', 'sessions', 'connection', 'locale']

/** Injected business face of the branch chip: git verbs, keyed by the current session id. */
export interface GitGraphInjected {
  /** The workspace repository snapshot; null when not a repository. */
  repoStatus: (sessionId: SessionId | undefined) => Promise<RepoStatus | null>
  /** Local branch list with the current branch marked. */
  branches: (sessionId: SessionId | undefined) => Promise<BranchesView | null>
  /** Workspace-level `git switch --no-guess <branch>`. */
  switchBranch: (sessionId: SessionId | undefined, branch: string) => Promise<SwitchResult>
  /** `git switch --no-guess -c <name>` from the current HEAD. */
  createBranch: (sessionId: SessionId | undefined, name: string) => Promise<SwitchResult>
  /** Topo-ordered commit graph. */
  graph: (sessionId: SessionId | undefined, limit?: number) => Promise<GraphView | null>
  workbench: (sessionId: SessionId | undefined) => Promise<WorkbenchView | null>
  diff: (sessionId: SessionId | undefined, file: string, staged: boolean) => Promise<string | null>
  stage: (sessionId: SessionId | undefined, file?: string) => Promise<GitActionResult>
  unstage: (sessionId: SessionId | undefined, file?: string) => Promise<GitActionResult>
  discard: (sessionId: SessionId | undefined, file: string) => Promise<GitActionResult>
  commit: (sessionId: SessionId | undefined, message: string) => Promise<GitActionResult>
  sync: (sessionId: SessionId | undefined, action: 'fetch' | 'pull' | 'push', remote?: string) => Promise<GitActionResult>
  /** Host-pushed branch-state changes for the session's workspace. */
  subscribeChanges: (sessionId: SessionId | undefined, onChange: () => void) => () => void
}

/** The session-cwd lookup failure shared by the injected verbs. */
const NO_WORKSPACE: GitError = { code: 'workspace-unknown', message: 'session has no workspace' }

/**
 * Client plugin body: the official composer entry with its git verbs.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-git-graph: dictionaries')

  const git = new GitApi()

  // Conditional mount: conversation.input.left is declared by the shipped
  // ui-conversation shell; the conversation service is the safe signal.
  ctx.inject(['slots', 'conversation', 'sessions'], (scope: ClientContext) => {
    const sessions = scope.sessions

    /** The session's workspace root, resolved at call time from the sessions baseline. */
    const cwdOf = (sessionId: SessionId | undefined): string | undefined =>
      sessionId === undefined ? undefined : sessions.list.getSnapshot().byId[sessionId]?.cwd

    /** The injected face shared by every seat this chip registers into. */
    const injected = (): GitGraphInjected => {
      /** Resolve the workspace root for one git call. */
      const pathOf = (sessionId: SessionId | undefined): { ok: true; path: string } | { ok: false; error: GitError } => {
        const cwd = cwdOf(sessionId)
        if (cwd === undefined || cwd === '') return { ok: false, error: NO_WORKSPACE }
        return { ok: true, path: cwd }
      }
      const action = async (
        sessionId: SessionId | undefined,
        call: (path: string) => Promise<import('./api.ts').ApiResult<{ message: string }>>,
      ): Promise<GitActionResult> => {
        const resolved = pathOf(sessionId)
        if (!resolved.ok) return { ok: false, error: resolved.error }
        const result = await call(resolved.path)
        return result.ok ? { ok: true, message: result.value.message } : result
      }
      return {
        repoStatus: async (sessionId) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.status(resolved.path)
          return result.ok ? result.value : null
        },
        branches: async (sessionId) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.branches(resolved.path)
          return result.ok ? result.value : null
        },
        switchBranch: async (sessionId, branch) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          const result = await git.switchBranch(resolved.path, branch)
          return result.ok ? { ok: true, branch: result.value.branch } : result
        },
        createBranch: async (sessionId, name) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return { ok: false, error: resolved.error }
          const result = await git.createBranch(resolved.path, name)
          return result.ok ? { ok: true, branch: result.value.branch } : result
        },
        graph: async (sessionId, limit) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.graph(resolved.path, limit)
          return result.ok ? result.value : null
        },
        workbench: async (sessionId) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.workbench(resolved.path)
          return result.ok ? result.value : null
        },
        diff: async (sessionId, file, staged) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return null
          const result = await git.diff(resolved.path, file, staged)
          return result.ok ? result.value : null
        },
        stage: (sessionId, file) => action(sessionId, path => git.stage(path, file)),
        unstage: (sessionId, file) => action(sessionId, path => git.unstage(path, file)),
        discard: (sessionId, file) => action(sessionId, path => git.discard(path, file)),
        commit: (sessionId, message) => action(sessionId, path => git.commit(path, message)),
        sync: (sessionId, syncAction, remote) => action(sessionId, path => git.sync(path, syncAction, remote)),
        subscribeChanges: (sessionId, onChange) => {
          const resolved = pathOf(sessionId)
          if (!resolved.ok) return () => {}
          return subscribeChanges(resolved.path, onChange)
        },
      }
    }

    // Use the stable official rc.6 slot. The former selector-context name was
    // not part of the published/running contract and mounted no control.
    scope.slots.inject('conversation.input.left', () =>
      scope.slots.register({
        name: 'conversation.input.left',
        id: 'git-graph',
        order: 100,
        locale: NS,
        inject: injected,
      }, BranchChip))
  })
}
