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

await send('Runtime.enable')
await evaluate(`(() => {
  const settings = document.getElementById('settingsDialog')
  if (!settings.open) document.getElementById('settingsButton').click()
  document.getElementById('scanQrButton').click()
})()`)
await new Promise(resolve => setTimeout(resolve, 1800))

const result = await evaluate(`(() => ({
  scanOpen: document.getElementById('scanDialog').open,
  status: document.getElementById('scanStatus').textContent,
  credentialInputs: document.querySelectorAll('#settingsDialog input:not([type=file])').length,
  brandSrc: document.querySelector('.brand-mark img')?.getAttribute('src'),
  jsQrType: typeof window.jsQR
}))()`)

assert.equal(result.scanOpen, true)
assert.equal(result.credentialInputs, 0)
assert.equal(result.brandSrc, 'remote-link.svg')
assert.equal(result.jsQrType, 'function')
assert.doesNotMatch(result.status, /解码器加载失败|扫码仅在 Android App 内可用/)

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
  assert.match(imageResult.status, /二维码无效、已过期，或不属于当前 Relay/)
  result.imageDecode = 'recognized-and-rejected-by-native-validator'
}

socket.close()
console.log(JSON.stringify({ ...result, status: result.status.replace(/\s+/g, ' ').trim() }))
