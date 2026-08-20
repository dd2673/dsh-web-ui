import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { RelayStateStore } from './state.mjs'
import { upgradeWebSocket } from './websocket.mjs'

const PROTOCOL_VERSION = 1
const AUTH_TIMEOUT_MS = 5_000
const HEARTBEAT_MS = 25_000
const AGENT_POLL_MS = 55_000
const AGENT_OFFLINE_MS = 130_000
const BODY_LIMIT = 64 * 1024
const WS_PAYLOAD_LIMIT = 128 * 1024
const MAX_CONNECTIONS = 64
const MAX_CONNECTIONS_PER_ADDRESS = 8
const DEVICE_MESSAGES_PER_MINUTE = 240
const LIFECYCLE_QUEUE_LIMIT = 32
const DEVICE_TO_HOST = new Set(['rpc.request', 'rpc.request.chunk', 'stream.subscribe', 'stream.unsubscribe', 'lifecycle.request', 'device.revoke'])
const HOST_TO_DEVICE = new Set(['rpc.response', 'event', 'capabilities', 'status', 'error', 'ack'])

function hashToken(token) {
  return createHash('sha256').update(token).digest()
}

function equalToken(actual, expectedHash) {
  if (typeof actual !== 'string' || actual.length < 24) return false
  const actualHash = hashToken(actual)
  return actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash)
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function bearer(request) {
  const value = request.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : ''
}

function validateConfig(input) {
  if (typeof input.hostId !== 'string' || input.hostId.length < 3 || input.hostId.length > 128) {
    throw new Error('hostId must contain 3 to 128 characters')
  }
  for (const key of ['hostToken', 'agentToken']) {
    if (typeof input[key] !== 'string' || input[key].length < 24) throw new Error(`${key} must contain at least 24 characters`)
  }
  return {
    hostId: input.hostId,
    hostTokenHash: hashToken(input.hostToken),
    agentTokenHash: hashToken(input.agentToken),
    listenHost: input.listenHost ?? '127.0.0.1',
    port: input.port ?? 3090,
    databasePath: input.databasePath ?? './data/relay-state.json',
  }
}

