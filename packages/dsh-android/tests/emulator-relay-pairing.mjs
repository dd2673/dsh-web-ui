import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

assert.equal(
  process.env.DSH_CONFIRM_RELAY_ROTATION,
  '1',
  'set DSH_CONFIRM_RELAY_ROTATION=1 because this test replaces the active single-device binding epoch',
)

const relayControl = process.argv[2] || 'http://127.0.0.1:3080'
const cdpEndpoint = process.argv[3] || 'http://127.0.0.1:9223'
const response = await fetch(`${relayControl}/api/remote-web-ui/relay-token/rotate`, { method: 'POST' })
const envelope = await response.json()
assert.equal(response.ok, true, `relay token rotation failed with HTTP ${response.status}`)
assert.equal(envelope?.ok, true, `relay token rotation failed: ${String(envelope?.error || 'unknown')}`)
assert.equal(typeof envelope?.value?.pairingUri, 'string')

const require = createRequire(new URL('../../dsh-remote-web-ui/package.json', import.meta.url))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { QRCodeSVG } = require('qrcode.react')
const qrSvg = renderToStaticMarkup(React.createElement(QRCodeSVG, {
  value: envelope.value.pairingUri,
  size: 320,
  level: 'M',
  marginSize: 2,
})).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')

const targets = await fetch(`${cdpEndpoint}/json`).then(value => value.json())
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

await send('Runtime.enable')
const result = await evaluate(`(async () => {
  const scan = document.getElementById('scanDialog')
  if (scan.open) scan.close()
  const settings = document.getElementById('settingsDialog')
  if (!settings.open) document.getElementById('settingsButton').click()
  document.getElementById('scanQrButton').click()
  await new Promise(resolve => setTimeout(resolve, 500))

  const file = new File([${JSON.stringify(qrSvg)}], 'relay-pairing.svg', { type: 'image/svg+xml' })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  const input = document.getElementById('scanImageInput')
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))

  const scanDeadline = Date.now() + 10000
  while (scan.open && Date.now() < scanDeadline) await new Promise(resolve => setTimeout(resolve, 100))
  const relayDeadline = Date.now() + 20000
  while (document.getElementById('connectionText').textContent !== 'relay 已鉴权' && Date.now() < relayDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!settings.open) {
    document.getElementById('settingsButton').click()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  let nativeSummary = { configured: false }
  try {
    const config = JSON.parse(window.DshRemoteNative.loadConfig() || '{}')
    nativeSummary = {
      configured: Boolean(config.relay && config.hostId && config.token),
      hostId: typeof config.hostId === 'string' ? config.hostId : '',
      relayProtocol: typeof config.relay === 'string' ? new URL(config.relay).protocol : '',
      tokenLength: typeof config.token === 'string' ? config.token.length : 0,
    }
  } catch (_) {}
  return {
    scanOpen: scan.open,
    scanStatus: document.getElementById('scanStatus').textContent,
    bindingStatus: document.getElementById('bindingStatus').textContent,
    connectionText: document.getElementById('connectionText').textContent,
    nativeSummary,
  }
})()`)

socket.close()
assert.equal(result.scanOpen, false, `pairing image was rejected locally: ${result.scanStatus}`)
assert.match(result.bindingStatus, /^已绑定：/)
assert.equal(result.connectionText, 'relay 已鉴权')
assert.equal(result.nativeSummary.configured, true)
console.log(JSON.stringify(result))
