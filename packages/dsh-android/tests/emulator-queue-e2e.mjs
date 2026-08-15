import assert from 'node:assert/strict'

assert.equal(process.env.DSH_ALLOW_MODEL_E2E, '1', 'Set DSH_ALLOW_MODEL_E2E=1 to allow the real-model queue test')

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

async function waitFor(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

async function submit(text) {
  await evaluate(`(() => {
    const input = document.getElementById('promptInput')
    input.value = ${JSON.stringify(text)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('sendPrompt').click()
  })()`)
  await waitFor(`!document.getElementById('sendPrompt').disabled`)
}

await send('Runtime.enable')
await evaluate(`(() => {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()
  if (!document.getElementById('controlSheet').hidden) document.getElementById('closeSheet').click()
  if (!document.getElementById('directoryBrowser').hidden) document.getElementById('closeDirectory').click()
  if (!document.getElementById('sessionPage').hidden) {
    if (!document.getElementById('cancelSession').disabled) document.getElementById('cancelSession').click()
    document.getElementById('closeSession').click()
  }
  document.querySelector('[data-view="tasks"]').click()
  document.getElementById('newSession').click()
})()`)
await waitFor(`!document.getElementById('controlSheet').hidden`)
await evaluate(`document.querySelector('#sheetList .sheet-option').click()`)
await waitFor(`!document.getElementById('sessionPage').hidden`, 20_000)
await waitFor(`document.getElementById('composerStatus').textContent.includes('当前空闲')`, 20_000)

await submit('E2E 队列验收：请输出 1 到 1200 的编号清单，每项一行短句，不调用工具。')
await waitFor(`document.getElementById('composerStatus').textContent.includes('正在运行')`, 20_000)
await submit('E2E queue A：当前轮次结束后只回复 A。')
await submit('E2E queue B：当前轮次结束后只回复 B。')
await submit('E2E queue C：当前轮次结束后只回复 C。')
await waitFor(`Number.parseInt(document.getElementById('queueCount').textContent, 10) >= 3`, 20_000)

const compactQueue = await evaluate(`(() => {
  const toggle = document.getElementById('toggleQueue')
  const list = document.getElementById('queueList')
  const collapsedByDefault = list.hidden && toggle.getAttribute('aria-expanded') === 'false'
  toggle.click()
  const row = list.querySelector('.queue-item')
  const actions = [...row.querySelectorAll('.queue-icon-action')]
  return {
    collapsedByDefault,
    expanded: !list.hidden && toggle.getAttribute('aria-expanded') === 'true',
    singleLine: getComputedStyle(row.querySelector('.queue-item-title')).whiteSpace === 'nowrap',
    actionLabels: actions.map(button => button.getAttribute('aria-label')),
    accessibleActions: actions.every(button => button.title && button.textContent.trim() === ''),
  }
})()`)
assert.deepEqual(compactQueue, {
  collapsedByDefault: true,
  expanded: true,
  singleLine: true,
  actionLabels: ['编辑排队消息', '删除排队消息', '上移排队消息', '下移排队消息', '立即引导当前轮次'],
  accessibleActions: true,
})

const initialQueueCount = await evaluate(`document.querySelectorAll('#queueList .queue-item').length`)
const editStarted = await evaluate(`(() => {
  document.querySelector('#queueList .queue-item [aria-label="编辑排队消息"]').click()
  const editor = document.querySelector('#queueList .queue-editor')
  if (!editor) return false
  editor.value = editor.value + ' 已编辑'
  editor.dispatchEvent(new Event('input', { bubbles: true }))
  const save = document.querySelector('#queueList .queue-edit-actions [aria-label="保存排队消息"]')
  if (!save) return false
  save.click()
  return true
})()`)
assert.equal(editStarted, true)
await waitFor(`!document.querySelector('#queueList .queue-editor') && document.querySelector('#queueList .queue-item-title')?.textContent.includes('已编辑')`, 20_000)

await evaluate(`(() => {
  const rows = [...document.querySelectorAll('#queueList .queue-item')]
  window.__dshQueueSecond = rows[1].querySelector('.queue-item-title').textContent
  rows[1].querySelector('[aria-label="上移排队消息"]').click()
})()`)
await waitFor(`document.querySelector('#queueList .queue-item-title')?.textContent === window.__dshQueueSecond`, 20_000)

const beforeDelete = await evaluate(`document.querySelectorAll('#queueList .queue-item').length`)
await evaluate(`(() => {
  const rows = [...document.querySelectorAll('#queueList .queue-item')]
  rows.at(-1).querySelector('[aria-label="删除排队消息"]').click()
})()`)
await waitFor(`document.querySelectorAll('#queueList .queue-item').length === ${beforeDelete - 1}`, 20_000)

await waitFor(`!document.getElementById('cancelSession').disabled`, 20_000)
const beforeSteer = await evaluate(`document.querySelectorAll('#queueList .queue-item').length`)
await evaluate(`(() => {
  const first = document.querySelector('#queueList .queue-item')
  first.querySelector('[aria-label="立即引导当前轮次"]').click()
})()`)
await waitFor(`document.querySelectorAll('#queueList .queue-item').length === ${beforeSteer - 1}`, 20_000)
assert.equal(await evaluate(`document.getElementById('sessionMeta').textContent.includes('转为引导')`), true)
const finalQueueCount = await evaluate(`document.querySelectorAll('#queueList .queue-item').length`)
assert.ok(initialQueueCount >= 3)
assert.equal(finalQueueCount, initialQueueCount - 2)

if (!await evaluate(`document.getElementById('cancelSession').disabled`)) {
  await evaluate(`document.getElementById('cancelSession').click()`)
  await waitFor(`document.getElementById('cancelSession').disabled`, 20_000)
}

assert.equal(await evaluate(`document.querySelector('.queue-editor') === null`), true)
await evaluate(`document.getElementById('closeSession').click()`)
socket.close()
console.log(JSON.stringify({
  ok: true,
  initialQueueCount,
  finalQueueCount,
  edit: true,
  reorder: true,
  steer: true,
  remove: true,
  cancel: true,
}))
