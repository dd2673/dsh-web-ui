import assert from 'node:assert/strict'

const endpoint = process.argv[2] || 'http://127.0.0.1:9223'
const targets = await fetch(`${endpoint}/json`).then(response => response.json())
const target = targets.find(item => item.type === 'page' && item.url === 'file:///android_asset/index.html')
assert.ok(target?.webSocketDebuggerUrl, 'Android WebView CDP target is unavailable')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(message.error.message))
  else waiter.resolve(message.result)
})

function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'WebView evaluation failed')
  return result.result?.value
}

async function waitFor(expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

async function touchSwipe(selector, fromRatio, toRatio) {
  await evaluate(`(() => {
    document.querySelector('[data-e2e-swipe-target]')?.removeAttribute('data-e2e-swipe-target')
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(candidate => {
      const rect = candidate.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    if (!node) return
    node.dataset.e2eSwipeTarget = 'true'
    window.__dshSwipeLabel = node.textContent
    node.scrollIntoView({ block: 'center' })
  })()`)
  await new Promise(resolve => setTimeout(resolve, 200))
  const box = await evaluate(`(() => {
    const node = document.querySelector('[data-e2e-swipe-target]')
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })()`)
  assert.ok(box?.width > 0 && box?.height > 0, 'Swipe target is not visible')
  const y = box.top + box.height / 2
  const fromX = box.left + box.width * fromRatio
  const toX = box.left + box.width * toRatio
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (fromX + toX) / 2, y, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toX, y, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y, button: 'left', buttons: 0, clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 250))
}

async function tap(selector) {
  const point = await evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, 'Tap target is unavailable')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 200))
}

await send('Runtime.enable')
await send('Page.enable')
const collapsedPreferenceBefore = await evaluate(`(() => {
  const config = JSON.parse(window.DshRemoteNative.loadConfig())
  const key = 'dsh-remote:collapsed-workspaces:' + (config.hostId || 'unconfigured')
  return { key, value: localStorage.getItem(key) }
})()`)

