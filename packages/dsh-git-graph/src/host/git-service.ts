/**
 * Host git service: workspace-scoped git operations through a runner seam
 * (production: the subprocess service; tests: a plain child_process runner).
 * Guards mirror ZCode's branchSwitcher semantics — unresolved conflicts,
 * in-progress operations, and branches checked out in another worktree are
 * rejected with stable codes before any mutation.
 * @module dsh-git-graph/host/git-service
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  aheadBehindArgv, checkRefFormatArgv, classifySwitchFailure, commitArgv, createBranchArgv, diffArgv,
  discardArgv, fetchArgv, forEachRefArgv,
  gitPathArgv, graphLogArgv, headBranchArgv, headShortArgv, OPERATION_MARKERS,
  pullArgv, pushArgv, remotesArgv, stageArgv, statusPorcelainArgv, switchArgv, topLevelArgv,
  unmergedArgv, unstageArgv, upstreamArgv, validateBranchName, workbenchStatusArgv,
  verifyRefArgv, worktreeListArgv,
} from '../core/git-command.ts'
import {
  parseAheadBehind, parseBranches, parseGraph, parsePorcelain, parseWorkbenchPorcelain, parseWorktreeBranches,
  type BranchesView, type GitActionResult, type GitError, type GraphView, type RepoStatus, type SwitchResult, type WorkbenchView,
} from '../core/types.ts'

/** One finished git invocation. */
export interface GitRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** The spawn seam the service runs git through (subprocess service in production). */
export interface GitRunner {
  run(argv: readonly string[], cwd: string, timeoutMs?: number): Promise<GitRunResult>
}

/** Collected-output cap for one git command (branch lists and logs fit comfortably). */
const OUTPUT_CAP_BYTES = 1 << 20

/** The workspace-membership verdict type. */
export type WorkspaceVerdict = { ok: true; canonical: string } | { ok: false; error: GitError }

/**
 * Workspace-membership gate: canonicalize the requested path and require it
 * to equal a registered workspace path (the host's realpath canon). This is
 * the security boundary of the /git routes — the browser may only run git on
 * workspace roots.
 */
export type WorkspaceGate = (path: string) => Promise<WorkspaceVerdict>

/**
 * Production runner over `ctx.subprocess`: one managed child per command,
 * bounded collect on both streams, tree-scoped teardown on abort.
 * @param ctx - context carrying the subprocess service.
 * @returns the runner.
 */
