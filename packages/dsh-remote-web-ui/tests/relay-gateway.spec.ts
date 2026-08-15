import { describe, expect, it, vi } from 'vitest'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { RelayGateway, validateRelayUrl } from '../src/relay-gateway.ts'

class FakeSocket extends EventTarget {
  readyState = 0
  sent: unknown[] = []

  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

function proxy(): ApiProxy {
  return {
    workspace: { list: vi.fn(async () => ({ rpcId: 'r', result: { ok: true, value: { items: [] } } })) },
    sessions: { prompt: vi.fn(async () => ({ rpcId: 'r', result: { ok: true, value: { accepted: true } } })) },
    events: { mux: () => (async function* () {})() },
  } as unknown as ApiProxy
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('relay gateway', () => {
  it('authenticates, publishes capabilities, and dispatches an allowlisted rpc', async () => {
    const socket = new FakeSocket()
    const apiProxy = proxy()
    const gateway = new RelayGateway({
      apiProxy,
      relayUrl: 'ws://127.0.0.1:3090/relay',
      hostId: 'desktop',
      token: 'host-token-long-enough-for-the-relay',
      webSocketFactory: () => socket,
      credentialHash: () => 'a'.repeat(64),
    })
    gateway.start()
    socket.open()
    expect(socket.sent[0]).toMatchObject({ type: 'hello', role: 'host', hostId: 'desktop' })
    socket.receive({ v: 1, type: 'hello.ack' })
    socket.receive({ v: 1, type: 'rpc.request', deviceId: 'phone', messageId: 'm1', method: 'workspace.list', payload: {} })
    await tick()
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: 'capabilities' }))
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: 'credential.sync', tokenSha256: 'a'.repeat(64) }))
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'rpc.response',
      deviceId: 'phone',
      messageId: 'm1',
      payload: expect.objectContaining({ type: 'server-response', rpcId: 'm1' }),
    }))
    gateway.stop()
  })

  it('advertises and dispatches bounded host directory extensions', async () => {
    const socket = new FakeSocket()
    const dispatchExtra = vi.fn(async () => ({ roots: ['C:\\'] }))
    const gateway = new RelayGateway({
      apiProxy: proxy(),
      relayUrl: 'ws://127.0.0.1:3090/relay',
      hostId: 'desktop',
      token: 'host-token-long-enough-for-the-relay',
      webSocketFactory: () => socket,
      extraCapabilities: () => ['host.listDrives', 'host.searchDirectories'],
      dispatchExtra,
    })
    gateway.start()
    socket.open()
    socket.receive({ v: 1, type: 'hello.ack' })
    socket.receive({ v: 1, type: 'rpc.request', deviceId: 'phone', messageId: 'm-drives', method: 'host.listDrives', payload: {} })
    await tick()
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'capabilities',
      methods: expect.arrayContaining(['host.listDrives', 'host.searchDirectories']),
    }))
    expect(dispatchExtra).toHaveBeenCalledWith('host.listDrives', {}, 'm-drives')
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'rpc.response',
      messageId: 'm-drives',
      payload: { roots: ['C:\\'] },
    }))
    gateway.stop()
  })

  it('restarts the authoritative mux when a device subscribes after connecting', async () => {
    const socket = new FakeSocket()
    const apiProxy = proxy()
    const mux = vi.fn(() => (async function* () {
      yield { rpcId: 'baseline', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 4 } }
    })())
    apiProxy.events.mux = mux
    const gateway = new RelayGateway({
      apiProxy,
      relayUrl: 'ws://127.0.0.1:3090/relay',
      hostId: 'desktop',
      token: 'host-token-long-enough-for-the-relay',
      webSocketFactory: () => socket,
    })
    gateway.start()
    socket.open()
    socket.receive({ v: 1, type: 'hello.ack' })
    await tick()
    expect(mux).toHaveBeenCalledTimes(1)

    socket.receive({
      v: 1,
      type: 'stream.subscribe',
      stream: 'events.mux',
      deviceId: 'phone',
      messageId: 'mux-phone',
    })
    await tick()
    expect(mux).toHaveBeenCalledTimes(2)
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'ack',
      deviceId: 'phone',
      messageId: 'mux-phone',
      state: 'subscribed',
    }))
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'event',
      payload: expect.objectContaining({ payload: expect.objectContaining({ type: 'session/subscribed' }) }),
    }))
    gateway.stop()
  })

  it('refuses a non-TLS internet relay URL', () => {
    expect(() => validateRelayUrl('ws://relay.example.com/relay')).toThrow(/wss/)
    expect(validateRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com/relay')
    expect(validateRelayUrl('wss://relay.example.com/dsh-relay/')).toBe('wss://relay.example.com/dsh-relay/relay')
  })

  it('reassembles a bounded chunked prompt before dispatching it', async () => {
    const socket = new FakeSocket()
    const apiProxy = proxy()
    const gateway = new RelayGateway({
      apiProxy,
      relayUrl: 'ws://127.0.0.1:3090/relay',
      hostId: 'desktop',
      token: 'host-token-long-enough-for-the-relay',
      webSocketFactory: () => socket,
    })
    gateway.start()
    socket.open()
    socket.receive({ v: 1, type: 'hello.ack' })
    const serialized = JSON.stringify({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'large prompt' }] })
    const middle = Math.ceil(serialized.length / 2)
    for (const [chunkIndex, data] of [serialized.slice(0, middle), serialized.slice(middle)].entries()) {
      socket.receive({
        v: 1,
        type: 'rpc.request.chunk',
        deviceId: 'phone',
        messageId: 'large-1',
        method: 'session.prompt',
        chunkIndex,
        chunkCount: 2,
        data,
      })
    }
    await tick()
    expect(apiProxy.sessions.prompt).toHaveBeenCalledTimes(1)
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: 'rpc.response', messageId: 'large-1' }))
    gateway.stop()
  })

  it('resolves credential synchronization only after the relay acknowledgement', async () => {
    const socket = new FakeSocket()
    const gateway = new RelayGateway({
      apiProxy: proxy(),
      relayUrl: 'ws://127.0.0.1:3090/relay',
      hostId: 'desktop',
      token: 'host-token-long-enough-for-the-relay',
      webSocketFactory: () => socket,
      credentialHash: () => 'b'.repeat(64),
    })
    gateway.start()
    socket.open()
    socket.receive({ v: 1, type: 'hello.ack' })
    const sync = gateway.syncCredential()
    let settled = false
    void sync.then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)
    const request = socket.sent.find(value => (value as { type?: string }).type === 'credential.sync') as { messageId: string }
    socket.receive({ v: 1, type: 'ack', messageId: request.messageId, state: 'credential-synced' })
    await sync
    expect(settled).toBe(true)
    gateway.stop()
  })
})