try {
await evaluate(`(() => {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()
  if (!document.getElementById('controlSheet').hidden) document.getElementById('closeSheet').click()
  if (!document.getElementById('directoryBrowser').hidden) document.getElementById('closeDirectory').click()
  if (!document.getElementById('sessionPage').hidden) document.getElementById('closeSession').click()
  if (!document.querySelector('[data-view="tasks"]').classList.contains('active')) {
    document.querySelector('[data-view="tasks"]').click()
  }
  window.scrollTo(0, 0)
  document.getElementById('refreshTasks').click()
})()`)
await waitFor(`document.querySelectorAll('.task-group-toggle').length > 0`)
await evaluate(`(() => {
  const toggle = document.querySelector('.task-group-toggle')
  if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click()
})()`)

const baseLayout = await evaluate(`(() => ({
  noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
  groupCount: document.querySelectorAll('.task-group-toggle').length,
  sessionCount: document.querySelectorAll('#taskList .session-swipe').length,
  navVisible: getComputedStyle(document.querySelector('.bottom-nav')).position === 'fixed'
}))()`)
assert.equal(baseLayout.noHorizontalOverflow, true)
assert.ok(baseLayout.groupCount > 0)
assert.ok(baseLayout.sessionCount > 0)
assert.equal(baseLayout.navVisible, true)

const collapseResult = await evaluate(`(() => {
  const toggle = document.querySelector('.task-group-toggle')
  const label = toggle.closest('.task-group').querySelector('.task-group-title').textContent
  toggle.click()
  const collapsedRows = document.querySelector('.task-group .stack')
  const collapsed = document.querySelector('.task-group-toggle').getAttribute('aria-expanded') === 'false' && collapsedRows.hidden && getComputedStyle(collapsedRows).display === 'none'
  const search = document.getElementById('taskSearch')
  search.value = label
  search.dispatchEvent(new Event('input', { bubbles: true }))
  const expandedForSearch = document.querySelector('.task-group-toggle').getAttribute('aria-expanded') === 'true' && !document.querySelector('.task-group .stack').hidden
  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
  const restoredRows = document.querySelector('.task-group .stack')
  const restored = document.querySelector('.task-group-toggle').getAttribute('aria-expanded') === 'false' && restoredRows.hidden && getComputedStyle(restoredRows).display === 'none'
  return { collapsed, expandedForSearch, restored }
})()`)
assert.deepEqual(collapseResult, { collapsed: true, expandedForSearch: true, restored: true })

await evaluate(`location.reload()`)
await waitFor(`document.querySelectorAll('.task-group-toggle').length > 0`, 20_000)
await evaluate(`document.querySelector('[data-view="tasks"]').click()`)
const persistedCollapse = await evaluate(`(() => {
  const toggle = document.querySelector('.task-group-toggle')
  const rows = toggle.closest('.task-group').querySelector('.stack')
  const persisted = toggle.getAttribute('aria-expanded') === 'false' && rows.hidden && getComputedStyle(rows).display === 'none'
  toggle.click()
  return persisted
})()`)
assert.equal(persistedCollapse, true)

// A busy session can emit another mux event while session.list is still in
// flight. That event must queue one follow-up roster refresh instead of being
// dropped, otherwise a concurrently-created desktop session stays invisible.
await evaluate(`(() => {
  const harness = { originalSend: WebSocket.prototype.send, listRequests: [] }
  window.__dshRosterRefreshHarness = harness
  WebSocket.prototype.send = function (value) {
    let frame
    try { frame = JSON.parse(String(value)) } catch (_) { return harness.originalSend.call(this, value) }
    if (frame.type === 'rpc.request' && frame.method === 'session.list') {
      harness.listRequests.push({ socket: this, frame })
      return
    }
    return harness.originalSend.call(this, value)
  }
  document.getElementById('refreshTasks').click()
})()`)
await waitFor(`window.__dshRosterRefreshHarness.listRequests.length === 1`)
await evaluate(`(() => {
  const harness = window.__dshRosterRefreshHarness
  const first = harness.listRequests[0]
  first.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    v: 1,
    type: 'event',
    payload: { rpcId: 'e2e-busy-event', payload: {
      type: 'session/event', sessionId: 'e2e-busy-session',
      event: { seq: 900001, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'busy' } } },
    } },
  }) }))
  first.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    v: 1,
    type: 'rpc.response',
    messageId: first.frame.messageId,
    payload: { result: { ok: true, value: { items: [], hasMore: false } } },
  }) }))
})()`)
await waitFor(`window.__dshRosterRefreshHarness.listRequests.length === 2`)
await evaluate(`(() => {
  const harness = window.__dshRosterRefreshHarness
  const second = harness.listRequests[1]
  second.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    v: 1,
    type: 'rpc.response',
    messageId: second.frame.messageId,
    payload: { result: { ok: true, value: { items: [{
      sessionId: 'e2e-concurrent-new-session', cwd: 'D:\\\\AI\\\\DeepSeek', updatedAt: Date.now(), running: false,
      projections: { values: { title: 'E2E_QUEUED_REFRESH_NEW_SESSION' } },
    }], hasMore: false } } },
  }) }))
})()`)
await waitFor(`document.getElementById('taskList').textContent.includes('E2E_QUEUED_REFRESH_NEW_SESSION')`)
await evaluate(`(() => {
  const harness = window.__dshRosterRefreshHarness
  WebSocket.prototype.send = harness.originalSend
  delete window.__dshRosterRefreshHarness
  document.getElementById('refreshTasks').click()
})()`)
// Wait for the real roster response, not the transient loading placeholder.
await waitFor(`!document.getElementById('taskList').textContent.includes('E2E_QUEUED_REFRESH_NEW_SESSION') && document.querySelectorAll('#taskList .session-swipe').length === ${baseLayout.sessionCount}`)

await touchSwipe('#taskList .session-swipe .row-card', 0.82, 0.34)
assert.equal(await evaluate(`(document.querySelector('[data-e2e-swipe-target]') || [...document.querySelectorAll('#taskList .row-card')].find(node => node.textContent === window.__dshSwipeLabel)).closest('.session-swipe').classList.contains('open')`), true)
assert.equal(await evaluate(`(() => {
  const wrapper = (document.querySelector('[data-e2e-swipe-target]') || [...document.querySelectorAll('#taskList .row-card')].find(node => node.textContent === window.__dshSwipeLabel)).closest('.session-swipe')
  const actions = wrapper.querySelector('.session-swipe-actions').getBoundingClientRect()
  const card = wrapper.querySelector('.row-card').getBoundingClientRect()
  return actions.right <= wrapper.getBoundingClientRect().right + 1 && card.right < wrapper.getBoundingClientRect().right
})()`), true)
await tap('[data-e2e-swipe-target]')
assert.equal(await evaluate(`(document.querySelector('[data-e2e-swipe-target]') || [...document.querySelectorAll('#taskList .row-card')].find(node => node.textContent === window.__dshSwipeLabel)).closest('.session-swipe').classList.contains('open')`), false)
await touchSwipe('#taskList .session-swipe .row-card', 0.34, 0.82)
assert.equal(await evaluate(`(document.querySelector('[data-e2e-swipe-target]') || [...document.querySelectorAll('#taskList .row-card')].find(node => node.textContent === window.__dshSwipeLabel)).closest('.session-swipe').classList.contains('open')`), false)

const sessionsBeforeNew = await evaluate(`document.querySelectorAll('#taskList .session-swipe').length`)
await evaluate(`document.getElementById('newSession').click()`)
await waitFor(`(() => {
  const sheet = document.getElementById('controlSheet')
  const rect = sheet.getBoundingClientRect()
  return !sheet.hidden && getComputedStyle(sheet).display !== 'none' && rect.width > 0 && rect.height > 0
})()`)
const newSheet = await evaluate(`(() => ({
  correctTitle: document.getElementById('sheetTitle').textContent === '选择新会话的工作目录',
  hasBrowser: [...document.querySelectorAll('#sheetList .sheet-option strong')].some(node => node.textContent === '浏览电脑目录'),
  outsideHiddenSession: !document.getElementById('sessionPage').contains(document.getElementById('controlSheet')),
}))()`)
assert.deepEqual(newSheet, { correctTitle: true, hasBrowser: true, outsideHiddenSession: true })
await evaluate(`(() => {
  const options = [...document.querySelectorAll('#sheetList .sheet-option')]
  options.find(node => node.querySelector('strong')?.textContent === '浏览电脑目录').click()
})()`)
await waitFor(`!document.getElementById('directoryBrowser').hidden`)
await waitFor(`document.querySelectorAll('#directoryDrives button').length > 0`)
await waitFor(`document.getElementById('directoryPath').textContent.length > 0`, 15_000)
const directoryState = await evaluate(`(() => ({
  driveCount: document.querySelectorAll('#directoryDrives button').length,
  hasScopedSearch: Boolean(document.getElementById('directorySearch')),
  hasPath: document.getElementById('directoryPath').textContent.length > 0,
  overflow: document.querySelector('.directory-panel').scrollWidth > document.querySelector('.directory-panel').clientWidth + 1
}))()`)
assert.ok(directoryState.driveCount > 0)
assert.equal(directoryState.hasScopedSearch, true)
assert.equal(directoryState.hasPath, true)
assert.equal(directoryState.overflow, false)
await evaluate(`(() => {
  const search = document.getElementById('directorySearch')
  search.value = '__dsh_qa_no_match__'
  search.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await waitFor(`(() => {
  const value = document.getElementById('directoryNotice').textContent
  return value.includes('找到') || value.includes('没有匹配') || value.includes('安全上限') || value.includes('失败') || value.includes('不支持')
})()`, 15_000)
assert.equal(await evaluate(`document.querySelectorAll('#directoryList .directory-row').length`), 0)
await evaluate(`(() => {
  const search = document.getElementById('directorySearch')
  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await new Promise(resolve => setTimeout(resolve, 500))
await evaluate(`document.getElementById('closeDirectory').click()`)
assert.equal(await evaluate(`document.querySelectorAll('#taskList .session-swipe').length`), sessionsBeforeNew)

await evaluate(`(() => {
  const harness = {
    originalSend: WebSocket.prototype.send,
    historyRequests: new Map(),
  }
  const respond = (socket, frame, result) => queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify({ v: 1, type: 'rpc.response', messageId: frame.messageId, payload: { result } }),
  })))
  window.__dshNewSessionHarness = harness
  WebSocket.prototype.send = function (value) {
    let frame
    try { frame = JSON.parse(String(value)) } catch (_) { return harness.originalSend.call(this, value) }
    if (frame.type !== 'rpc.request') return harness.originalSend.call(this, value)
    if (frame.method === 'session.create') {
      respond(this, frame, { ok: true, value: { sessionId: 'e2e-new-session' } })
      return
    }
    if (frame.method === 'session.history') {
      harness.historyRequests.set(frame.payload.sessionId, { socket: this, frame })
      return
    }
    return harness.originalSend.call(this, value)
  }
})()`)
await evaluate(`document.getElementById('newSession').click()`)
await waitFor(`!document.getElementById('controlSheet').hidden`)
await evaluate(`(() => {
  const option = [...document.querySelectorAll('#sheetList .sheet-option')]
    .find(node => node.querySelector('strong')?.textContent !== '浏览电脑目录')
  option.click()
})()`)
await waitFor(`!document.getElementById('sessionPage').hidden
  && document.getElementById('controlSheet').hidden
  && document.getElementById('historyList').textContent.includes('正在加载历史记录')`)
await evaluate(`(() => {
  document.getElementById('closeSession').click()
  const existing = [...document.querySelectorAll('#taskList .row-card')]
    .find(node => node.querySelector('.row-title')?.textContent !== '新会话')
  existing.click()
})()`)
await waitFor(`window.__dshNewSessionHarness.historyRequests.size >= 2`)
await evaluate(`(() => {
  const harness = window.__dshNewSessionHarness
  const current = [...harness.historyRequests.entries()].find(([sessionId]) => sessionId !== 'e2e-new-session')[1]
  current.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    v: 1,
    type: 'rpc.response',
    messageId: current.frame.messageId,
    payload: { result: { ok: true, value: {
      events: [
        { event: { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'E2E_PREVIOUS_HISTORY' }] } } },
        { event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'E2E_CURRENT_HISTORY' }] } } },
        { event: { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'e2e-intermediate', role: 'assistant', content: [{ type: 'text', text: 'E2E_INTERMEDIATE_PROCESS' }] } } } },
        { event: { seq: 3, type: 'context/injection', data: { summary: '已应用工作区说明', metadata: {
          role: 'inject', producerLabel: 'AGENTS.md', form: 'instructions', bodyAvailability: 'desktop-only',
          changes: [{ action: 'loaded', path: 'AGENTS.md' }],
        } } } },
        { event: { seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'e2e-tool', name: 'run_code', summary: 'List web profile, search imap.qq.com references', arguments: '{"description":"List web profile, search imap.qq.com references"}' } } },
        { event: { seq: 5, type: 'tool/code-dispatch-start', data: { turn: 1, step: 1, rootCallId: 'e2e-tool', parentCallId: 'e2e-tool', subCallId: 'e2e-child', name: 'pwsh', summary: 'List web profile files', arguments: '{"description":"List web profile files"}' } } },
        { event: { seq: 6, type: 'tool/code-dispatch', data: { turn: 1, step: 1, rootCallId: 'e2e-tool', parentCallId: 'e2e-tool', subCallId: 'e2e-child', name: 'pwsh', summary: 'List web profile files', isError: false, output: '[{"type":"text","text":"profile.json"}]' } } },
        { event: { seq: 7, type: 'tool/result', data: { turn: 1, step: 1, callId: 'e2e-tool', isError: false, output: '[{"type":"text","text":"done"}]' } } },
        { event: { seq: 8, type: 'mobile/compaction', data: { compactionId: 'e2e-compact', state: 'running' } } },
        { event: { seq: 9, type: 'mobile/compaction', data: { compactionId: 'e2e-compact', state: 'complete', shadowedItems: 4 } } },
        { event: { seq: 10, type: 'mobile/model-retry', data: { retryId: 'e2e-retry', turn: 2, retry: 1, maximum: 2, delayMs: 1000, state: 'scheduled' } } },
        { event: { seq: 11, type: 'mobile/model-retry', data: { retryId: 'e2e-retry', turn: 2, retry: 1, maximum: 2, delayMs: 1000, state: 'started' } } },
        { event: { seq: 12, type: 'assistant/message', data: { turn: 1, step: 2, message: { id: 'e2e-final', role: 'assistant', content: [{ type: 'text', text: 'E2E_FINAL_REPLY' }] } } } },
        { event: { seq: 13, type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } } },
      ],
      projections: { asOfSeq: 7, values: {
        contextPressure: { projectedTokens: 6400, contextWindow: 16000 },
        contextBreakdown: { systemTokens: 1200, toolsTokens: 800, messageTokens: 4400 },
        tokenUsage: { uncachedInputTokens: 1200, cacheReadTokens: 800, outputTokens: 256 },
        sessionStats: { turns: 2, steps: 4, llmMs: 2400, toolMs: 900, ttftMs: 500, ttftSteps: 2, decodeMs: 1200, decodeTokens: 256 },
      } },
    } } },
  }) }))
})()`)
await waitFor(`document.getElementById('historyList').textContent.includes('E2E_CURRENT_HISTORY')`)
    const lifecycleDisclosure = await evaluate(`(() => {
  const context = document.querySelector('#historyList details.context-row')
  context?.querySelector('summary')?.click()
    const runSummary = document.querySelector('#historyList .run-summary-row')
    const closedHeight = runSummary?.getBoundingClientRect().height || 0
    runSummary?.querySelector('.run-summary-head')?.click()
    const openHeight = runSummary?.getBoundingClientRect().height || 0
    const openBody = runSummary?.querySelector('.run-summary-body')?.getBoundingClientRect()
    const openRow = runSummary?.getBoundingClientRect()
    const expandedNoOverlap = Boolean(openBody && openRow && openBody.height > 0
      && openRow.height >= openBody.height
      && openBody.bottom <= openRow.bottom + 1
      && document.documentElement.scrollWidth <= window.innerWidth + 1)
    runSummary?.querySelector('.run-summary-head')?.click()
    return {
    contextCount: document.querySelectorAll('#historyList details.context-row').length,
    contextOpen: context?.open === true,
    metadataOnly: context?.textContent.includes('正文仅桌面端可见') === true,
    runSummaryCount: document.querySelectorAll('#historyList .run-summary-row').length,
      runSummaryClosed: runSummary?.dataset.open !== 'true',
      runSummarySingleLine: runSummary?.querySelector('.run-summary-head')?.textContent.includes('运行过程') === true,
      historyUserCount: document.querySelectorAll('#historyList > .message.user').length,
      historicalUserVisible: [...document.querySelectorAll('#historyList > .message.user')].some(node => node.textContent.includes('E2E_PREVIOUS_HISTORY')),
      expandedNoOverlap,
      expandedHeight: openHeight > closedHeight,
    intermediateHidden: !document.getElementById('historyList').textContent.includes('E2E_INTERMEDIATE_PROCESS') || runSummary?.dataset.open !== 'true',
      userMessageVisible: [...document.querySelectorAll('#historyList > .message.user')].some(node => node.textContent.includes('E2E_CURRENT_HISTORY')),
    finalReplyVisible: document.getElementById('historyList').textContent.includes('E2E_FINAL_REPLY'),
    toolSummary: document.getElementById('historyList').textContent.includes('Code') && document.getElementById('historyList').textContent.includes('List web profile'),
    nestedTool: document.querySelectorAll('#historyList .tool-tree-body .tool-tree').length === 1,
    compaction: document.querySelectorAll('#historyList .compaction-row').length,
    retry: document.querySelectorAll('#historyList .retry-row').length,
    maxTokens: document.querySelectorAll('#historyList .max-tokens-row').length,
    statsVisible: document.getElementById('statsLine').hidden === false,
    statsText: document.getElementById('statsLine').textContent,
  }
})()`)
assert.deepEqual(lifecycleDisclosure, {
  contextCount: 1,
  contextOpen: true,
  metadataOnly: true,
  runSummaryCount: 1,
  runSummaryClosed: true,
  runSummarySingleLine: true,
  historyUserCount: 2,
  historicalUserVisible: true,
  expandedNoOverlap: true,
  expandedHeight: true,
  intermediateHidden: true,
  userMessageVisible: true,
  finalReplyVisible: true,
  toolSummary: true,
  nestedTool: true,
  compaction: 1,
  retry: 1,
  maxTokens: 1,
  statsVisible: true,
  statsText: '2 轮 · 4 步 | 模型 2.4s · 工具 0.9s | 首 token 0.3s · 213 tok/s | 缓存命中 40% | 输入 2K · 输出 256',
})
await evaluate(`(() => {
  const stale = window.__dshNewSessionHarness.historyRequests.get('e2e-new-session')
  stale.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    v: 1,
    type: 'rpc.response',
    messageId: stale.frame.messageId,
    payload: { result: { ok: false, error: { message: 'E2E_STALE_HISTORY_ERROR' } } },
  }) }))
})()`)
await new Promise(resolve => setTimeout(resolve, 250))
assert.deepEqual(await evaluate(`(() => ({
  currentHistoryPreserved: document.getElementById('historyList').textContent.includes('E2E_CURRENT_HISTORY'),
  staleErrorHidden: !document.getElementById('historyList').textContent.includes('E2E_STALE_HISTORY_ERROR'),
}))()`), { currentHistoryPreserved: true, staleErrorHidden: true })
await evaluate(`(() => {
  WebSocket.prototype.send = window.__dshNewSessionHarness.originalSend
  delete window.__dshNewSessionHarness
  document.getElementById('closeSession').click()
  location.reload()
})()`)
await waitFor(`document.querySelectorAll('.task-group-toggle').length > 0`, 20_000)
await evaluate(`document.querySelector('[data-view="tasks"]').click()`)

await evaluate(`document.querySelector('#taskList .session-swipe .row-card').click()`)
await waitFor(`!document.getElementById('sessionPage').hidden`)
await waitFor(`!document.getElementById('historyList').textContent.includes('正在加载历史记录')`, 15_000)
const sessionLayout = await evaluate(`(() => ({
  fixed: getComputedStyle(document.getElementById('sessionPage')).position === 'fixed',
  appInert: document.getElementById('app').inert === true,
  noDuplicateNav: document.getElementById('sessionPage').querySelectorAll('.bottom-nav').length === 0,
  noHorizontalOverflow: document.getElementById('sessionPage').scrollWidth <= window.innerWidth + 1,
  composerInsideViewport: document.querySelector('.composer').getBoundingClientRect().bottom <= window.innerHeight + 1
}))()`)
assert.deepEqual(sessionLayout, {
  fixed: true,
  appInert: true,
  noDuplicateNav: true,
  noHorizontalOverflow: true,
  composerInsideViewport: true,
})

const composerActionsLayout = await evaluate(`(() => {
  const row = document.querySelector('.composer-actions')
  const rowRect = row.getBoundingClientRect()
  const tools = document.querySelector('.composer-tools')
  const primary = document.querySelector('.composer-primary-actions')
  const buttons = [...row.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0)
  const rects = buttons.map(button => button.getBoundingClientRect())
  const toolButtons = [...tools.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0)
  const primaryButtons = [...primary.querySelectorAll('button')]
  return {
    oneRow: rects.every(rect => rect.top >= rowRect.top - 1 && rect.bottom <= rowRect.bottom + 1),
    toolHeight: toolButtons.every(button => Math.abs(button.getBoundingClientRect().height - 36) <= 1),
    primaryHeight: primaryButtons.every(button => Math.abs(button.getBoundingClientRect().height - 48) <= 1),
    primaryCircular: primaryButtons.every(button => {
      const rect = button.getBoundingClientRect()
      return Math.abs(rect.width - 48) <= 1 && Math.abs(rect.height - 48) <= 1
        && getComputedStyle(button).borderRadius === '999px'
    }),
    toolsScrollable: tools.scrollWidth >= tools.clientWidth,
    primaryActions: primaryButtons.length === 2,
    noOverflow: row.scrollWidth <= row.clientWidth + 1 && rects.at(-1).right <= rowRect.right + 1,
    iconOnlyPrimaryActions: ['attachmentButton', 'cancelSession', 'sendPrompt'].every(id => {
      const button = document.getElementById(id)
      return button.textContent.trim() === '' && Boolean(button.querySelector('svg')) && Boolean(button.getAttribute('aria-label'))
    }),
    permissionLabel: document.getElementById('permissionButton').textContent.trim(),
    modelLabel: document.getElementById('modelButton').textContent.trim(),
  }
})()`)
assert.equal(composerActionsLayout.oneRow, true)
assert.equal(composerActionsLayout.toolHeight, true)
assert.equal(composerActionsLayout.primaryHeight, true)
assert.equal(composerActionsLayout.primaryCircular, true)
assert.equal(composerActionsLayout.toolsScrollable, true)
assert.equal(composerActionsLayout.primaryActions, true)
assert.equal(composerActionsLayout.noOverflow, true)
assert.equal(composerActionsLayout.iconOnlyPrimaryActions, true)
assert.ok(composerActionsLayout.permissionLabel.length <= 3)
assert.ok(composerActionsLayout.modelLabel.length <= 12)
assert.equal(/^DeepSeek/i.test(composerActionsLayout.modelLabel), false)

const composerSizing = await evaluate(`(() => {
  const input = document.getElementById('promptInput')
  const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight)
  input.value = ''
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const emptyHeight = input.getBoundingClientRect().height
  input.value = Array.from({ length: 8 }, (_, index) => '第' + (index + 1) + '行').join('\\n')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const expandedHeight = input.getBoundingClientRect().height
  const overflow = getComputedStyle(input).overflowY
  input.value = ''
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return {
    oneLine: emptyHeight <= Math.ceil(lineHeight) + 1,
    fiveLineCap: expandedHeight >= lineHeight * 4.9 && expandedHeight <= Math.ceil(lineHeight * 5) + 1,
    overflow,
    reset: input.getBoundingClientRect().height <= Math.ceil(lineHeight) + 1,
  }
})()`)
assert.deepEqual(composerSizing, { oneLine: true, fiveLineCap: true, overflow: 'auto', reset: true })

await waitFor(`!document.getElementById('contextMeterButton').hidden`, 15_000)
await evaluate(`document.getElementById('contextMeterButton').click()`)
const contextState = await evaluate(`(() => ({
  panelVisible: !document.getElementById('contextMeterPanel').hidden,
  hasRatio: document.getElementById('contextFigures').textContent.includes('/'),
  hasThreeRows: document.querySelectorAll('#contextRows > div').length === 3,
  expanded: document.getElementById('contextMeterButton').getAttribute('aria-expanded') === 'true'
}))()`)
assert.deepEqual(contextState, { panelVisible: true, hasRatio: true, hasThreeRows: true, expanded: true })
await evaluate(`document.getElementById('modelButton').click()`)
await waitFor(`!document.getElementById('controlSheet').hidden`)
const modelState = await evaluate(`(() => {
  const headings = [...document.querySelectorAll('#sheetList .sheet-section-title')].map(node => node.textContent)
  return {
    correctTitle: document.getElementById('sheetTitle').textContent === '模型与思考等级',
    modelHeadingCount: headings.filter(value => value === '模型').length,
    effortHeadingCount: headings.filter(value => value === '思考等级').length,
    applyCount: [...document.querySelectorAll('#sheetList button')].filter(node => node.textContent === '应用选择').length,
  }
})()`)
assert.equal(modelState.correctTitle, true)
assert.equal(modelState.modelHeadingCount, 1)
assert.ok(modelState.effortHeadingCount <= 1)
assert.equal(modelState.applyCount, 1)
await evaluate(`document.getElementById('closeSheet').click(); document.getElementById('closeSession').click()`)

const viewport = `${await evaluate('window.innerWidth')}x${await evaluate('window.innerHeight')}`
console.log(JSON.stringify({
  ok: true,
  groups: baseLayout.groupCount,
  sessions: baseLayout.sessionCount,
  drives: directoryState.driveCount,
  context: true,
  modelSheet: true,
  composerActions: composerActionsLayout,
  viewport,
}))
} finally {
  try {
    await evaluate(`(() => {
      const key = ${JSON.stringify(collapsedPreferenceBefore.key)}
      const value = ${JSON.stringify(collapsedPreferenceBefore.value)}
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
      location.reload()
    })()`)
  } finally {
    socket.close()
  }
}
