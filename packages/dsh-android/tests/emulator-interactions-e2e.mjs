import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

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

async function waitFor(expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  const diagnostic = await evaluate(`(() => ({
    fakeSocket: typeof window.__dshFakeSocket,
    fakeErrors: window.__dshE2EErrors || [],
    connection: document.getElementById('connectionText')?.textContent,
    taskNotice: document.getElementById('taskNotice')?.textContent,
    taskList: document.getElementById('taskList')?.textContent,
    settingsOpen: document.getElementById('settingsDialog')?.open,
  }))()`)
  throw new Error(`Timed out waiting for: ${expression}\n${JSON.stringify(diagnostic)}`)
}

async function tapButton(label) {
  const point = await evaluate(`(() => {
    const node = [...document.querySelectorAll('.approval button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})
    node?.scrollIntoView({ block: 'center' })
    const rect = node?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, `button is unavailable: ${label}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
}

async function inject(rpcId, payload) {
  await evaluate(`window.__dshFakeSocket.emit(${JSON.stringify({ v: 1, type: 'event', payload: { rpcId, payload } })})`)
}

async function answerRpc(messageId, result) {
  await evaluate(`window.__dshFakeSocket.emit(${JSON.stringify({ v: 1, type: 'rpc.response', messageId, payload: { result } })})`)
}

async function requestAt(index) {
  return await evaluate(`window.__dshE2ERequests[${index}]`)
}

await send('Runtime.enable')
await send('Page.enable')
const fakeRelaySource = String.raw`
(() => {
  const workspace = { workspaceId: 'e2e-workspace', path: 'C:\\e2e\\workspace', title: 'E2E Workspace', sessionIds: ['e2e-session'] }
  const session = { sessionId: 'e2e-session', workspaceId: workspace.workspaceId, cwd: workspace.path, title: 'E2E Approval Session', running: false }
  window.__dshE2ERequests = []
  window.__dshE2EErrors = []
  window.addEventListener('error', event => window.__dshE2EErrors.push(String(event.error?.stack || event.message)))
  class FakeWebSocket extends EventTarget {
    static OPEN = 1
    readyState = 0
    constructor() {
      super()
      window.__dshFakeSocket = this
      setTimeout(() => {
        this.readyState = FakeWebSocket.OPEN
        const event = new Event('open')
        this.dispatchEvent(event)
        this.onopen?.(event)
      }, 0)
    }
    emit(message) {
      const event = new MessageEvent('message', { data: JSON.stringify(message) })
      this.dispatchEvent(event)
      this.onmessage?.(event)
    }
    reply(frame, value) {
      queueMicrotask(() => this.emit({
        v: 1, type: 'rpc.response', messageId: frame.messageId,
        payload: { result: { ok: true, value } },
      }))
    }
    send(value) {
      const frame = JSON.parse(String(value))
      if (frame.type === 'hello') {
        queueMicrotask(() => {
          this.emit({ v: 1, type: 'hello.ack' })
          this.emit({
            v: 1, type: 'capabilities',
            methods: ['workspace.list', 'session.list', 'session.history', 'events.respond'],
          })
          this.emit({ v: 1, type: 'status', hostConnected: true, host: { dshState: 'running', agentState: 'online' } })
        })
        return
      }
      if (frame.type === 'stream.subscribe') {
        queueMicrotask(() => this.emit({
          v: 1, type: 'event', payload: {
            rpcId: 'e2e-baseline',
            payload: { type: 'session/subscribed', sessionId: session.sessionId, lastSeq: 1 },
          },
        }))
        return
      }
      if (frame.type !== 'rpc.request') return
      if (frame.method === 'events.respond') {
        window.__dshE2ERequests.push(frame)
        return
      }
      if (frame.method === 'workspace.list') this.reply(frame, { items: [workspace], archivedSessionIds: [] })
      else if (frame.method === 'session.list') this.reply(frame, { items: [session] })
      else if (frame.method === 'session.history') this.reply(frame, {
        events: [{ event: { seq: 1, type: 'assistant/message', data: { message: { id: 'e2e-ready', content: [{ type: 'text', text: 'E2E ready' }] } } } }],
        projections: { asOfSeq: 1, values: { permissions: { currentValue: 'danger-full-access', options: [] } } },
      })
    }
    close() {
      this.readyState = 3
      const event = new CloseEvent('close', { code: 1000, reason: 'e2e complete' })
      this.dispatchEvent(event)
      this.onclose?.(event)
    }
  }
  window.WebSocket = FakeWebSocket
})()
`
let initScript
try {
  initScript = await send('Page.addScriptToEvaluateOnNewDocument', { source: fakeRelaySource })
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`window.__dshFakeSocket`)
  await waitFor(`document.querySelector('#taskList .session-swipe .row-card')`)
  await evaluate(`document.querySelector('#taskList .session-swipe .row-card').click()`)
  await waitFor(`window.__dshFakeSocket && window.__dshFakeSocket.readyState === WebSocket.OPEN`)
  await waitFor(`!document.getElementById('sessionPage').hidden`)
  const sessionId = 'e2e-session'

  await inject('approval-allow-rpc', {
    type: 'approval/requested', sessionId, approvalId: 'approval-allow', toolName: 'shell_command', reason: '需要执行本地测试',
  })
  await waitFor(`document.querySelector('#sessionApproval .approval-strip')?.textContent === '等待审批'`)
  assert.deepEqual(await evaluate(`(() => ({
    labels: [...document.querySelectorAll('#sessionApproval button')].map(button => button.textContent.trim()),
    composerTakenOver: document.querySelector('.composer').classList.contains('awaiting-approval'),
  }))()`), { labels: ['拒绝', '允许一次'], composerTakenOver: true })
  await tapButton('允许一次')
  await waitFor(`window.__dshE2ERequests.length === 1`)
  const allowRequest = await requestAt(0)
  assert.equal(allowRequest.messageId, 'approval-allow-rpc')
  assert.deepEqual(allowRequest.payload.result.value, { sessionId, approvalId: 'approval-allow', outcome: 'allowed-once' })
  assert.equal(await evaluate(`[...document.querySelectorAll('#sessionApproval button')].every(button => button.disabled)`), true)
  await answerRpc(allowRequest.messageId, { ok: true, value: { accepted: true } })
  assert.equal(await evaluate(`document.querySelector('#sessionApproval .approval-strip')?.textContent`), '等待审批')
  await inject('resolved-allow', { type: 'approval/resolved', sessionId, approvalId: 'approval-allow', outcome: 'allowed-once' })
  await waitFor(`document.getElementById('sessionApproval').classList.contains('hidden')`)

  await inject('approval-reject-rpc', {
    type: 'approval/requested', sessionId, approvalId: 'approval-reject', toolName: 'write_file', reason: '需要修改文件',
  })
  await waitFor(`document.querySelector('#sessionApproval button')`)
  await tapButton('拒绝')
  await waitFor(`window.__dshE2ERequests.length === 2`)
  const failedReject = await requestAt(1)
  assert.equal(failedReject.payload.result.value.outcome, 'rejected')
  await answerRpc(failedReject.messageId, { ok: false, error: { code: 'e2e-rejected', message: 'E2E transport failure' } })
  await waitFor(`document.querySelector('#sessionApproval .approval-error')?.textContent.includes('E2E transport failure')`)
  assert.equal(await evaluate(`[...document.querySelectorAll('#sessionApproval button')].every(button => !button.disabled)`), true)
  await tapButton('拒绝')
  await waitFor(`window.__dshE2ERequests.length === 3`)
  const rejectRequest = await requestAt(2)
  assert.equal(rejectRequest.payload.result.value.outcome, 'rejected')
  await answerRpc(rejectRequest.messageId, { ok: true, value: { accepted: true } })
  await inject('resolved-reject', { type: 'approval/resolved', sessionId, approvalId: 'approval-reject', outcome: 'rejected' })
  await waitFor(`document.getElementById('sessionApproval').classList.contains('hidden')`)

  await inject('approval-priority-rpc', {
    type: 'approval/requested', sessionId, approvalId: 'approval-priority', toolName: 'shell_command', reason: '等待计划审查后处理',
  })
  const planQuestion = {
    type: 'question/requested', sessionId, questions: [{
      id: 'plan-review',
      question: 'Approve this plan and leave plan mode?',
      detail: '# E2E Plan\n\n- Run focused tests\n- Build the APK',
      options: [
        { label: 'Approve', description: 'Execute the plan.' },
        { label: 'Keep planning', description: 'Continue revising.' },
      ],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }],
  }
  await inject('question-approve-rpc', planQuestion)
  await waitFor(`document.querySelector('#sessionApproval .approval-strip')?.textContent === '计划待审'`)
  assert.deepEqual(await evaluate(`(() => ({
    labels: [...document.querySelectorAll('#sessionApproval button')].map(button => button.textContent.trim()),
    heading: document.querySelector('#sessionApproval .plan-review-body h1')?.textContent,
    noOverflow: document.getElementById('sessionApproval').scrollWidth <= document.getElementById('sessionApproval').clientWidth + 1,
  }))()`), { labels: ['去聊天里说', '拒绝', '确认执行'], heading: 'E2E Plan', noOverflow: true })
  if (process.env.DSH_E2E_SCREENSHOT) {
    const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(process.env.DSH_E2E_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
  }
  await tapButton('确认执行')
  await waitFor(`window.__dshE2ERequests.length === 4`)
  const approvePlan = await requestAt(3)
  assert.deepEqual(approvePlan.payload.result.value, {
    sessionId, answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] },
  })
  await answerRpc(approvePlan.messageId, { ok: true, value: { accepted: true } })
  assert.equal(await evaluate(`[...document.querySelectorAll('#sessionApproval button')].every(button => button.disabled)`), true)
  await inject('resolved-question-approve', {
    type: 'question/resolved', sessionId, questionRpcId: 'question-approve-rpc', outcome: 'answered',
  })
  await waitFor(`document.querySelector('#sessionApproval .approval-strip')?.textContent === '等待审批'`)
  await inject('resolved-priority-approval', {
    type: 'approval/resolved', sessionId, approvalId: 'approval-priority', outcome: 'rejected',
  })

  await inject('question-decline-rpc', planQuestion)
  await waitFor(`document.querySelector('#sessionApproval .approval-strip')?.textContent === '计划待审'`)
  await tapButton('拒绝')
  await waitFor(`window.__dshE2ERequests.length === 5`)
  const declinePlan = await requestAt(4)
  assert.deepEqual(declinePlan.payload.result.value.answer.answers, [{ id: 'plan-review', selected: ['Keep planning'] }])
  await answerRpc(declinePlan.messageId, { ok: true, value: { accepted: true } })
  await inject('resolved-question-decline', {
    type: 'question/resolved', sessionId, questionRpcId: 'question-decline-rpc', outcome: 'answered',
  })

  await inject('question-discuss-rpc', planQuestion)
  await waitFor(`document.querySelector('#sessionApproval .approval-strip')?.textContent === '计划待审'`)
  await tapButton('去聊天里说')
  await waitFor(`window.__dshE2ERequests.length === 6`)
  const discussPlan = await requestAt(5)
  assert.deepEqual(discussPlan.payload.result, {
    ok: false,
    error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
  })
  await answerRpc(discussPlan.messageId, { ok: true, value: { accepted: true } })
  await inject('resolved-question-discuss', {
    type: 'question/resolved', sessionId, questionRpcId: 'question-discuss-rpc', outcome: 'cancelled',
  })

  await inject('question-generic-rpc', {
    type: 'question/requested', sessionId, questions: [{
      id: 'generic', question: 'Choose an environment', options: [{ label: 'Staging' }, { label: 'Production' }],
    }],
  })
  await waitFor(`document.querySelector('#sessionApproval .approval-strip')?.textContent === '需要电脑处理'`)
  assert.deepEqual(await evaluate(`(() => ({
    notice: document.getElementById('sessionApproval').textContent.includes('请在电脑端继续'),
    buttonCount: document.querySelectorAll('#sessionApproval button').length,
  }))()`), { notice: true, buttonCount: 0 })
  await inject('resolved-question-generic', {
    type: 'question/resolved', sessionId, questionRpcId: 'question-generic-rpc', outcome: 'answered',
  })

  console.log(JSON.stringify({
    ok: true,
    toolApproval: ['allowed-once', 'rejected'],
    planReview: ['Approve', 'Keep planning', 'cancelled'],
    authoritativeResolution: true,
    genericQuestionDesktopNotice: true,
  }))
} finally {
  try {
    if (initScript?.identifier) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript.identifier })
    await send('Page.reload', { ignoreCache: true })
  } finally {
    socket.close()
  }
}
