/** Codex-style Git workbench: changes, commit, sync, diff, and history graph. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { computeLanes, type GitActionResult, type GraphView, type LaneGlyph, type WorkbenchView } from '../../core/types.ts'
import type { GitGraphKey } from '../locales.ts'
import { Backdrop, cx } from '../chips/Chip.tsx'
import css from '../chips/context.module.css'

const INITIAL_LIMIT = 200
const PAGE_STEP = 100

function glyphChar(glyph: LaneGlyph): string {
  switch (glyph) {
    case 'node': return '●'
    case 'merge': return '◆'
    case 'pass': return '│'
    case 'gap': return ' '
  }
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function formatTime(epochSeconds: number, t: Translate<GitGraphKey>): string {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds)
  if (elapsed < MINUTE) return t('graph.time.justNow')
  if (elapsed < HOUR) return t('graph.time.minutesAgo', { count: Math.floor(elapsed / MINUTE) })
  if (elapsed < DAY) return t('graph.time.hoursAgo', { count: Math.floor(elapsed / HOUR) })
  if (elapsed < 30 * DAY) return t('graph.time.daysAgo', { count: Math.floor(elapsed / DAY) })
  const date = new Date(epochSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export interface GraphDialogProps {
  graph: (limit?: number) => Promise<GraphView | null>
  workbench: () => Promise<WorkbenchView | null>
  diff: (file: string, staged: boolean) => Promise<string | null>
  stage: (file?: string) => Promise<GitActionResult>
  unstage: (file?: string) => Promise<GitActionResult>
  discard: (file: string) => Promise<GitActionResult>
  commit: (message: string) => Promise<GitActionResult>
  sync: (action: 'fetch' | 'pull' | 'push', remote?: string) => Promise<GitActionResult>
  onChanged: () => void
  onClose: () => void
  t: Translate<GitGraphKey>
}

export function GraphDialog(props: GraphDialogProps) {
  const { t } = props
  const [tab, setTab] = useState<'changes' | 'history'>('changes')
  const [view, setView] = useState<WorkbenchView | null>(null)
  const [graphView, setGraphView] = useState<GraphView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [remote, setRemote] = useState('')
  const [selectedDiff, setSelectedDiff] = useState<{ file: string; text: string } | null>(null)

  const loadWorkbench = useCallback((): void => {
    setLoading(true)
    void props.workbench().then((next) => {
      setView(next)
      if (next !== null && (remote === '' || !next.remotes.includes(remote))) setRemote(next.remotes[0] ?? '')
      setError(next === null ? t('error.internal') : null)
    }).catch(() => { setError(t('error.internal')) }).finally(() => { setLoading(false) })
  }, [props.workbench, remote, t])

  const loadGraph = useCallback((limit: number): void => {
    setLoading(true)
    void props.graph(limit).then((next) => {
      setGraphView(next)
      setError(next === null ? t('error.internal') : null)
    }).catch(() => { setError(t('error.internal')) }).finally(() => { setLoading(false) })
  }, [props.graph, t])

  useEffect(() => { loadWorkbench() }, [loadWorkbench])
  useEffect(() => { if (tab === 'history' && graphView === null) loadGraph(INITIAL_LIMIT) }, [tab, graphView, loadGraph])

  const run = async (action: () => Promise<GitActionResult>, confirmText?: string): Promise<boolean> => {
    if (confirmText !== undefined && !window.confirm(confirmText)) return false
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await action()
      if (!result.ok) {
        setError(result.error.message)
        return false
      }
      else {
        setNotice(result.message)
        setSelectedDiff(null)
        loadWorkbench()
        props.onChanged()
        return true
      }
    } catch {
      setError(t('error.internal'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const showDiff = async (file: string, staged: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const text = await props.diff(file, staged)
      setSelectedDiff({ file, text: text ?? '' })
    } catch {
      setError(t('error.internal'))
    } finally {
      setBusy(false)
    }
  }

  const lanes = useMemo(() => graphView === null ? [] : computeLanes(graphView.commits), [graphView])
  const laneCount = useMemo(() => lanes.reduce((count, row) => Math.max(count, row.columns.length), 0), [lanes])

  return (
    <>
      <Backdrop onClose={props.onClose} />
      <div className={cx(css.dialog, css.workbenchDialog)} role="dialog" aria-label={t('workbench.title')} data-gitgraph-dialog>
        <div className={css.dialogHeader}>
          <div className={css.dialogHeading}>
            <h3 className={css.dialogTitle}>{t('workbench.title')}</h3>
            <div className={css.graphSubtitle}>
              {view === null ? t('graph.loading') : t('workbench.subtitle', { branch: view.branch || t('branch.detached'), ahead: view.ahead, behind: view.behind })}
            </div>
          </div>
          <button type="button" className={css.dialogClose} onClick={props.onClose} aria-label={t('graph.close')}><IconCloseOutline16 size={16} /></button>
        </div>
        <div className={css.workbenchTabs}>
          <button type="button" data-active={tab === 'changes'} onClick={() => { setTab('changes') }}>{t('workbench.changes')}</button>
          <button type="button" data-active={tab === 'history'} onClick={() => { setTab('history') }}>{t('workbench.history')}</button>
        </div>
        {error !== null && <div className={css.dialogError}>{error}</div>}
        {notice !== null && <div className={css.workbenchNotice}>{notice}</div>}
        {tab === 'changes' ? (
          <div className={css.workbenchBody}>
            <div className={css.workbenchToolbar}>
              <select value={remote} onChange={event => { setRemote(event.target.value) }} disabled={busy || (view?.remotes.length ?? 0) === 0}>
                {(view?.remotes ?? []).map(name => <option key={name} value={name}>{name}</option>)}
              </select>
              <button type="button" disabled={busy || remote === ''} onClick={() => { void run(() => props.sync('fetch', remote)) }}>{t('workbench.fetch')}</button>
              <button type="button" disabled={busy || view?.upstream === undefined} onClick={() => { void run(() => props.sync('pull'), t('workbench.pullConfirm')) }}>{t('workbench.pull')}</button>
              <button type="button" disabled={busy || view?.upstream === undefined} onClick={() => { void run(() => props.sync('push'), t('workbench.pushConfirm')) }}>{t('workbench.push')}</button>
              <span className={css.workbenchSpacer} />
              <button type="button" disabled={busy} onClick={loadWorkbench}>{t('workbench.refresh')}</button>
            </div>
            <div className={css.workbenchChanges}>
              {loading && view === null
                ? <div className={css.graphEmpty}>{t('graph.loading')}</div>
                : view === null || view.changes.length === 0
                  ? <div className={css.graphEmpty}>{t('workbench.clean')}</div>
                  : view.changes.map(change => {
                    const hasIndex = change.index !== ' ' && change.index !== '?'
                    const hasWorktree = change.worktree !== ' ' || change.untracked
                    return (
                      <div className={css.changeRow} key={`${change.index}${change.worktree}:${change.path}`}>
                        <span className={css.changeStatus}>{change.index}{change.worktree}</span>
                        <button type="button" className={css.changePath} title={change.path} onClick={() => { void showDiff(change.path, hasIndex && !hasWorktree) }}>{change.path}</button>
                        {hasWorktree && <button type="button" disabled={busy} onClick={() => { void run(() => props.stage(change.path)) }}>{t('workbench.stage')}</button>}
                        {hasIndex && <button type="button" disabled={busy} onClick={() => { void run(() => props.unstage(change.path)) }}>{t('workbench.unstage')}</button>}
                        {hasWorktree && !change.untracked && <button type="button" disabled={busy} onClick={() => { void run(() => props.discard(change.path), t('workbench.discardConfirm', { path: change.path })) }}>{t('workbench.discard')}</button>}
                      </div>
                    )
                  })}
            </div>
            <div className={css.workbenchBulk}>
              <button type="button" disabled={busy || view === null || view.changes.length === 0} onClick={() => { void run(() => props.stage()) }}>{t('workbench.stageAll')}</button>
              <button type="button" disabled={busy || view === null || !view.changes.some(change => change.index !== ' ' && change.index !== '?')} onClick={() => { void run(() => props.unstage()) }}>{t('workbench.unstageAll')}</button>
            </div>
            {selectedDiff !== null && <div className={css.workbenchDiff}><strong>{selectedDiff.file}</strong><pre>{selectedDiff.text || t('workbench.noDiff')}</pre></div>}
            <div className={css.workbenchCommit}>
              <textarea value={message} onChange={event => { setMessage(event.target.value) }} placeholder={t('workbench.commitPlaceholder')} />
              <button type="button" disabled={busy || message.trim() === ''} onClick={() => { void run(() => props.commit(message)).then((ok) => { if (ok) setMessage('') }) }}>{t('workbench.commit')}</button>
            </div>
          </div>
        ) : (
          <>
            <div className={css.graphBody}>
              {loading && graphView === null
                ? <div className={css.graphEmpty}>{t('graph.loading')}</div>
                : graphView === null || graphView.commits.length === 0
                  ? <div className={css.graphEmpty}>{t('graph.empty')}</div>
                  : graphView.commits.map((commit, index) => {
                    const row = lanes[index]
                    if (row === undefined) return null
                    return (
                      <div className={css.graphRow} key={commit.oid}>
                        <span className={css.graphLanes} aria-hidden="true">{row.columns.map((glyph, column) => <span key={column} className={cx(css.graphLaneCell, glyph === 'node' && css.graphLaneNode, glyph === 'merge' && css.graphLaneMerge, glyph === 'pass' && css.graphLanePass)}>{glyphChar(glyph)}</span>)}</span>
                        <span className={css.graphOid} title={commit.oid}>{commit.oid.slice(0, 7)}</span>
                        <span className={css.graphMain}><span className={css.graphSubject} title={commit.subject}>{commit.subject}</span><span className={css.graphMeta}>{commit.refs.map(ref => <span key={ref} className={cx(css.graphRef, ref === graphView.branch && css.graphRefCurrent)}>{ref}</span>)}<span>{commit.author}</span><span className={css.graphMetaSep}>·</span><span>{formatTime(commit.authorTime, t)}</span></span></span>
                      </div>
                    )
                  })}
            </div>
            {graphView !== null && graphView.hasMore && <button type="button" className={css.graphMore} onClick={() => { loadGraph(graphView.commits.length + PAGE_STEP) }}>{t('graph.loadMore')}</button>}
            <div className={css.graphSubtitle}>{t('graph.subtitle', { count: graphView?.commits.length ?? 0, lanes: laneCount })}</div>
          </>
        )}
      </div>
    </>
  )
}
