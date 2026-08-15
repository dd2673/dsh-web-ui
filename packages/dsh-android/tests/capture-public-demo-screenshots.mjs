import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const endpoint = process.argv[2] || 'http://127.0.0.1:9223'
const outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/public-assets')
const targetUrl = 'file:///android_asset/index.html'
const prohibitedText = /(?:https?:\/\/|wss?:\/\/|\b(?:token|secret|password|apikey)\b|[A-Za-z]:[\\/]|\\Users\\|\.ssh|BEGIN\s+(?:RSA|OPENSSH)|\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3})\b)/i

const targets = await fetch(`${endpoint}/json`).then(response => response.json())
const target = targets.find(item => item.type === 'page' && item.url === targetUrl)
assert.ok(target?.webSocketDebuggerUrl, 'Android WebView CDP target is unavailable')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true })
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
  return new Promise((resolveResult, reject) => pending.set(id, { resolve: resolveResult, reject }))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'WebView evaluation failed'
    throw new Error(detail)
  }
  return result.result?.value
}

async function capture(file, label) {
  const visibleText = await evaluate(`(() => {
    const visible = node => {
      const style = getComputedStyle(node)
      return !node.hidden && style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
    }
    return [...document.querySelectorAll('body *')]
      .filter(node => node.children.length === 0 && visible(node))
      .map(node => node.textContent.trim())
      .filter(Boolean)
      .join('\\n')
  })()`)
  assert.doesNotMatch(visibleText, prohibitedText, `${label} contains prohibited public data`)
  const dimensions = await evaluate(`({
    width: window.innerWidth,
    height: window.innerHeight,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    gitVisible: document.querySelector('[data-view="git"]').getClientRects().length > 0,
    sshVisible: document.querySelector('[data-view="ssh"]').getClientRects().length > 0,
  })`)
  assert.deepEqual(dimensions, { width: 360, height: 640, overflow: false, gitVisible: false, sshVisible: false }, `${label} layout is not publication-safe`)
  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const targetFile = resolve(outputDirectory, file)
  await mkdir(dirname(targetFile), { recursive: true })
  await writeFile(targetFile, Buffer.from(screenshot.data, 'base64'))
  return targetFile
}

