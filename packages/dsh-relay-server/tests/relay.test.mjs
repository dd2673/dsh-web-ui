import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { createRelayServer } from '../src/server.mjs'

const secret = () => randomBytes(32).toString('base64url')

async function open(url, hello, expectAck = true) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const acknowledged = expectAck ? next(socket, message => message.type === 'hello.ack') : undefined
  socket.send(JSON.stringify(hello))
  if (acknowledged !== undefined) socket.helloAck = await acknowledged
  return socket
}

async function provision(url, config, deviceToken, pairingExpiresAt = Date.now() + 5 * 60_000) {
  const host = await open(url, { v: 1, type: 'hello', role: 'host', hostId: config.hostId, token: config.hostToken })
  await syncCredential(host, deviceToken, 'credential-1', pairingExpiresAt)
  return host
}

async function syncCredential(host, deviceToken, messageId, pairingExpiresAt = Date.now() + 5 * 60_000) {
  const synced = next(host, message => message.type === 'ack' && message.messageId === messageId)
  host.send(JSON.stringify({
    v: 1,
    type: 'credential.sync',
    messageId,
    tokenSha256: createHash('sha256').update(deviceToken).digest('hex'),
    pairingExpiresAt,
  }))
  await synced
}

function next(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 2_000)
    const listener = event => {
      const value = JSON.parse(event.data)
      if (!predicate(value)) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      resolve(value)
    }
    socket.addEventListener('message', listener)
  })
}

test('routes device rpc to host and response back to the device', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const url = `ws://127.0.0.1:${address.port}/relay`
  const deviceToken = secret()
  const host = await provision(url, config, deviceToken)
  const device = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: deviceToken })
  t.after(() => { host.close(); device.close() })
  device.send(JSON.stringify({ v: 1, type: 'rpc.request', messageId: 'm1', method: 'workspace.list', payload: {} }))
  const request = await next(host, message => message.type === 'rpc.request')
  assert.equal(request.deviceId, 'phone-1')
  host.send(JSON.stringify({ v: 1, type: 'rpc.response', deviceId: 'phone-1', messageId: 'm1', payload: { ok: true } }))
  const response = await next(device, message => message.type === 'rpc.response')
  assert.deepEqual(response.payload, { ok: true })
})

test('forwards bounded rpc chunks to the authenticated host', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const url = `ws://127.0.0.1:${address.port}/relay`
  const deviceToken = secret()
  const host = await provision(url, config, deviceToken)
  const device = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: deviceToken })
  t.after(() => { host.close(); device.close() })
  const received = next(host, message => message.type === 'rpc.request.chunk')
  device.send(JSON.stringify({ v: 1, type: 'rpc.request.chunk', messageId: 'large-1', method: 'session.prompt', chunkIndex: 0, chunkCount: 2, data: '{"sessionId":' }))
  const chunk = await received
  assert.equal(chunk.deviceId, 'phone-1')
  assert.equal(chunk.data, '{"sessionId":')
})

test('replays the current host capabilities to a device that connects later', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const url = `ws://127.0.0.1:${address.port}/relay`
  const pairingToken = secret()
  const host = await provision(url, config, pairingToken)
  host.send(JSON.stringify({ v: 1, type: 'capabilities', methods: ['workspace.list', 'session.list'] }))

  const device = new WebSocket(url)
  const received = []
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 2_000)
    device.addEventListener('message', event => {
      received.push(JSON.parse(event.data))
      if (received.some(message => message.type === 'hello.ack') && received.some(message => message.type === 'capabilities')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  await new Promise((resolve, reject) => {
    device.addEventListener('open', resolve, { once: true })
    device.addEventListener('error', reject, { once: true })
  })
  device.send(JSON.stringify({ v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-late', token: pairingToken }))
  await ready
  t.after(() => { host.close(); device.close() })
  assert.deepEqual(received.find(message => message.type === 'capabilities')?.methods, ['workspace.list', 'session.list'])
})

test('rejects an invalid device token', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const url = `ws://127.0.0.1:${address.port}/relay`
  const host = await provision(url, config, secret())
  t.after(() => host.close())
  const socket = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'bad', token: secret() }, false)
  const close = await new Promise(resolve => socket.addEventListener('close', resolve, { once: true }))
  assert.equal(close.code, 4003)
})

test('rejects an unknown hello role even when it presents the device pairing bearer', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const url = `ws://127.0.0.1:${address.port}/relay`
  const pairingToken = secret()
  const host = await provision(url, config, pairingToken)
  t.after(() => host.close())
  const attacker = await open(url, { v: 1, type: 'hello', role: 'attacker', hostId: 'desktop', token: pairingToken }, false)
  const close = await new Promise(resolve => attacker.addEventListener('close', resolve, { once: true }))
  assert.equal(close.code, 4003)
})

