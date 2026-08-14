/**
 * Git-graph surface plugin, browser half: the git branch selector chip,
 * docked above the input card. Preferred seat is the input selector row's
 * context hole (`conversation.input.selector.context`, a session-maybe
 * list slot declared and rendered by newer shipped ui-conversation shells),
 * right beside the official workspace selector; the published npm SDK
 * (rc.6) dropped that hole, so the chip waits on its declaration for
 * {@link CONTEXT_FALLBACK_MS} and then falls back to
 * `conversation.input.dock` (the 0.1.9 seat). All git facts arrive
 * through the host /git routes (this package's own host half); the inject
 * face carries the business verbs, the components stay pure props.
 *
 * The context hole is session-maybe: the chip stays mounted from cold start
 * through the active phase and hides itself when its data source is absent
 * (no session cwd, or not a git repository) — no workspace selector lives
 * here, the official selector chip docked above the input card owns that
 * surface. The dock fallback is session-scoped: the chip mounts once a
 * session is active, so the blank hero phase has no seat there (the
 * accepted rc.6 downgrade). Revision 0be6546 moved the chip back to the
 * context hole without a fallback, so on rc.6 shells the inject wait never
 * resolved and the chip disappeared. The published npm SDK (rc.6) dropped
 * the hole's type, so it is spelled locally below.
 * @module dsh-git-graph/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the official ui-conversation SlotMap merge. The
// selector-context hole is declared locally below because rc.6 dropped its
// type even though newer shells can still render it.
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

  interface SlotMap {
    /**
     * Context-chip seat beside the official workspace selector. It remains a
     * session-maybe list so the chip can mount before a session exists and
     * hide itself until a Git workspace becomes available.
     */
    'conversation.input.selector.context': {
      kind: 'list'
      scope: 'session-maybe'
      owner: InputSelectorContextOwnerProps
    }
  }
}

/** The selector context seat does not contribute additional owner props. */
export interface InputSelectorContextOwnerProps {}

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
 * How long the chip waits for the selector-context declaration before
 * falling back to the input dock. The window covers the shell's first
 * render of the input selector row after the conversation service is up;
 * shells that never declare the hole (rc.6) land on the dock after it.
 */
export const CONTEXT_FALLBACK_MS = 2000

/**
 * Client plugin body: the branch chip entry with its git verbs, on the
 * selector-context hole with an input-dock fallback.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-git-graph: dictionaries')

  const git = new GitApi()

  // The context-fallback timer, armed once the conversation seam is up and
  // cleared when this fiber unloads (the slot inject waits die with the
  // fiber too, so no seat survives an unload).
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  ctx.effect(() => () => {
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
  }, 'dsh-git-graph: context fallback timer')

  // Conditional mount: the conversation service being up is the
  // registration-safe signal (the GoalDock/QueueDock seam). The chip then
  // prefers the selector-context hole and falls back to the input dock when
  // that declaration never arrives.
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

    // The entry shape shared by both seats; each register call spells the
    // seat's literal name so its own declaration is checked.
    const chipEntry = { id: 'git-graph', order: 100, locale: NS, inject: injected } as const

    // Declaration-aware with a fallback. A bare register() would throw on
    // shells that dropped the hole (SDK SlotCore.register rejects undeclared
    // slots), so both seats route through inject like the pet / remote-web-ui
    // entries. The preferred context wait resolves the moment the shell
    // declares the hole; when it never does (rc.6), the fallback disposes
    // that wait and moves the chip to the dock. Exactly one seat mounts: a
    // context declaration landing after the fallback finds the wait gone.
    let mounted = false
    const disposeContextWait = scope.slots.inject('conversation.input.selector.context', () => {
      mounted = true
      return scope.slots.register(
        { name: 'conversation.input.selector.context', ...chipEntry },
        BranchChip)
    })
    fallbackTimer = setTimeout(() => {
      if (mounted) return
      disposeContextWait()
      scope.slots.inject('conversation.input.dock', () =>
        scope.slots.register(
          { name: 'conversation.input.dock', ...chipEntry },
          BranchChip))
    }, CONTEXT_FALLBACK_MS)
  })
}