// This only populates the APK's existing DOM with synthetic display data. It
// does not call the native bridge, click controls, open a socket, or invoke RPC.
const setupDemoDom = `(() => {
  const $ = id => document.getElementById(id)
  const text = (node, value) => { node.textContent = value; return node }
  const element = (tag, className, value) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (value !== undefined) node.textContent = value
    return node
  }
  const iconPaths = {
    edit: 'M3 12.5l.5-3 7.7-7.7a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4l-7.7 7.7-3 .5ZM9.8 3.2l3 3',
    remove: 'M3 4.5h10M6 4.5V2.8h4v1.7M4.3 4.5l.6 9h6.2l.6-9M6.5 7v4M9.5 7v4',
    up: 'M8 13V3M4.5 6.5 8 3l3.5 3.5',
    down: 'M8 3v10M4.5 9.5 8 13l3.5-3.5',
    steer: 'M3 13 13 3M6 3h7v7',
  }
  const queueIcon = name => {
    const svg = $('toggleQueue').querySelector('svg').cloneNode(true)
    svg.querySelector('path').setAttribute('d', iconPaths[name])
    return svg
  }
  const queueAction = (name, label) => {
    const button = element('button', 'queue-icon-action')
    button.type = 'button'
    button.setAttribute('aria-label', label)
    button.title = label
    button.append(queueIcon(name))
    return button
  }
  const setView = name => {
    document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === 'view-' + name))
    document.querySelectorAll('.bottom-nav button').forEach(node => node.classList.toggle('active', node.dataset.view === name))
  }
  const hideUnsupportedScope = () => {
    for (const name of ['git', 'ssh']) {
      const navItem = document.querySelector('[data-view="' + name + '"]')
      navItem.hidden = true
      navItem.style.display = 'none'
      $('view-' + name).hidden = true
    }
    document.querySelector('.bottom-nav').style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))'
  }
  const reset = () => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()
    $('controlSheet').hidden = true
    $('directoryBrowser').hidden = true
    $('sessionPage').hidden = true
    $('app').inert = false
    document.body.classList.remove('session-open')
    hideUnsupportedScope()
    $('hostLabel').textContent = '演示桌面'
    $('taskNotice').textContent = ''
    $('promptInput').value = ''
  }
  const sessionCard = (title, status) => {
    const wrapper = element('div', 'session-swipe')
    const actions = element('div', 'session-swipe-actions')
    actions.append(element('button', 'session-action pin', '置顶'), element('button', 'session-action delete', '删除'))
    const card = element('button', 'row-card')
    const top = element('div', 'row-top')
    top.append(element('span', 'row-title', title), element('span', 'pill' + (status === '运行中' ? ' running' : ''), status))
    card.append(top, element('div', 'row-meta', '演示工作区 · 刚刚'))
    wrapper.append(actions, card)
    return wrapper
  }
  const taskGroup = () => {
    const section = element('section', 'task-group')
    const head = element('div', 'task-group-head')
    const toggle = element('button', 'task-group-toggle')
    toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'true')
    toggle.append(element('span', 'task-group-title', '演示工作区'), element('span', 'task-group-count', '3 个会话'))
    const rows = element('div', 'stack')
    rows.append(sessionCard('移动端界面验收', '运行中'), sessionCard('发布说明整理', '空闲'), sessionCard('队列交互检查', '空闲'))
    head.append(toggle); section.append(head, rows)
    return section
  }
  const showStatus = () => {
    reset(); setView('status')
    $('connectionDot').className = 'dot on'
    text($('connectionText'), '已连接演示桌面')
    text($('runtimeTitle'), 'DeepSeek 运行中')
    text($('runtimeDetail'), '这是合成演示状态，不包含地址、设备标识或凭据。')
    text($('agentState'), '就绪')
    text($('runningCount'), '1')
    document.querySelector('#view-status .section').style.display = 'none'
    const recent = $('recentTasks')
    recent.className = 'stack'
    recent.replaceChildren(sessionCard('移动端界面验收', '运行中'))
  }
  const showNewSessionSheet = () => {
    reset(); setView('tasks')
    const tasks = $('taskList')
    tasks.className = 'task-groups'
    tasks.replaceChildren(taskGroup())
    text($('sheetTitle'), '选择新会话的工作目录')
    text($('sheetHint'), '可选择现有工作区，或浏览电脑上的其他目录。')
    const list = $('sheetList')
    list.replaceChildren()
    for (const [name, detail, current] of [
      ['演示工作区', '创建新会话', true],
      ['浏览电脑目录', '选择后再创建', false],
    ]) {
      const option = element('button', 'sheet-option' + (current ? ' current' : ''))
      option.type = 'button'
      option.append(element('strong', '', name), element('small', '', detail))
      list.append(option)
    }
    $('controlSheet').hidden = false
  }
  const message = (kind, value) => element('article', 'message ' + kind, value)
  const showSessionQueue = () => {
    reset()
    $('sessionPage').hidden = false
    $('app').inert = true
    document.body.classList.add('session-open')
    text($('sessionTitle'), '移动端界面验收')
    text($('sessionMeta'), '演示工作区')
    $('historyList').replaceChildren(
      message('user', '请检查窄屏布局，并尽量保留更多对话上下文。'),
      message('assistant', '已将排队消息压缩为单行，完整内容仅在编辑时显示。'),
      message('user', '继续验证输入框的单行到五行扩展。'),
    )
    $('queuePanel').hidden = false
    $('toggleQueue').hidden = false
    $('toggleQueue').setAttribute('aria-expanded', 'true')
    $('toggleQueue').setAttribute('aria-label', '收起排队消息')
    text($('queueCount'), '3 条排队消息')
    const list = $('queueList')
    list.hidden = false
    list.replaceChildren()
    for (const value of ['继续检查窄屏布局与可读性，保持列表紧凑...', '...', '...']) {
      const row = element('article', 'queue-item')
      const title = element('span', 'queue-item-title', value)
      const actions = element('div', 'queue-item-actions')
      if (value !== '...') actions.append(
        queueAction('edit', '编辑排队消息'),
        queueAction('remove', '删除排队消息'),
        queueAction('up', '上移排队消息'),
        queueAction('down', '下移排队消息'),
        queueAction('steer', '立即引导当前轮次'),
      )
      row.append(title, actions); list.append(row)
    }
    text($('composerStatus'), '正在运行 · 新消息将排队')
    text($('workspaceButton'), '演示工作区')
    text($('presetButton'), 'Agent 模式')
    text($('sendModeButton'), '排队')
    $('cancelSession').disabled = false
  }
  window.__dshPublicDemo = { showStatus, showNewSessionSheet, showSessionQueue }
})()`

try {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 360,
    height: 640,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 360,
    screenHeight: 640,
  })
  await evaluate(setupDemoDom)
  const files = []
  for (const [method, file, label] of [
    ['showStatus', 'android-status-demo-360x640.png', 'status'],
    ['showNewSessionSheet', 'android-new-session-demo-360x640.png', 'new-session-sheet'],
    ['showSessionQueue', 'android-composer-queue-demo-360x640.png', 'composer-queue'],
  ]) {
    await evaluate(`window.__dshPublicDemo.${method}()`)
    await new Promise(resolveWait => setTimeout(resolveWait, 150))
    files.push(await capture(file, label))
  }
  console.log(JSON.stringify({ ok: true, synthetic: true, componentSource: 'installed-android-apk', size: '360x640', files }))
} finally {
  try {
    await send('Emulation.clearDeviceMetricsOverride')
  } finally {
    socket.close()
  }
}