export function createRelayServer(input) {
  const config = validateConfig(input)
  const store = new RelayStateStore(config.databasePath)
  let hostPeer
  let cachedCapabilities
  const devices = new Map()
  const lifecycleQueue = []
  const agentWaiters = new Set()
  const peerCounts = new Map()
  let peerTotal = 0

  const status = () => {
    const stored = store.status(config.hostId)
    const host = stored === undefined
      ? undefined
      : { ...stored, agentState: Date.now() - stored.lastSeenAt > AGENT_OFFLINE_MS ? 'offline' : stored.agentState }
    return {
      v: PROTOCOL_VERSION,
      type: 'status',
      hostId: config.hostId,
      hostConnected: hostPeer !== undefined && !hostPeer.closed,
      deviceCount: devices.size,
      host,
    }
  }

  const broadcast = message => {
    for (const peer of devices.values()) peer.sendJson(message)
  }

  const dequeueLifecycle = () => {
    while (lifecycleQueue.length > 0) {
      const command = lifecycleQueue.shift()
      if (command.expiresAt > Date.now()) return command
      store.audit({ hostId: config.hostId, kind: 'lifecycle.expired', messageId: command.messageId, outcome: 'dropped' })
    }
    return undefined
  }

  const wakeAgent = () => {
    const command = dequeueLifecycle()
    if (command === undefined) return false
    const waiter = agentWaiters.values().next().value
    if (waiter === undefined) {
      lifecycleQueue.unshift(command)
      return false
    }
    agentWaiters.delete(waiter)
    waiter(command)
    return true
  }

  const enqueueLifecycle = command => {
    const existing = lifecycleQueue.find(item => item.messageId === command.messageId)
    if (existing === undefined && lifecycleQueue.length >= LIFECYCLE_QUEUE_LIMIT) return false
    if (existing === undefined) lifecycleQueue.push(command)
    wakeAgent()
    return true
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://relay.local')
    if (request.method === 'GET' && url.pathname === '/healthz') {
      json(response, 200, { ok: true, protocolVersion: PROTOCOL_VERSION })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/agent/poll') {
      if (!equalToken(bearer(request), config.agentTokenHash)) {
        json(response, 401, { ok: false, error: 'unauthorized' })
        return
      }
      store.hostSeen(config.hostId, { agentState: 'online' })
      const queued = dequeueLifecycle()
      if (queued !== undefined) {
        json(response, 200, { ok: true, command: queued })
        return
      }
      let settled = false
      const settle = command => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        agentWaiters.delete(settle)
        response.off('close', onClose)
        json(response, 200, { ok: true, ...(command === undefined ? {} : { command }) })
      }
      const onClose = () => {
        settled = true
        clearTimeout(timer)
        agentWaiters.delete(settle)
      }
      const timer = setTimeout(() => settle(undefined), AGENT_POLL_MS)
      agentWaiters.add(settle)
      // IncomingMessage closes as soon as a bodyless GET is consumed. The
      // response lifecycle is the authority for whether this long poll is alive.
      response.on('close', onClose)
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/agent/report') {
      if (!equalToken(bearer(request), config.agentTokenHash)) {
        json(response, 401, { ok: false, error: 'unauthorized' })
        return
      }
      try {
        const body = await readJson(request)
        const state = store.hostSeen(config.hostId, {
          agentState: 'online',
          dshState: typeof body.dshState === 'string' ? body.dshState : undefined,
          dshVersion: typeof body.dshVersion === 'string' ? body.dshVersion : undefined,
          port: Number.isInteger(body.port) ? body.port : undefined,
        })
        const actionResult = typeof body.actionResult === 'object' && body.actionResult !== null
          ? {
              messageId: String(body.actionResult.messageId ?? '').slice(0, 128),
              action: String(body.actionResult.action ?? '').slice(0, 32),
              ok: body.actionResult.ok === true,
              message: String(body.actionResult.message ?? '').slice(0, 500),
            }
          : undefined
        if (actionResult !== undefined) {
          store.audit({ hostId: config.hostId, kind: 'lifecycle.result', messageId: actionResult.messageId, outcome: actionResult.ok ? 'ok' : 'failed' })
        }
        broadcast({ v: PROTOCOL_VERSION, type: 'status', hostId: config.hostId, hostConnected: hostPeer !== undefined && !hostPeer.closed, host: state, ...(actionResult === undefined ? {} : { actionResult }) })
        json(response, 200, { ok: true })
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    json(response, 404, { ok: false, error: 'not found' })
  })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay.local')
    if (url.pathname !== '/relay') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const address = request.socket.remoteAddress ?? 'unknown'
    const addressCount = peerCounts.get(address) ?? 0
    if (peerTotal >= MAX_CONNECTIONS || addressCount >= MAX_CONNECTIONS_PER_ADDRESS) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 30\r\n\r\n')
      return
    }
    const peer = upgradeWebSocket(request, socket, head, { maxPayloadBytes: WS_PAYLOAD_LIMIT })
    if (peer === undefined) return
    peerTotal += 1
    peerCounts.set(address, addressCount + 1)
    let identity
    let alive = true
    let deviceRateStartedAt = Date.now()
    let deviceRateCount = 0
    const authTimer = setTimeout(() => peer.close(4003, 'authentication timeout'), AUTH_TIMEOUT_MS)
    peer.on('pong', () => { alive = true })
    peer.on('text', text => {
      if (identity?.role === 'device') {
        const now = Date.now()
        if (now - deviceRateStartedAt >= 60_000) {
          deviceRateStartedAt = now
          deviceRateCount = 0
        }
        deviceRateCount += 1
        if (deviceRateCount > DEVICE_MESSAGES_PER_MINUTE) {
          peer.close(4008, 'device rate limit')
          return
        }
      }
      let message
      try {
        message = JSON.parse(text)
      } catch {
        peer.close(4000, 'invalid json')
        return
      }
      if (identity === undefined) {
        if (message?.v !== PROTOCOL_VERSION || message?.type !== 'hello' || message?.hostId !== config.hostId) {
          peer.close(4003, 'invalid hello')
          return
        }
        const role = message.role
        if (role !== 'host' && role !== 'device') {
          peer.close(4003, 'invalid role')
          return
        }
        if (role === 'host' && !equalToken(message.token, config.hostTokenHash)) {
          peer.close(4003, 'unauthorized')
          return
        }
        let deviceId
        let exchangedDeviceToken
        if (role === 'device') {
          deviceId = typeof message.deviceId === 'string' && /^[A-Za-z0-9._:-]{3,128}$/.test(message.deviceId)
            ? message.deviceId
            : undefined
          const actualTokenHash = typeof message.token === 'string' && message.token.length >= 24
            ? hashToken(message.token).toString('hex')
            : undefined
          const credential = store.deviceCredential(config.hostId)
          if (deviceId === undefined || store.isRevoked(config.hostId, deviceId) || actualTokenHash === undefined || credential === undefined) {
            peer.close(4003, 'device rejected')
            return
          }
          if (credential.pairingTokenSha256 === actualTokenHash && credential.deviceId === undefined
            && Number.isFinite(credential.pairingExpiresAt) && credential.pairingExpiresAt > Date.now()) {
            exchangedDeviceToken = randomBytes(32).toString('base64url')
            const exchangedHash = hashToken(exchangedDeviceToken).toString('hex')
            if (!store.exchangePairingCredential(config.hostId, actualTokenHash, deviceId, exchangedHash)) {
              peer.close(4003, 'pairing credential already used')
              return
            }
          } else if (!store.matchDeviceCredential(config.hostId, actualTokenHash, deviceId)) {
            peer.close(4003, 'device rejected')
            return
          }
        }
        clearTimeout(authTimer)
        identity = { role, deviceId }
        if (role === 'host') {
          hostPeer?.close(4001, 'host reconnected')
          hostPeer = peer
          // A reconnecting host may advertise a different plugin surface.
          // Clear the old snapshot until its fresh capabilities frame arrives.
          cachedCapabilities = undefined
          store.hostSeen(config.hostId, { dshState: 'running' })
          broadcast(status())
        } else {
          devices.get(deviceId)?.close(4001, 'device reconnected')
          devices.set(deviceId, peer)
          store.deviceSeen(config.hostId, deviceId)
          peer.sendJson(status())
        }
        peer.sendJson({
          v: PROTOCOL_VERSION,
          type: 'hello.ack',
          role,
          hostId: config.hostId,
          ...(exchangedDeviceToken === undefined ? {} : { deviceToken: exchangedDeviceToken }),
        })
        if (role === 'device' && cachedCapabilities !== undefined) peer.sendJson(cachedCapabilities)
        return
      }

      if (identity.role === 'device') {
        store.deviceSeen(config.hostId, identity.deviceId)
        if (!DEVICE_TO_HOST.has(message?.type)) {
          peer.sendJson({ v: PROTOCOL_VERSION, type: 'error', messageId: message?.messageId, code: 'forbidden', message: 'message type is not allowed' })
          return
        }
        const validMessageId = typeof message.messageId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(message.messageId)
        if (!validMessageId) {
          peer.sendJson({ v: PROTOCOL_VERSION, type: 'error', code: 'bad-message-id', message: 'invalid message id' })
          return
        }
        if (message.type === 'lifecycle.request') {
          if (!['start', 'stop', 'restart', 'status'].includes(message.action)) return
          const queued = enqueueLifecycle({ messageId: message.messageId, action: message.action, expiresAt: Math.min(Number(message.expiresAt) || Date.now() + 120_000, Date.now() + 120_000) })
          peer.sendJson({ v: PROTOCOL_VERSION, type: 'ack', messageId: message.messageId, state: queued ? 'queued' : 'queue-full' })
          return
        }
        if (message.type === 'device.revoke') {
          const target = typeof message.targetDeviceId === 'string' ? message.targetDeviceId : ''
          if (target === '') return
          store.revokeDevice(config.hostId, target)
          devices.get(target)?.close(4003, 'device revoked')
          devices.delete(target)
          return
        }
        if (message.type === 'rpc.request.chunk') {
          const validChunk = typeof message.method === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(message.method)
            && Number.isInteger(message.chunkIndex) && Number.isInteger(message.chunkCount)
            && message.chunkCount >= 1 && message.chunkCount <= 160
            && message.chunkIndex >= 0 && message.chunkIndex < message.chunkCount
            && typeof message.data === 'string' && message.data.length <= 48_000
          if (!validChunk) {
            peer.sendJson({ v: PROTOCOL_VERSION, type: 'error', messageId: message.messageId, code: 'bad-rpc-chunk', message: 'invalid RPC chunk' })
            return
          }
        }
        if (hostPeer === undefined || hostPeer.closed) {
          peer.sendJson({ v: PROTOCOL_VERSION, type: 'error', messageId: message.messageId, code: 'host-offline', message: 'DeepSeek is offline' })
          return
        }
        hostPeer.sendJson({ ...message, v: PROTOCOL_VERSION, hostId: config.hostId, deviceId: identity.deviceId })
        store.audit({ hostId: config.hostId, deviceId: identity.deviceId, kind: message.type, messageId: message.messageId, outcome: 'forwarded' })
        return
      }

      if (message?.type === 'credential.sync') {
        const tokenSha256 = message.tokenSha256 === null ? null : message.tokenSha256
        if (tokenSha256 !== null && (typeof tokenSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tokenSha256))) {
          peer.sendJson({ v: PROTOCOL_VERSION, type: 'error', messageId: message.messageId, code: 'bad-credential', message: 'invalid token hash' })
          return
        }
        const pairingExpiresAt = tokenSha256 === null ? null : Number(message.pairingExpiresAt)
        if (tokenSha256 !== null && (!Number.isSafeInteger(pairingExpiresAt) || pairingExpiresAt <= 0 || pairingExpiresAt > Date.now() + 24 * 60 * 60_000)) {
          peer.sendJson({ v: PROTOCOL_VERSION, type: 'error', messageId: message.messageId, code: 'bad-credential-expiry', message: 'invalid pairing expiry' })
          return
        }
        const previous = store.deviceCredential(config.hostId)
        const next = store.syncDeviceCredential(config.hostId, tokenSha256, pairingExpiresAt)
        if (previous?.version !== next?.version) {
          for (const device of devices.values()) device.close(4003, 'device credential rotated')
          devices.clear()
        }
        peer.sendJson({ v: PROTOCOL_VERSION, type: 'ack', messageId: message.messageId, state: tokenSha256 === null ? 'credential-revoked' : 'credential-synced', credentialVersion: next?.version })
        return
      }
      if (!HOST_TO_DEVICE.has(message?.type)) return
      if (message.type === 'capabilities') {
        cachedCapabilities = { ...message, v: PROTOCOL_VERSION, hostId: config.hostId }
      }
      if (typeof message.deviceId === 'string') devices.get(message.deviceId)?.sendJson(message)
      else broadcast(message)
    })
    peer.on('close', () => {
      clearTimeout(authTimer)
      peerTotal = Math.max(0, peerTotal - 1)
      const remaining = (peerCounts.get(address) ?? 1) - 1
      if (remaining <= 0) peerCounts.delete(address)
      else peerCounts.set(address, remaining)
      if (identity?.role === 'host' && hostPeer === peer) {
        hostPeer = undefined
        store.hostOffline(config.hostId)
        broadcast(status())
      }
      if (identity?.role === 'device' && devices.get(identity.deviceId) === peer) devices.delete(identity.deviceId)
    })
    peer.on('error', () => {})
    const heartbeat = setInterval(() => {
      if (!alive) {
        clearInterval(heartbeat)
        peer.close(4008, 'heartbeat timeout')
        return
      }
      alive = false
      peer.ping(Buffer.from('ping'))
    }, HEARTBEAT_MS)
    heartbeat.unref()
    peer.on('close', () => clearInterval(heartbeat))
  })

  return {
    server,
    store,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.listenHost, () => {
          server.off('error', reject)
          resolve(server.address())
        })
      })
    },
    async close() {
      hostPeer?.close(1001, 'server stopping')
      for (const peer of devices.values()) peer.close(1001, 'server stopping')
      for (const waiter of agentWaiters) waiter(undefined)
      await new Promise(resolve => server.close(resolve))
      store.close()
    },
  }
}