export function subprocessRunner(ctx: Context): GitRunner {
  return {
    async run(argv, cwd, timeoutMs = 30_000) {
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, timeoutMs)
      const spec: SubprocessSpawnSpec = {
        argv: ['git', ...argv],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: OUTPUT_CAP_BYTES },
          stderr: { maxBytes: OUTPUT_CAP_BYTES },
        },
        graceMs: 10_000,
        signal: controller.signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
      }
      try {
        const handle = ctx.subprocess.spawn(spec)
        const outcome = await handle.done
        const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
        const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
        return { exitCode: outcome.exitCode, stdout, stderr }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** HEAD is the symbolic value `git rev-parse --abbrev-ref HEAD` prints when detached. */
const DETACHED = 'HEAD'

/** Rejection for a path outside the workspace registry. */
const WORKSPACE_UNKNOWN: GitError = {
  code: 'workspace-unknown',
  message: 'path is not a registered workspace',
}

/**
 * Workspace-scoped git operations. Every public method first passes the
 * workspace gate, then resolves the repository root from the requested path
 * and rejects non-repositories with `null` (or a rejection for mutations).
 */
export class GitService {
  /**
   * @param runner - the spawn seam.
   * @param gate - workspace-membership gate (host: canonical path ∈ registered workspace paths).
   */
  constructor(
    private readonly runner: GitRunner,
    private readonly gate: WorkspaceGate,
  ) {}

  /** The repository snapshot the branch chip renders; null when not a repository. */
  async status(path: string): Promise<RepoStatus | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const [branchResult, headResult, porcelain] = await Promise.all([
      this.runner.run(headBranchArgv(), root),
      this.runner.run(headShortArgv(), root),
      this.runner.run(statusPorcelainArgv(), root),
    ])
    const branch = branchResult.stdout.trim()
    const counts = parsePorcelain(porcelain.stdout)
    return {
      root,
      branch: branch === DETACHED ? '' : branch,
      head: headResult.stdout.trim(),
      dirtyFiles: counts.dirtyFiles,
      untrackedFiles: counts.untrackedFiles,
      conflicts: counts.conflicts,
      operationInProgress: await this.operationInProgress(root),
    }
  }

  /** Local branch list with the current branch marked (git for-each-ref refs/heads). */
  async branches(path: string): Promise<BranchesView | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const [refs, branchResult, porcelain] = await Promise.all([
      this.runner.run(forEachRefArgv(), root),
      this.runner.run(headBranchArgv(), root),
      this.runner.run(statusPorcelainArgv(), root),
    ])
    const current = branchResult.stdout.trim()
    const counts = parsePorcelain(porcelain.stdout)
    return {
      root,
      branch: current === DETACHED ? '' : current,
      branches: parseBranches(refs.stdout),
      dirtyFiles: counts.dirtyFiles,
      untrackedFiles: counts.untrackedFiles,
      conflicts: counts.conflicts,
      operationInProgress: await this.operationInProgress(root),
    }
  }

  /**
   * Switch the workspace's checked-out branch: real `git switch --no-guess`
   * on disk, affecting every session in the workspace (never a per-session
   * override). Guards run before the mutation; switch failures classify onto
   * the stable error codes.
   * @param path - workspace root.
   * @param branch - existing local branch name.
   */
  async switchBranch(path: string, branch: string): Promise<SwitchResult> {
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: { code: 'internal', message: 'not a git repository' } }
    const formatted = await this.runner.run(checkRefFormatArgv(branch), root)
    if (formatted.exitCode !== 0) {
      return { ok: false, error: { code: 'invalid-branch-name', message: formatted.stderr.trim() || 'invalid branch name' } }
    }
    const verified = await this.runner.run(verifyRefArgv(branch), root)
    if (verified.exitCode !== 0) {
      return { ok: false, error: { code: 'target-branch-not-found', message: `branch "${branch}" does not exist locally` } }
    }
    const currentResult = await this.runner.run(headBranchArgv(), root)
    const current = currentResult.stdout.trim()
    if (current === branch) return { ok: true, branch }
    const blocked = await this.guardBlock(root, branch)
    if (blocked !== null) return { ok: false, error: blocked }
    const switched = await this.runner.run(switchArgv(branch), root)
    if (switched.exitCode === 0) return { ok: true, branch }
    return { ok: false, error: classifySwitchFailure(switched.stderr) }
  }

  /**
   * Create a branch from the current HEAD and switch to it
   * (`git switch --no-guess -c <name>`). The authoritative name gate is
   * `git check-ref-format --branch`; duplicates are rejected up front.
   * @param path - workspace root.
   * @param name - proposed branch name.
   */
  async createBranch(path: string, name: string): Promise<SwitchResult> {
    const mirrorReason = validateBranchName(name)
    if (mirrorReason !== null) {
      return { ok: false, error: { code: 'invalid-branch-name', message: `invalid branch name: ${mirrorReason}` } }
    }
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: WORKSPACE_UNKNOWN }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: { code: 'internal', message: 'not a git repository' } }
    const formatted = await this.runner.run(checkRefFormatArgv(name), root)
    if (formatted.exitCode !== 0) {
      return { ok: false, error: { code: 'invalid-branch-name', message: formatted.stderr.trim() || 'invalid branch name' } }
    }
    const refs = await this.runner.run(forEachRefArgv(), root)
    if (parseBranches(refs.stdout).some(row => row.name === name)) {
      return { ok: false, error: { code: 'branch-already-exists', message: `branch "${name}" already exists` } }
    }
    const blocked = await this.guardBlock(root, undefined)
    if (blocked !== null) return { ok: false, error: blocked }
    const created = await this.runner.run(createBranchArgv(name), root)
    if (created.exitCode === 0) return { ok: true, branch: name }
    return { ok: false, error: classifySwitchFailure(created.stderr) }
  }

  /** Topo-ordered commit graph across branches/tags/remotes (read-only). */
  async graph(path: string, limit = 200): Promise<GraphView | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const [logResult, branchResult] = await Promise.all([
      this.runner.run(graphLogArgv(limit + 1), root),
      this.runner.run(headBranchArgv(), root),
    ])
    const commits = parseGraph(logResult.stdout)
    const hasMore = commits.length > limit
    const branch = branchResult.stdout.trim()
    return {
      root,
      branch: branch === DETACHED ? '' : branch,
      commits: hasMore ? commits.slice(0, limit) : commits,
      hasMore,
    }
  }

  /** Full source-control state for the Git workbench. */
  async workbench(path: string): Promise<WorkbenchView | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const [branchResult, changesResult, remotesResult, upstreamResult] = await Promise.all([
      this.runner.run(headBranchArgv(), root),
      this.runner.run(workbenchStatusArgv(), root),
      this.runner.run(remotesArgv(), root),
      this.runner.run(upstreamArgv(), root),
    ])
    const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : undefined
    const counts = upstream === undefined
      ? { ahead: 0, behind: 0 }
      : parseAheadBehind((await this.runner.run(aheadBehindArgv(), root)).stdout)
    const branch = branchResult.stdout.trim()
    return {
      root,
      branch: branch === DETACHED ? '' : branch,
      ...(upstream !== undefined && upstream !== '' ? { upstream } : {}),
      ...counts,
      remotes: remotesResult.stdout.split('\n').map(value => value.trim()).filter(value => value !== ''),
      changes: parseWorkbenchPorcelain(changesResult.stdout),
    }
  }

  async diff(path: string, file: string, staged: boolean): Promise<string | null> {
    const root = await this.allowedRoot(path)
    if (root === null) return null
    return (await this.runner.run(diffArgv(file, staged), root)).stdout
  }

  async stage(path: string, file?: string): Promise<GitActionResult> {
    return this.mutate(path, stageArgv(file), 'Changes staged')
  }

  async unstage(path: string, file?: string): Promise<GitActionResult> {
    return this.mutate(path, unstageArgv(file), 'Changes unstaged')
  }

  async discard(path: string, file: string): Promise<GitActionResult> {
    return this.mutate(path, discardArgv(file), 'Working-tree change discarded')
  }

  async commit(path: string, message: string): Promise<GitActionResult> {
    const trimmed = message.trim()
    if (trimmed === '' || trimmed.length > 10_000) {
      return { ok: false, error: { code: 'internal', message: 'commit message must contain 1..10000 characters' } }
    }
    return this.mutate(path, commitArgv(trimmed), 'Commit created')
  }

  async sync(path: string, action: 'fetch' | 'pull' | 'push', remote?: string): Promise<GitActionResult> {
    const root = await this.allowedRoot(path)
    if (root === null) return { ok: false, error: WORKSPACE_UNKNOWN }
    let argv: string[]
    if (action === 'fetch') {
      const target = remote?.trim()
      if (target === undefined || target === '') {
        return { ok: false, error: { code: 'internal', message: 'fetch requires a configured remote' } }
      }
      const remotes = (await this.runner.run(remotesArgv(), root)).stdout.split('\n').map(value => value.trim())
      if (!remotes.includes(target)) return { ok: false, error: { code: 'internal', message: `remote "${target}" is not configured` } }
      argv = fetchArgv(target)
    } else {
      const upstream = await this.runner.run(upstreamArgv(), root)
      if (upstream.exitCode !== 0) {
        return { ok: false, error: { code: 'internal', message: 'the current branch has no upstream; configure it with git first' } }
      }
      argv = action === 'pull' ? pullArgv() : pushArgv()
    }
    return this.mutateRoot(root, argv, action === 'fetch' ? 'Fetch completed' : action === 'pull' ? 'Fast-forward pull completed' : 'Push completed', 120_000)
  }

  private async allowedRoot(path: string): Promise<string | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    return this.repoRoot(gated.canonical)
  }

  private async mutate(path: string, argv: string[], message: string): Promise<GitActionResult> {
    const root = await this.allowedRoot(path)
    if (root === null) return { ok: false, error: WORKSPACE_UNKNOWN }
    return this.mutateRoot(root, argv, message)
  }

  private async mutateRoot(root: string, argv: string[], message: string, timeoutMs?: number): Promise<GitActionResult> {
    try {
      const result = await this.runner.run(argv, root, timeoutMs)
      if (result.exitCode === 0) return { ok: true, message }
      return { ok: false, error: { code: 'internal', message: result.stderr.trim() || 'git operation failed' } }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  /** Repository root of a canonical path, or null when not inside a git repository. */
  private async repoRoot(path: string): Promise<string | null> {
    const result = await this.runner.run(topLevelArgv(), path)
    if (result.exitCode !== 0) return null
    const root = result.stdout.trim()
    return root === '' ? null : root
  }

  /** Whether any git operation marker is present in the repository. */
  private async operationInProgress(root: string): Promise<boolean> {
    for (const marker of OPERATION_MARKERS) {
      const resolved = await this.runner.run(gitPathArgv(marker), root)
      const markerPath = resolved.stdout.trim()
      // --git-path prints a repo-relative path for in-repo markers (and an
      // absolute one for worktree/linked stores); resolve covers both.
      if (markerPath !== '' && existsSync(resolve(root, markerPath))) return true
    }
    return false
  }

  /**
   * The pre-switch guards (ZCode branchSwitcher semantics): unresolved
   * conflicts, in-progress operations, and a target already checked out in
   * another worktree.
   * @param root - repository root.
   * @param target - target branch; undefined for create (worktree check skipped).
   * @returns the rejection, or null when the switch may proceed.
   */
  private async guardBlock(root: string, target: string | undefined): Promise<GitError | null> {
    const [conflicts, inProgress, worktrees] = await Promise.all([
      this.runner.run(unmergedArgv(), root),
      this.operationInProgress(root),
      target === undefined ? Promise.resolve(null) : this.runner.run(worktreeListArgv(), root),
    ])
    const conflictCount = conflicts.stdout.split('\n').filter(line => line !== '').length
    if (conflictCount > 0) {
      return { code: 'conflicts-present', message: `repository has ${conflictCount} unresolved conflict(s)` }
    }
    if (inProgress) {
      return { code: 'operation-in-progress', message: 'a git operation is in progress' }
    }
    if (target !== undefined && worktrees !== null && parseWorktreeBranches(worktrees.stdout).includes(target)) {
      return { code: 'branch-in-other-worktree', message: `branch "${target}" is checked out in another worktree` }
    }
    return null
  }
}
