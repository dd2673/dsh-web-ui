import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { dispatchMobileMethod, isMobileMethodAllowed } from './mobile-api.ts'

const PROTOCOL_VERSION = 1
const MAX_RECONNECT_MS = 60_000
const RPC_CHUNK_MAX_COUNT = 160
const RPC_CHUNK_MAX_CHARS = 48_000
const RPC_ASSEMBLY_MAX_CHARS = 8 * 1024 * 1024
const RPC_ASSEMBLY_TTL_MS = 30_000
const RPC_ASSEMBLIES_PER_DEVICE = 2

interface RelaySocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void, options?: { once?: boolean }): void
  addEventListener(type: 'message', listener: (event: MessageEvent<string>) => void): void
  addEventListener(type: 'close', listener: () => void, options?: { once?: boolean }): void
  addEventListener(type: 'error', listener: () => void, options?: { once?: boolean }): void
}

export interface RelayGatewayOptions {
  apiProxy: ApiProxy
  relayUrl: string
  hostId: string
  token: string
  webSocketFactory?: (url: string) => RelaySocket
  reconnectBaseMs?: number
  extraCapabilities?: () => readonly string[]
  dispatchExtra?: (method: string, payload: unknown, rpcId: string) => Promise<unknown>
  credentialHash?: () => string | undefined
  credentialExpiresAt?: () => number | undefined
}

interface RelayMessage {
  v?: unknown
  type?: unknown
  deviceId?: unknown
  messageId?: unknown
  method?: unknown
  stream?: unknown
  payload?: unknown
  chunkIndex?: unknown
  chunkCount?: unknown
  data?: unknown
}

interface RpcChunkAssembly {
  readonly deviceId: string
  readonly method: string
  readonly chunkCount: number
  readonly chunks: Array<string | undefined>
  received: number
  characters: number
  expiresAt: number
}

/**
 * Official-ApiProxy to relay adapter. It never reads Harness files or internal
 * ports: every remote action crosses the same typed API surface as the local
 * mobile page, including the explicit allowlist and approval response carrier.
 */
export class RelayGateway {
  readonly #apiProxy: ApiProxy
  readonly #relayUrl: string
  readonly #hostId: string
  readonly #token: string
  readonly #factory: (url: string) => RelaySocket
  readonly #reconnectBaseMs: number
  readonly #extraCapabilities: () => readonly string[]
  readonly #dispatchExtra: ((method: string, payload: unknown, rpcId: string) => Promise<unknown>) | undefined
  readonly #credentialHash: () => string | undefined
  readonly #credentialExpiresAt: () => number | undefined
  #socket: RelaySocket | undefined
  #running = false
  #attempt = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #muxAbort: AbortController | undefined
  #authenticated = false
  #credentialRequestId: string | undefined
  #credentialSentHash: string | null | undefined
  #credentialDesiredHash: string | null | undefined
  #credentialSentExpiresAt: number | null | undefined
  #credentialDesiredExpiresAt: number | null | undefined
  #credentialWaiters = new Set<{ resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  #rpcAssemblies = new Map<string, RpcChunkAssembly>()

  constructor(options: RelayGatewayOptions) {
    this.#apiProxy = options.apiProxy
    this.#relayUrl = validateRelayUrl(options.relayUrl)
    this.#hostId = options.hostId
    this.#token = options.token
    this.#factory = options.webSocketFactory ?? (url => new WebSocket(url) as unknown as RelaySocket)
    this.#reconnectBaseMs = options.reconnectBaseMs ?? 1_000
    this.#extraCapabilities = options.extraCapabilities ?? (() => [])
    this.#dispatchExtra = options.dispatchExtra
    this.#credentialHash = options.credentialHash ?? (() => undefined)
    this.#credentialExpiresAt = options.credentialExpiresAt ?? (() => undefined)
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#connect()
  }

  stop(): void {
    this.#running = false
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#muxAbort?.abort()
    this.#muxAbort = undefined
    this.#authenticated = false
    this.#rpcAssemblies.clear()
    this.#socket?.close(1000, 'gateway stopped')
    this.#socket = undefined
  }

