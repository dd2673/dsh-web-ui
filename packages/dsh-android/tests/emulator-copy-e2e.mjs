import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const endpoint = process.argv[2] || 'http://127.0.0.1:9223'
const adb = process.env.DSH_ADB || 'adb'
const expected = 'E2E_MODEL_COPY\n\n**完整 Markdown**\n\n```js\nconst copied = true\n```'
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
  throw new Error(`Timed out waiting for: ${expression}`)
}

async function tap(selector) {
  const point = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    node?.scrollIntoView({ block: 'center' })
    const rect = node?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, `tap target is unavailable: ${selector}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
}

await send('Runtime.enable')
await send('Page.enable')
const fakeRelaySource = String.raw`
(() => {
  const workspace = { workspaceId: 'copy-workspace', path: 'C:\\e2e\\copy', title: 'Copy Workspace', sessionIds: ['copy-session'] }
  const session = { sessionId: 'copy-session', workspaceId: workspace.workspaceId, cwd: workspace.path, title: 'Copy Session', running: false }
  class FakeWebSocket extends EventTarget {
    static OPEN = 1
    readyState = 0
    constructor() {
      super()
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
            methods: ['workspace.list', 'session.list', 'session.history', 'session.models'],
          })
        })
        return
      }
      if (frame.type === 'stream.subscribe') return
      if (frame.type !== 'rpc.request') return
      if (frame.method === 'workspace.list') this.reply(frame, { items: [workspace], archivedSessionIds: [] })
      else if (frame.method === 'session.list') this.reply(frame, { items: [session] })
      else if (frame.method === 'session.history') this.reply(frame, {
        events: [{ event: { seq: 1, type: 'assistant/message', data: { message: { id: 'e2e-copy', content: [{ type: 'text', text: ${JSON.stringify(expected)} }] } } } }],
        projections: { values: { permissions: { currentValue: 'danger-full-access', options: [] } } },
      })
      else if (frame.method === 'session.models') this.reply(frame, {
        current: { provider: 'deepseek', model: 'v4-flash' },
        groups: [{ id: 'deepseek', models: [{ id: 'v4-flash', name: 'DeepSeek V4 Flash' }] }],
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
  await waitFor(`document.querySelector('#taskList .session-swipe .row-card')`)
  await evaluate(`document.querySelector('#taskList .session-swipe .row-card').click()`)
  await waitFor(`document.querySelectorAll('.message.assistant .message-copy').length === 1`)
  await waitFor(`document.getElementById('modelButton').textContent.trim() !== '模型'`)

  const layout = await evaluate(`(() => {
    const button = document.querySelector('.message.assistant .message-copy')
    const rect = button.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      label: button.getAttribute('aria-label'),
      visibleText: button.textContent,
      horizontalOverflow: document.getElementById('sessionPage').scrollWidth > window.innerWidth + 1,
    }
  })()`)
  assert.deepEqual(layout, {
    width: 28,
    height: 28,
    label: '复制模型回复',
    visibleText: '',
    horizontalOverflow: false,
  })

  const composerActions = await evaluate(`(() => {
    const row = document.querySelector('.composer-actions')
    const rowRect = row.getBoundingClientRect()
    const buttons = [...row.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0)
    const rects = buttons.map(button => button.getBoundingClientRect())
    return {
      count: buttons.length,
      oneRow: rects.every(rect => Math.abs(rect.top - rects[0].top) <= 1),
      equalHeight: rects.every(rect => Math.abs(rect.height - 26) <= 1),
      noOverflow: row.scrollWidth <= row.clientWidth + 1 && rects.at(-1).right <= rowRect.right + 1,
      iconOnly: ['attachmentButton', 'cancelSession', 'sendPrompt'].every(id => {
        const button = document.getElementById(id)
        return button.textContent.trim() === '' && Boolean(button.querySelector('svg')) && Boolean(button.getAttribute('aria-label'))
      }),
      permission: document.getElementById('permissionButton').textContent.trim(),
      model: document.getElementById('modelButton').textContent.trim(),
    }
  })()`)
  assert.ok(composerActions.count >= 7 && composerActions.count <= 8)
  assert.equal(composerActions.oneRow, true)
  assert.equal(composerActions.equalHeight, true)
  assert.equal(composerActions.noOverflow, true)
  assert.equal(composerActions.iconOnly, true)
  assert.equal(composerActions.permission, '全权限')
  assert.equal(composerActions.model, 'V4 Flash')

  await tap('.message.assistant .message-copy')
  await waitFor(`document.querySelector('.message-copy').dataset.state === 'copied'`)
  await evaluate(`(() => {
    const input = document.getElementById('promptInput')
    input.value = ''
  })()`)
  await tap('#promptInput')
  await new Promise(resolve => setTimeout(resolve, 250))
  await promisify(execFile)(adb, ['shell', 'input', 'keyevent', '279'])
  await waitFor(`document.getElementById('promptInput').value.length > 0`)
  assert.equal(await evaluate(`document.getElementById('promptInput').value`), expected)
  if (process.env.DSH_E2E_SCREENSHOT) {
    await evaluate(`(() => {
      const input = document.getElementById('promptInput')
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.message.assistant').scrollIntoView({ block: 'center' })
    })()`)
    const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(process.env.DSH_E2E_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
  }

  console.log(JSON.stringify({ ok: true, iconOnly: true, copiedFullMarkdown: true, size: '28x28', composerActions }))
} finally {
  try {
    if (initScript?.identifier) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript.identifier })
    await send('Page.reload', { ignoreCache: true })
  } finally {
    socket.close()
  }
}
