import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const base = process.env.DSH_COMPAT_BASE ?? 'http://127.0.0.1:3088'
assert.equal(new URL(base).hostname, '127.0.0.1', 'Only a loopback test Host is permitted')
const workspace = process.env.DSH_COMPAT_WORKSPACE
assert.ok(workspace?.includes('dsh-api-migration'), 'Use the isolated compatibility workspace')
await mkdir(workspace, { recursive: true })
const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
const denied = await post('/m/api/session.list', { rpcId: 'unpaired', payload: {} })
assert.equal(denied.status, 403)
const issued = await (await post('/api/pair/issue', {})).json()
assert.ok(issued.token)
const accepted = await post('/api/pair/accept', { token: issued.token })
const cookie = accepted.headers.get('set-cookie')?.split(';')[0]
assert.ok(cookie)
let ordinal = 0
async function rpc(method, payload = {}) {
  const response = await post('/m/api/' + method, { rpcId: 'compat-' + ++ordinal, payload }, cookie)
  const envelope = await response.json()
  assert.equal(response.status, 200, method)
  assert.equal(envelope.result?.ok, true, method + ': ' + JSON.stringify(envelope.result?.error))
  return envelope.result.value
}
const catalog = await rpc('session.models')
assert.ok(catalog.groups.some(group => group.id === 'compat-fixture'), 'Refuse a real paid provider')
const created = await rpc('session.create', { cwd: workspace })
const sessionId = created.sessionId
await rpc('session.selectModel', { sessionId, provider: 'compat-fixture', model: 'fixture' })
assert.equal((await rpc('session.models', { sessionId })).current.provider, 'compat-fixture', 'Selected model must survive a reread')
const title = '兼容验收 Unicode \u{1f642}'
assert.equal((await rpc('session.rename', { sessionId, title })).title, title)
const frames = []
const abort = new AbortController()
let endTurn
const finished = new Promise(resolve => { endTurn = resolve })
const stream = (async () => {
  const response = await fetch(base + '/m/api/events.mux', { headers: { cookie }, signal: abort.signal })
  assert.equal(response.status, 200)
  let pending = ''
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true })
    const events = pending.split('\n\n'); pending = events.pop() ?? ''
    for (const event of events) {
      if (!event.startsWith('data: ')) continue
      const frame = JSON.parse(event.slice(6)); frames.push(frame)
      if (frame.payload?.event?.type === 'turn/end') endTurn()
    }
  }
})()
stream.catch(() => {})
try {
  await rpc('session.history', { sessionId, maxMessages: 12 })
  const original = '原值验收：张三 13800138000 110101199001011234 北京市朝阳区测试地址 Unicode \u{1f642}'
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: original }] })
  await Promise.race([finished, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('No live turn/end; frames=' + JSON.stringify(frames.map(f => f.payload?.type)))), 20000); timer.unref() })])
  const history = await rpc('session.history', { sessionId, maxMessages: 12 })
  assert.ok(JSON.stringify(history).includes(original), 'User text must survive actual Host history')
  assert.ok(JSON.stringify(history).includes('兼容验收通过 Unicode'), 'Assistant reply must survive actual Host history')
  assert.ok(frames.some(frame => JSON.stringify(frame).includes('兼容验收通过 Unicode')), 'Reply must arrive over live SSE')
  console.log(JSON.stringify({ status: 'PASS', sessionId, frames: frames.length, methods: ['pair', 'session.create', 'session.selectModel', 'session.rename', 'session.prompt', 'session.history', 'events.mux'], fidelity: 'exact', provider: 'local-fixture' }))
} finally { abort.abort(); await stream.catch(() => {}) }