  /** Push the current local hash and resolve only after the relay confirms it. */
  syncCredential(timeoutMs = 10_000): Promise<void> {
    this.#credentialDesiredHash = this.#credentialHash() ?? null
    this.#credentialDesiredExpiresAt = this.#credentialExpiresAt() ?? null
    this.#flushCredential()
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(waiter.timer); this.#credentialWaiters.delete(waiter); resolve() },
        reject: (error: Error) => { clearTimeout(waiter.timer); this.#credentialWaiters.delete(waiter); reject(error) },
        timer: setTimeout(() => waiter.reject(new Error('relay credential confirmation timed out')), timeoutMs),
      }
      this.#credentialWaiters.add(waiter)
      // The flush above may have completed synchronously only in a fake; call
      // once more after registering so the acknowledgement always has a waiter.
      this.#flushCredential()
    })
  }

  #connect(): void {
    if (!this.#running) return
    let socket: RelaySocket
    try {
      socket = this.#factory(this.#relayUrl)
    } catch {
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket
    socket.addEventListener('open', () => {
      this.#attempt = 0
      this.#send({
        v: PROTOCOL_VERSION,
        type: 'hello',
        role: 'host',
        hostId: this.#hostId,
        token: this.#token,
      })
    }, { once: true })
    socket.addEventListener('message', event => {
      void this.#onMessage(event.data)
    })
    socket.addEventListener('close', () => {
      if (this.#socket === socket) this.#socket = undefined
      this.#muxAbort?.abort()
      this.#muxAbort = undefined
      this.#authenticated = false
      this.#credentialRequestId = undefined
      this.#credentialSentHash = undefined
      this.#credentialSentExpiresAt = undefined
      this.#scheduleReconnect()
    }, { once: true })
    socket.addEventListener('error', () => {
      // close is the single reconnect edge; browsers emit it after error.
    }, { once: true })
  }

  async #onMessage(text: string): Promise<void> {
    let message: RelayMessage
    try {
      message = JSON.parse(text) as RelayMessage
    } catch {
      return
    }
    if (message.v !== PROTOCOL_VERSION || typeof message.type !== 'string') return
    if (message.type === 'hello.ack') {
      this.#authenticated = true
      this.#credentialDesiredHash = this.#credentialHash() ?? null
      this.#credentialDesiredExpiresAt = this.#credentialExpiresAt() ?? null
      this.#flushCredential()
      this.#send({
        v: PROTOCOL_VERSION,
        type: 'capabilities',
        hostId: this.#hostId,
        protocolVersion: PROTOCOL_VERSION,
        methods: [...mobileCapabilities(this.#extraCapabilities())],
      })
      this.#startMux()
      return
    }
    if (message.type === 'ack' && typeof message.messageId === 'string' && message.messageId === this.#credentialRequestId) {
      const confirmedHash = this.#credentialSentHash
      const confirmedExpiresAt = this.#credentialSentExpiresAt
      this.#credentialRequestId = undefined
      this.#credentialSentHash = undefined
      this.#credentialSentExpiresAt = undefined
      if (confirmedHash === this.#credentialDesiredHash && confirmedExpiresAt === this.#credentialDesiredExpiresAt) {
        for (const waiter of [...this.#credentialWaiters]) waiter.resolve()
      } else {
        this.#flushCredential()
      }
      return
    }
    if (message.type === 'error' && typeof message.messageId === 'string' && message.messageId === this.#credentialRequestId) {
      const rejectedHash = this.#credentialSentHash
      const rejectedExpiresAt = this.#credentialSentExpiresAt
      this.#credentialRequestId = undefined
      this.#credentialSentHash = undefined
      this.#credentialSentExpiresAt = undefined
      const error = new Error('relay rejected credential synchronization')
      for (const waiter of [...this.#credentialWaiters]) waiter.reject(error)
      // A rotate may have superseded the rejected legacy value while the
      // error was in flight; attempt the current desired state immediately.
      if (rejectedHash !== this.#credentialDesiredHash || rejectedExpiresAt !== this.#credentialDesiredExpiresAt) this.#flushCredential()
      return
    }
    if (message.type === 'stream.subscribe' || message.type === 'stream.unsubscribe') {
      if (typeof message.deviceId !== 'string' || typeof message.messageId !== 'string') return
      if (message.stream !== 'events.mux') return
      // A device may connect after the Host mux emitted its baseline. Restart
      // the mux so session/subscribed and all non-empty transient snapshots are
      // replayed from the Host authority instead of cached by the relay.
      if (message.type === 'stream.subscribe') this.#startMux()
      this.#send({
        v: PROTOCOL_VERSION,
        type: 'ack',
        deviceId: message.deviceId,
        messageId: message.messageId,
        state: message.type === 'stream.subscribe' ? 'subscribed' : 'unsubscribed',
      })
      return
    }
    if (message.type === 'rpc.request.chunk') {
      message = this.#acceptRpcChunk(message) ?? {}
      if (message.type === undefined) return
    }
    if (message.type !== 'rpc.request') return
    if (typeof message.deviceId !== 'string' || typeof message.messageId !== 'string' || typeof message.method !== 'string') return
    const base = {
      v: PROTOCOL_VERSION,
      type: 'rpc.response',
      deviceId: message.deviceId,
      messageId: message.messageId,
    }
    const isExtra = this.#extraCapabilities().includes(message.method)
    if (!isMobileMethodAllowed(message.method) && !isExtra) {
      this.#send({
        ...base,
        payload: {
          type: 'server-response',
          rpcId: message.messageId,
          result: { ok: false, error: { code: 'forbidden', message: `method ${message.method} is not exposed remotely` } },
        },
      })
      return
    }
    try {
      const payload = isExtra && this.#dispatchExtra !== undefined
        ? await this.#dispatchExtra(message.method, message.payload, message.messageId)
        : await dispatchMobileMethod(this.#apiProxy, message.method, message.payload, message.messageId)
      this.#send({ ...base, payload })
    } catch (error) {
      this.#send({
        ...base,
        payload: {
          type: 'server-response',
          rpcId: message.messageId,
          result: { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } },
        },
      })
    }
  }

  /** Reassemble a bounded large RPC request without raising the relay frame cap. */
  #acceptRpcChunk(message: RelayMessage): RelayMessage | undefined {
    if (typeof message.deviceId !== 'string' || typeof message.messageId !== 'string' || typeof message.method !== 'string') return undefined
    const chunkIndex = message.chunkIndex
    const chunkCount = message.chunkCount
    const data = message.data
    const base = { v: PROTOCOL_VERSION, type: 'error', deviceId: message.deviceId, messageId: message.messageId }
    const fail = (code: string, detail: string): undefined => {
      this.#rpcAssemblies.delete(`${message.deviceId}:${message.messageId}`)
      this.#send({ ...base, code, message: detail })
      return undefined
    }
    const isExtra = this.#extraCapabilities().includes(message.method)
    if (!isMobileMethodAllowed(message.method) && !isExtra) return fail('forbidden', `method ${message.method} is not exposed remotely`)
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(chunkCount)
      || (chunkCount as number) < 1 || (chunkCount as number) > RPC_CHUNK_MAX_COUNT
      || (chunkIndex as number) < 0 || (chunkIndex as number) >= (chunkCount as number)
      || typeof data !== 'string' || data.length > RPC_CHUNK_MAX_CHARS) {
      return fail('bad-rpc-chunk', 'invalid RPC chunk')
    }
    const now = Date.now()
    for (const [key, assembly] of this.#rpcAssemblies) {
      if (assembly.expiresAt <= now) this.#rpcAssemblies.delete(key)
    }
    const key = `${message.deviceId}:${message.messageId}`
    let assembly = this.#rpcAssemblies.get(key)
    if (assembly === undefined) {
      const activeForDevice = [...this.#rpcAssemblies.values()].filter(item => item.deviceId === message.deviceId).length
      if (activeForDevice >= RPC_ASSEMBLIES_PER_DEVICE) return fail('rpc-chunk-busy', 'too many large requests')
      assembly = {
        deviceId: message.deviceId,
        method: message.method,
        chunkCount: chunkCount as number,
        chunks: new Array<string | undefined>(chunkCount as number),
        received: 0,
        characters: 0,
        expiresAt: now + RPC_ASSEMBLY_TTL_MS,
      }
      this.#rpcAssemblies.set(key, assembly)
    }
    if (assembly.method !== message.method || assembly.chunkCount !== chunkCount) return fail('bad-rpc-chunk', 'RPC chunk metadata changed')
    const existing = assembly.chunks[chunkIndex as number]
    if (existing !== undefined) {
      if (existing !== data) return fail('bad-rpc-chunk', 'RPC chunk content changed')
      return undefined
    }
    assembly.chunks[chunkIndex as number] = data
    assembly.received += 1
    assembly.characters += data.length
    assembly.expiresAt = now + RPC_ASSEMBLY_TTL_MS
    if (assembly.characters > RPC_ASSEMBLY_MAX_CHARS) return fail('rpc-request-too-large', 'large RPC request exceeds limit')
    if (assembly.received !== assembly.chunkCount) return undefined
    this.#rpcAssemblies.delete(key)
    let payload: unknown
    try {
      payload = JSON.parse(assembly.chunks.join(''))
    } catch {
      return fail('bad-rpc-chunk', 'assembled RPC payload is invalid JSON')
    }
    return { ...message, type: 'rpc.request', payload }
  }

  #startMux(): void {
    this.#muxAbort?.abort()
    const controller = new AbortController()
    this.#muxAbort = controller
    void (async () => {
      try {
        const request = { rpcId: RpcId(`relay-mux-${Date.now().toString(36)}`), payload: {} }
        for await (const frame of this.#apiProxy.events.mux(request, controller.signal)) {
          if (controller.signal.aborted) break
          this.#send({ v: PROTOCOL_VERSION, type: 'event', stream: 'events.mux', payload: frame })
        }
      } catch {
        // A carrier failure ends this connection's stream. Reconnect creates a
        // fresh mux; command operations themselves are never replayed.
      }
    })()
  }

  #send(message: unknown): void {
    if (this.#socket?.readyState !== 1) return
    this.#socket.send(JSON.stringify(message))
  }

  #flushCredential(): void {
    if (!this.#authenticated || this.#credentialDesiredHash === undefined || this.#credentialRequestId !== undefined) return
    const messageId = `credential-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.#credentialRequestId = messageId
    this.#credentialSentHash = this.#credentialDesiredHash
    this.#credentialSentExpiresAt = this.#credentialDesiredExpiresAt
    this.#send({
      v: PROTOCOL_VERSION,
      type: 'credential.sync',
      messageId,
      tokenSha256: this.#credentialSentHash,
      pairingExpiresAt: this.#credentialSentExpiresAt,
    })
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#timer !== undefined) return
    const delay = Math.min(this.#reconnectBaseMs * 2 ** this.#attempt, MAX_RECONNECT_MS)
    this.#attempt += 1
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#connect()
    }, delay)
  }
}

export function mobileCapabilities(extra: readonly string[] = []): readonly string[] {
  const standard = [
    'workspace.list',
    'workspace.create',
    'workspace.archiveSession',
    'host.listDirectory',
    'session.create',
    'session.list',
    'session.history',
    'session.search',
    'session.prompt',
    'session.models',
    'session.selectModel',
    'session.rename',
    'session.cancel',
    'session.updateQueue',
    'skill.list',
    'agentPreset.list',
    'agentPreset.select',
    'events.respond',
  ].filter(isMobileMethodAllowed)
  return [...new Set([...standard, ...extra])]
}

/** Internet relays must use TLS; plaintext is only valid on loopback in tests/dev. */
export function validateRelayUrl(value: string): string {
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('relayUrl must use wss:// (ws:// is allowed only on loopback)')
  }
  const basePath = url.pathname.replace(/\/+$/, '')
  if (!basePath.endsWith('/relay')) url.pathname = `${basePath}/relay` || '/relay'
  url.search = ''
  url.hash = ''
  return url.toString()
}
