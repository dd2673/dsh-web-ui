import { describe, it, expect } from 'vitest'
import { createRemoteCompatibilityApi } from '../src/host/compat-api.ts'

describe('remote compatibility transport', () => {
  it('preserves owner data through Unicode, long text and structured RPC results', async () => {
    const data = { name: '张三', phone: '13800138000', id: '110101199001011234', address: '北京市朝阳区测试路 123 号', text: '原文\u{1f642}'.repeat(20000) }
    const calls: unknown[] = []
    const gateway = { invoke: async (request: unknown) => { calls.push(request); return data }, wireStream: { open: async () => { throw new Error('unused') }, failure: (e: unknown) => ({ code: 'test', message: String(e), details: {} }) } }
    const connection = { createSharedFetchHandler: () => ({ fetch: async () => new Response('{}') }) }
    const api = createRemoteCompatibilityApi(gateway, connection)
    const response = await api.sessions.rename({ rpcId: 'unicode', payload: data } as never)
    expect(response).toEqual({ rpcId: 'unicode', result: { ok: true, value: data } })
    expect(calls).toEqual([{ namespace: 'session', method: 'rename', args: { request: data }, signal: expect.any(AbortSignal) }])
  })

  it('keeps source failures as failures, never successful empty replies', async () => {
    const gateway = { invoke: async () => { throw new Error('offline') }, wireStream: { open: async () => { throw new Error('unused') }, failure: () => ({ code: 'unavailable', message: 'offline', details: {} }) } }
    const api = createRemoteCompatibilityApi(gateway, { createSharedFetchHandler: () => ({ fetch: async () => new Response('{}') }) })
    const reply = await api.sessions.list({ rpcId: 'failure', payload: {} } as never)
    expect(reply.result).toEqual({ ok: false, error: { code: 'unavailable', message: 'offline', details: {} } })
  })
})

it('carries approval, queue and projection events without changing owner values', async () => {
  const abort = new AbortController()
  const wait = (signal: AbortSignal) => new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
  const posted: unknown[] = []
  const raw = { name: '李四', phone: '13800138000', id: '110101199001011234', address: '北京市测试地址', text: '完整原文'.repeat(20000) }
  const gateway = {
    invoke: async () => ({ sessionId: 's1' }),
    wireStream: { failure: () => ({ code: 'error', message: 'error', details: {} }),
      open: async (endpoint: string, _payload: unknown, signal: AbortSignal) => ({ async *[Symbol.asyncIterator]() {
        if (endpoint === '$events') {
          yield { type: 'ready', clientId: 'client-1', host: { home: '/test' } }
          yield { type: 'waterfall', event: 'approval/request', eventId: 'approval-1', agentId: 's1', request: { toolName: 'test-only', reason: 'Approval test' } }
        } else if (endpoint === 'session/control') {
          yield { type: 'baseline', value: { queues: { s1: [{ id: 'q1', message: raw }] }, jobs: {}, projections: {} } }
          yield { type: 'projection', sessionId: 's1', key: 'owner', value: raw, seq: 1 }
        }
        await wait(signal)
      } })
    }
  }
  const connection = { createSharedFetchHandler: () => ({ fetch: async (request: Request) => {
    const body = await request.json() as { rpcId: string }; posted.push(body)
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } })
  } }) }
  const api = createRemoteCompatibilityApi(gateway, connection)
  await api.sessions.create({ rpcId: 'create', payload: {} } as never)
  const iterator = api.events.mux({ rpcId: 'events', payload: {} } as never, abort.signal)[Symbol.asyncIterator]()
  const received: unknown[] = []
  try {
    for (let i = 0; i < 3; i++) received.push((await iterator.next()).value)
    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({ rpcId: 'approval-1', payload: expect.objectContaining({ type: 'approval/requested', approvalId: 'approval-1', sessionId: 's1' }) }),
      expect.objectContaining({ payload: { type: 'session/queue', sessionId: 's1', items: [{ id: 'q1', message: raw }] } }),
      expect.objectContaining({ payload: { type: 'session/projection', sessionId: 's1', key: 'owner', value: raw, seq: 1 } }),
    ]))
    await expect(api.respond({ rpcId: 'approval-1', type: 'client-response', result: { ok: true, value: { sessionId: 'other-session', approvalId: 'approval-1', outcome: 'allowed-once' } } } as never)).resolves.toEqual({ accepted: false, reason: 'invalid-approval' })
    expect(posted).toEqual([])
    await api.respond({ rpcId: 'approval-1', type: 'client-response', result: { ok: true, value: { sessionId: 's1', approvalId: 'approval-1', outcome: 'allowed-once' } } } as never)
    expect(posted).toEqual([expect.objectContaining({ payload: { args: { clientId: 'client-1', eventId: 'approval-1', outcome: { kind: 'result', value: 'allowed-once' } } } })])
    await expect(api.respond({ rpcId: 'approval-1', type: 'client-response', result: { ok: true, value: 'allowed-once' } } as never)).resolves.toEqual({ accepted: false, reason: 'not-pending' })
  } finally { abort.abort(); await iterator.return?.() }
}, 3000)