test('delivers a queued lifecycle command to the low-power agent poll', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const base = `http://127.0.0.1:${address.port}`
  const deviceToken = secret()
  const url = `ws://127.0.0.1:${address.port}/relay`
  const host = await provision(url, config, deviceToken)
  const device = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: deviceToken })
  t.after(() => { host.close(); device.close() })
  const acknowledged = next(device, message => message.type === 'ack' && message.messageId === 'life-1')
  device.send(JSON.stringify({ v: 1, type: 'lifecycle.request', messageId: 'life-1', action: 'start' }))
  assert.equal((await acknowledged).state, 'queued')
  const polled = await fetch(`${base}/v1/agent/poll`, { headers: { authorization: `Bearer ${config.agentToken}` } })
  const body = await polled.json()
  assert.equal(body.command.action, 'start')
  assert.equal(body.command.messageId, 'life-1')
})

test('wakes an agent that started long-polling before the lifecycle request', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const base = `http://127.0.0.1:${address.port}`
  const url = `ws://127.0.0.1:${address.port}/relay`
  const deviceToken = secret()
  const host = await provision(url, config, deviceToken)
  const device = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: deviceToken })
  t.after(() => { host.close(); device.close() })

  const poll = fetch(`${base}/v1/agent/poll`, {
    headers: { authorization: `Bearer ${config.agentToken}` },
    signal: AbortSignal.timeout(2_000),
  })
  await new Promise(resolve => setTimeout(resolve, 25))
  const acknowledged = next(device, message => message.type === 'ack' && message.messageId === 'life-waiting')
  device.send(JSON.stringify({ v: 1, type: 'lifecycle.request', messageId: 'life-waiting', action: 'start' }))
  assert.equal((await acknowledged).state, 'queued')

  const response = await poll
  const body = await response.json()
  assert.equal(body.command.action, 'start')
  assert.equal(body.command.messageId, 'life-waiting')
})

test('rotating the host-owned credential disconnects the old phone and rejects its token', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const url = `ws://127.0.0.1:${address.port}/relay`
  const oldToken = secret()
  const host = await provision(url, config, oldToken)
  const oldDevice = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: oldToken })
  const exchangedToken = oldDevice.helloAck.deviceToken
  assert.match(exchangedToken, /^[A-Za-z0-9_-]{43}$/)
  t.after(() => { host.close(); oldDevice.close() })
  const disconnected = new Promise(resolve => oldDevice.addEventListener('close', resolve, { once: true }))
  const newToken = secret()
  await syncCredential(host, newToken, 'credential-2')
  const close = await disconnected
  assert.equal(close.code, 4003)

  const rejected = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: exchangedToken }, false)
  const rejectedClose = await new Promise(resolve => rejected.addEventListener('close', resolve, { once: true }))
  assert.equal(rejectedClose.code, 4003)
  const newDevice = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-2', token: newToken })
  assert.match(newDevice.helloAck.deviceToken, /^[A-Za-z0-9_-]{43}$/)
  newDevice.close()
})

test('host reconnect with the same pairing hash preserves the exchanged device binding', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const url = `ws://127.0.0.1:${address.port}/relay`
  const pairingToken = secret()
  const pairingExpiresAt = Date.now() + 5 * 60_000
  let host = await provision(url, config, pairingToken, pairingExpiresAt)
  const first = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: pairingToken })
  const deviceToken = first.helloAck.deviceToken
  first.close()
  host.close()
  host = await provision(url, config, pairingToken, pairingExpiresAt)
  t.after(() => host.close())
  const reconnected = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: deviceToken })
  assert.equal(reconnected.helloAck.deviceToken, undefined)
  reconnected.close()
})

test('rejects an expired pairing bearer', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const url = `ws://127.0.0.1:${address.port}/relay`
  const expiredToken = secret()
  const host = await provision(url, config, expiredToken, Date.now() - 1)
  t.after(() => host.close())
  const rejected = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: expiredToken }, false)
  const close = await new Promise(resolve => rejected.addEventListener('close', resolve, { once: true }))
  assert.equal(close.code, 4003)
})

test('an exchanged device bearer remains valid after the pairing window expires', async t => {
  const config = { hostId: 'desktop', hostToken: secret(), agentToken: secret(), port: 0, databasePath: ':memory:' }
  const relay = createRelayServer(config)
  t.after(() => relay.close())
  const address = await relay.listen()
  const url = `ws://127.0.0.1:${address.port}/relay`
  const pairingToken = secret()
  const host = await provision(url, config, pairingToken, Date.now() + 80)
  t.after(() => host.close())
  const first = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: pairingToken })
  const deviceToken = first.helloAck.deviceToken
  first.close()
  await new Promise(resolve => setTimeout(resolve, 100))
  const reconnected = await open(url, { v: 1, type: 'hello', role: 'device', hostId: 'desktop', deviceId: 'phone-1', token: deviceToken })
  assert.equal(reconnected.helloAck.deviceToken, undefined)
  reconnected.close()
})
