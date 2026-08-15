import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

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

await send('Runtime.enable')
const inspectOnly = process.env.DSH_INSPECT_ONLY === '1'
await evaluate(`(() => {
  const scan = document.getElementById('scanDialog')
  if (${inspectOnly} && scan.open) scan.close()
  const settings = document.getElementById('settingsDialog')
  if (!settings.open) document.getElementById('settingsButton').click()
  if (!${inspectOnly}) document.getElementById('scanQrButton').click()
})()`)
await new Promise(resolve => setTimeout(resolve, 1800))

const result = await evaluate(`(() => {
  let nativeSummary = { configured: false }
  try {
    const config = JSON.parse(window.DshRemoteNative?.loadConfig?.() || '{}')
    nativeSummary = {
      configured: Boolean(config.relay && config.hostId && config.token),
      hostId: typeof config.hostId === 'string' ? config.hostId : '',
      relayProtocol: typeof config.relay === 'string' ? new URL(config.relay).protocol : '',
      tokenLength: typeof config.token === 'string' ? config.token.length : 0,
    }
  } catch (_) {}
  return {
    scanOpen: document.getElementById('scanDialog').open,
    status: document.getElementById('scanStatus').textContent,
    bindingStatus: document.getElementById('bindingStatus').textContent,
    connectionText: document.getElementById('connectionText').textContent,
    credentialInputs: document.querySelectorAll('#settingsDialog input:not([type=file])').length,
    brandSrc: document.querySelector('.brand-mark img')?.getAttribute('src'),
    jsQrType: typeof window.jsQR,
    nativeSummary,
  }
})()`)

assert.equal(result.scanOpen, !inspectOnly)
assert.equal(result.credentialInputs, 0)
assert.equal(result.brandSrc, 'remote-link.svg')
assert.equal(result.jsQrType, 'function')
if (!inspectOnly) assert.doesNotMatch(result.status, /解码器加载失败|扫码仅在 Android App 内可用/)

if (process.env.DSH_TEST_QR_SVG_B64) {
  const qrSvg = Buffer.from(process.env.DSH_TEST_QR_SVG_B64, 'base64').toString('utf8')
  const imageResult = await evaluate(`(async () => {
    const svg = ${JSON.stringify(qrSvg)}.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
    const file = new File([svg], 'safe-test-qr.svg', { type: 'image/svg+xml' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.getElementById('scanImageInput')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 1200))
    return { status: document.getElementById('scanStatus').textContent, scanOpen: document.getElementById('scanDialog').open }
  })()`)
  assert.equal(imageResult.scanOpen, true)
  assert.match(imageResult.status, /二维码格式无效，或配对链接与 Relay 域名不一致/)
  result.imageDecode = 'recognized-and-rejected-by-native-validator'
}

if (process.env.DSH_TEST_QR_IMAGE_PATH) {
  const imagePath = process.env.DSH_TEST_QR_IMAGE_PATH
  const imageBase64 = (await readFile(imagePath)).toString('base64')
  const imageType = extname(imagePath).toLowerCase() === '.jpg' || extname(imagePath).toLowerCase() === '.jpeg'
    ? 'image/jpeg'
    : 'image/png'
  const pairingResult = await evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(imageBase64)}), character => character.charCodeAt(0))
    const file = new File([bytes], 'pairing-acceptance.${imageType === 'image/jpeg' ? 'jpg' : 'png'}', { type: ${JSON.stringify(imageType)} })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.getElementById('scanImageInput')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const deadline = Date.now() + 10000
    while (document.getElementById('scanDialog').open && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
    if (!document.getElementById('scanDialog').open && !document.getElementById('settingsDialog').open) {
      document.getElementById('settingsButton').click()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return {
      scanOpen: document.getElementById('scanDialog').open,
      scanStatus: document.getElementById('scanStatus').textContent,
      bindingStatus: document.getElementById('bindingStatus').textContent,
      connectionText: document.getElementById('connectionText').textContent,
      hostLabel: document.getElementById('hostLabel').textContent,
    }
  })()`)
  assert.equal(pairingResult.scanOpen, false, `pairing image was rejected locally: ${pairingResult.scanStatus}`)
  assert.match(pairingResult.bindingStatus, /^已绑定：/)
  result.pairingImage = pairingResult
}

socket.close()
console.log(JSON.stringify({ ...result, status: result.status.replace(/\s+/g, ' ').trim() }))
