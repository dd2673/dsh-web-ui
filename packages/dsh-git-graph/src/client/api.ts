/**
 * Browser client for the host /git/* routes: typed JSON envelope calls plus
 * the SSE change subscription. Same-origin relative fetch (the page and the
 * routes share the webserver).
 * @module dsh-git-graph/client/api
 */

import type {
  BranchesView, GitError, GraphView, RepoStatus, WorkbenchView,
} from '../core/types.ts'

/** One /git envelope response. */
export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GitError }

/** Transport failure (fetch threw or the response was not JSON). */
const TRANSPORT_ERROR: GitError = { code: 'internal', message: 'git route unavailable' }

/** POST one JSON payload and decode the envelope; never throws. */
async function post<T>(path: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
  try {
    const envelope = await response.json() as unknown
    if (typeof envelope !== 'object' || envelope === null) return { ok: false, error: TRANSPORT_ERROR }
    const record = envelope as Record<string, unknown>
    if (record.ok === true) return { ok: true, value: record.value as T }
    return { ok: false, error: (record.error as GitError | undefined) ?? TRANSPORT_ERROR }
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
}

/** Typed git operations over the wire. */
export class GitApi {
  /** The repository snapshot (null: not a git repository / not a workspace). */
  status(path: string): Promise<ApiResult<RepoStatus | null>> {
    return post('/git/status', { path })
  }

  /** Local branch list with the current branch marked. */
  branches(path: string): Promise<ApiResult<BranchesView | null>> {
    return post('/git/branches', { path })
  }

  /** Workspace-level `git switch --no-guess <branch>` (host guards first). */
  switchBranch(path: string, branch: string): Promise<ApiResult<{ branch: string }>> {
    return post('/git/switch', { path, branch })
  }

  /** `git switch --no-guess -c <name>` from the current HEAD. */
  createBranch(path: string, name: string): Promise<ApiResult<{ branch: string }>> {
    return post('/git/create-branch', { path, name })
  }

  /** Topo-ordered commit graph across branches/tags/remotes. */
  graph(path: string, limit?: number): Promise<ApiResult<GraphView | null>> {
    return post('/git/graph', limit === undefined ? { path } : { path, limit })
  }

  workbench(path: string): Promise<ApiResult<WorkbenchView | null>> {
    return post('/git/workbench', { path })
  }

  diff(path: string, file: string, staged: boolean): Promise<ApiResult<string | null>> {
    return post('/git/diff', { path, file, staged })
  }

  stage(path: string, file?: string): Promise<ApiResult<{ message: string }>> {
    return post('/git/stage', file === undefined ? { path } : { path, file })
  }

  unstage(path: string, file?: string): Promise<ApiResult<{ message: string }>> {
    return post('/git/unstage', file === undefined ? { path } : { path, file })
  }

  discard(path: string, file: string): Promise<ApiResult<{ message: string }>> {
    return post('/git/discard', { path, file })
  }

  commit(path: string, message: string): Promise<ApiResult<{ message: string }>> {
    return post('/git/commit', { path, message })
  }

  sync(path: string, action: 'fetch' | 'pull' | 'push', remote?: string): Promise<ApiResult<{ message: string }>> {
    return post('/git/sync', remote === undefined ? { path, action } : { path, action, remote })
  }
}

/**
 * Subscribe to host-pushed branch-state changes for one workspace path (the
 * host polls the workspace while a subscriber is connected). Reconnects are
 * handled by the EventSource; the caller re-subscribes when the path changes.
 * @param path - workspace root to watch.
 * @param onChange - fired on every pushed change.
 * @returns the disposer closing the stream.
 */
export function subscribeChanges(path: string, onChange: () => void): () => void {
  const source = new EventSource(`/git/events?path=${encodeURIComponent(path)}`)
  source.addEventListener('change', () => { onChange() })
  return () => { source.close() }
}
