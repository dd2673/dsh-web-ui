/**
 * The /m data channel: every allowlisted unary method must answer with the
 * transport envelope the phone's callUnary requires
 * ({ type: 'server-response', rpcId, result }) — regressions here surface as
 * a dead "加载中…" mobile surface.
 */
import { createServer, request as httpRequest } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import {
  compactMobileHistoryValue, compactMobileMuxFrame, compactMobileProjections, compactMobileSessionEvent,
  makeMobileApiRoutes,
} from '../src/mobile-api.ts'

interface TestServer {
  port: number
  close: () => Promise<void>
}

const cookieName = 'dsh_pair'

/** A pairing service stub that recognizes every cookie value. */
const service = {
  config: { cookieName },
  hasDevice: () => true,
} as never

/** The resolved mobile composer preference (tests flip it per case). */
const mobileEnterToSend = () => true

/** An ApiProxy stub answering each method with the internal response shape. */
const promptCalls: unknown[] = []
const directoryCalls: unknown[] = []
const respondCalls: unknown[] = []
const apiProxy = {
  workspace: {
    list: async () => ({ rpcId: 'r', result: { ok: true, value: { items: [], archivedSessionIds: [] } } }),
    create: async () => ({ rpcId: 'r', result: { ok: true, value: { workspace: { workspaceId: 'w-created', path: 'C:\\work', title: 'work', sessionIds: [] }, created: true } } }),
    archiveSession: async () => ({ rpcId: 'r', result: { ok: true, value: { archivedSessionIds: ['s-archived'] } } }),
  },
  host: {
    listDirectory: async (request: unknown) => {
      directoryCalls.push(request)
      return { rpcId: 'r', result: { ok: true, value: { path: 'C:\\work', home: 'C:\\Users\\tester', crumbs: [], entries: [], truncated: false } } }
    },
  },
  sessions: {
    list: async () => ({ rpcId: 'r', result: { ok: true, value: { items: [] } } }),
    create: async () => ({ rpcId: 'r', result: { ok: true, value: { sessionId: 's-created' } } }),
    history: async () => ({ rpcId: 'r', result: { ok: true, value: { items: [] } } }),
    search: async () => ({ rpcId: 'r', result: { ok: true, value: { items: [] } } }),
    prompt: async (request: unknown) => {
      promptCalls.push(request)
      return { rpcId: 'r', result: { ok: true, value: { accepted: true } } }
    },
    models: async () => ({ rpcId: 'r', result: { ok: true, value: { current: { provider: 'fx', model: 'fx-1' } } } }),
    selectModel: async () => ({ rpcId: 'r', result: { ok: true, value: { ok: true } } }),
    rename: async () => ({ rpcId: 'r', result: { ok: true, value: { ok: true } } }),
    cancel: async () => ({ rpcId: 'r', result: { ok: true, value: { accepted: true } } }),
    updateQueue: async () => ({ rpcId: 'r', result: { ok: true, value: { accepted: true } } }),
  },
  skills: {
    list: async () => ({ rpcId: 'r', result: { ok: true, value: { skills: [] } } }),
  },
  agentPresets: {
    list: async () => ({ rpcId: 'r', result: { ok: true, value: { presets: [], authorable: false, hasDocument: false } } }),
    select: async () => ({ rpcId: 'r', result: { ok: true, value: { agentPreset: 'default' } } }),
  },
  respond: async (response: unknown) => {
    respondCalls.push(response)
    return { accepted: true }
  },
  events: { mux: () => (async function* () {})() },
} as unknown as ApiProxy

async function serve(routes: WebRoute[]): Promise<TestServer> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname
    const exact = routes.find(r => r.kind === 'exact' && r.path === pathname)
    const route = exact ?? routes.find(r => r.kind === 'prefix' && pathname.startsWith(r.path))
    if (route === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    void route.handler(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    }),
  }
}

async function call(port: number, method: string, payload: unknown = {}): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'probe-1', method, payload })
    const req = httpRequest({
      host: '127.0.0.1', port, path: `/m/api/${method}`, method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${cookieName}=device-1`, 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('mobile api envelope', () => {
  it('wraps every allowlisted unary method in the server-response envelope', async () => {
    const server = await serve(makeMobileApiRoutes({ service, apiProxy, mobileEnterToSend }))
    try {
      for (const method of [
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
      ]) {
        const { status, body } = await call(server.port, method)
        expect(status).toBe(200)
        const envelope = JSON.parse(body) as { type?: string; rpcId?: string; result?: { ok?: boolean } }
        expect(envelope.type, method).toBe('server-response')
        expect(envelope.rpcId, method).toBe('probe-1')
        expect(envelope.result?.ok, method).toBe(true)
      }
    } finally {
      await server.close()
    }
  })

  it('forwards host directory browsing without letting the phone join paths', async () => {
    directoryCalls.length = 0
    const server = await serve(makeMobileApiRoutes({ service, apiProxy, mobileEnterToSend }))
    try {
      const payload = { path: 'C:\\Users\\tester\\project' }
      const { status, body } = await call(server.port, 'host.listDirectory', payload)
      expect(status).toBe(200)
      expect(JSON.parse(body)).toMatchObject({ type: 'server-response', result: { ok: true } })
      expect(directoryCalls).toEqual([expect.objectContaining({ payload })])
    } finally {
      await server.close()
    }
  })

  it('answers mobile.preferences locally from the plugin config', async () => {
    let mobileEnterToSend = true
    const server = await serve(makeMobileApiRoutes({
      service,
      apiProxy,
      mobileEnterToSend: () => mobileEnterToSend,
    }))
    try {
      const first = await call(server.port, 'mobile.preferences')
      expect(first.status).toBe(200)
      expect(JSON.parse(first.body)).toEqual({
        type: 'server-response',
        rpcId: 'probe-1',
        result: { ok: true, value: { mobileEnterToSend: true } },
      })

      mobileEnterToSend = false
      const second = await call(server.port, 'mobile.preferences')
      expect(second.status).toBe(200)
      expect(JSON.parse(second.body)).toEqual({
        type: 'server-response',
        rpcId: 'probe-1',
        result: { ok: true, value: { mobileEnterToSend: false } },
      })
    } finally {
      await server.close()
    }
  })

  it('heartbeat keep-alive reuses the single SSE connection (no new socket)', async () => {
    const blockingProxy = {
      ...apiProxy,
      events: { mux: () => (async function* () { while (true) { await new Promise(() => {}) } })() },
    } as unknown as ApiProxy
    const routes = makeMobileApiRoutes({ service, apiProxy: blockingProxy, mobileEnterToSend, eventsHeartbeatMs: 25 })
    let connections = 0
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://x').pathname
      const exact = routes.find(r => r.kind === 'exact' && r.path === pathname)
      const route = exact ?? routes.find(r => r.kind === 'prefix' && pathname.startsWith(r.path))
      if (route === undefined) {
        response.writeHead(404)
        response.end()
        return
      }
      void route.handler(request, response)
    })
    server.on('connection', () => { connections += 1 })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo

    let sseData = ''
    let resolveDone: (() => void) | undefined
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    const req = httpRequest({
      host: '127.0.0.1', port: address.port, path: '/m/api/events.mux', method: 'GET',
      headers: { cookie: 'dsh_pair=device-1' },
    }, (response) => {
      response.on('data', (chunk) => {
        sseData += (chunk as Buffer).toString('utf8')
        // Two keep-alive pings prove the heartbeat is writing to this stream.
        if ((sseData.match(/: ping/g) ?? []).length >= 2) resolveDone?.()
      })
    })
    req.on('error', () => { resolveDone?.() })
    req.end()

    await done
    // The heartbeat wrote two pings onto the SAME open SSE connection; no
    // additional socket was opened for keep-alive (reuse of the single stream).
    expect((sseData.match(/: ping/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(connections).toBe(1)

    req.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('forwards a question response payload without rewriting its answer labels', async () => {
    respondCalls.length = 0
    const server = await serve(makeMobileApiRoutes({ service, apiProxy, mobileEnterToSend }))
    const result = {
      ok: true,
      value: { sessionId: 'session-plan', answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] } },
    }
    try {
      const { status, body } = await call(server.port, 'events.respond', { result })
      expect(status).toBe(200)
      expect(JSON.parse(body)).toMatchObject({ type: 'server-response', result: { ok: true } })
      expect(respondCalls).toEqual([{ type: 'client-response', rpcId: 'probe-1', result }])
    } finally {
      await server.close()
    }
  })

  it.each(['queue', 'steer'] as const)('forwards session.prompt mode %s unchanged', async (mode) => {
    promptCalls.length = 0
    const server = await serve(makeMobileApiRoutes({ service, apiProxy, mobileEnterToSend }))
    const payload = { sessionId: 'session-mobile', mode, content: [{ type: 'text', text: `mobile-${mode}` }] }
    try {
      const { status, body } = await call(server.port, 'session.prompt', payload)
      expect(status).toBe(200)
      expect(JSON.parse(body)).toMatchObject({ type: 'server-response', result: { ok: true } })
      expect(promptCalls).toEqual([expect.objectContaining({ payload: expect.objectContaining(payload) })])
    } finally {
      await server.close()
    }
  })

  it('compacts history below the relay frame budget while retaining bounded tool details', () => {
    const longText = '汉'.repeat(40_000)
    const value = compactMobileHistoryValue({
      events: [
        { event: { type: 'user/message', seq: 1, time: 1, data: { id: 'u1', content: [{ type: 'text', text: longText }] } } },
        { event: { type: 'assistant/chunk', seq: 2, time: 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '应被最终消息替代' } } } },
        { event: { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'ssh_exec', arguments: { password: 'must-not-cross-relay' } } } },
        { event: { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 1, usage: { inputTokens: 999 }, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: longText }] } } } },
        { event: { type: 'assistant/chunk', seq: 5, time: 5, data: { turn: 2, step: 1, chunk: { type: 'reasoning-delta', text: 'private reasoning' } } } },
        { event: { type: 'assistant/chunk', seq: 6, time: 6, data: { turn: 2, step: 1, chunk: { type: 'text-delta', text: '仍在生成' } } } },
        { event: { type: 'turn/end', seq: 7, time: 7, data: { turn: 2, reason: { kind: 'error', message: 'internal detail' } } } },
      ],
      hasMore: false,
      projections: { asOfSeq: 7, values: { permissions: { currentValue: 'full-access' } } },
    }) as { events: Array<{ event: { type: string; data: Record<string, unknown> } }>; mobileTruncated?: boolean; projections?: unknown }

    const json = JSON.stringify(value)
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(96 * 1024)
    expect(json).toContain('must-not-cross-relay')
    expect(json).toContain('private reasoning')
    expect(json).not.toContain('inputTokens')
    expect(json).not.toContain('应被最终消息替代')
    expect(json).toContain('仍在生成')
    expect(json).toContain('ssh_exec')
    expect(value.mobileTruncated).toBe(true)
    expect(value.projections).toEqual({ asOfSeq: 7, values: { permissions: { currentValue: 'full-access' } } })
  })

  it('preserves conversation rows when tool-heavy history consumes the frame budget', () => {
    const events: Array<{ event: Record<string, unknown> }> = []
    let seq = 1
    for (let turn = 1; turn <= 4; turn += 1) {
      events.push({ event: { type: 'user/message', seq: seq++, data: {
        source: { kind: 'user' }, content: [{ type: 'text', text: `USER_${turn}` }],
      } } })
      events.push({ event: { type: 'assistant/message', seq: seq++, data: {
        turn, step: 1, message: { role: 'assistant', id: `assistant-${turn}`, content: [{ type: 'text', text: `ASSISTANT_${turn}` }] },
      } } })
      for (let tool = 0; tool < 12; tool += 1) {
        events.push({ event: { type: 'tool/call', seq: seq++, data: {
          turn, step: tool + 2, callId: `call-${turn}-${tool}`, name: 'run_code',
          arguments: JSON.stringify({ description: 'x'.repeat(8_000) }),
        } } })
      }
    }
    const value = compactMobileHistoryValue({ events }) as {
      events: Array<{ event: { type: string; data: Record<string, unknown> } }>
      mobileTruncated?: boolean
    }
    const json = JSON.stringify(value)
    for (let turn = 1; turn <= 4; turn += 1) {
      expect(json).toContain(`USER_${turn}`)
      expect(json).toContain(`ASSISTANT_${turn}`)
    }
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(96 * 1024)
    expect(value.mobileTruncated).toBe(true)
  })

  it('projects Harness context and developer-visible tool details without forwarding usage', () => {
    const value = compactMobileHistoryValue({
      events: [
        { event: { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '<system-reminder>\nThe following workspace instructions may be relevant.\nInstructions from: AGENTS.md\nSECRET-CONTEXT\n</system-reminder>' }] } } },
        { event: { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nSECRET-RUNTIME' }] } } },
        { event: { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{"token":"SECRET-ARG"}' } } },
        { event: { type: 'tool/result', seq: 4, time: 4, data: { turn: 1, step: 1, message: { source: { callId: 'call-1' }, content: [{ type: 'text', content: 'SECRET-OUTPUT', isError: false }] } } } },
        { event: { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed', internal: 'SECRET-END' } } } },
      ],
    }) as { events: Array<{ event: { type: string; data: Record<string, unknown> } }> }

    expect(value.events).toEqual([
      { event: { type: 'context/injection', seq: 1, time: 1, data: {
        summary: '已应用工作区说明', source: 'harness-context',
        metadata: { role: 'inject', producerLabel: null, form: null, bodyAvailability: 'desktop-only' },
      } } },
      { event: { type: 'context/injection', seq: 2, time: 2, data: {
        summary: '已应用运行上下文', source: 'harness-context',
        metadata: { role: 'inject', producerLabel: null, form: null, bodyAvailability: 'desktop-only' },
      } } },
      { event: { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{"token":"SECRET-ARG"}' } } },
      { event: { type: 'tool/result', seq: 4, time: 4, data: { turn: 1, step: 1, callId: 'call-1', isError: false, output: '[{"type":"text","content":"SECRET-OUTPUT","isError":false}]' } } },
      { event: { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } } },
    ])
    const json = JSON.stringify(value)
    expect(json).not.toContain('SECRET-CONTEXT')
    expect(json).not.toContain('SECRET-RUNTIME')
    expect(json).toContain('SECRET-ARG')
    expect(json).toContain('SECRET-OUTPUT')
    expect(json).not.toContain('SECRET-END')
  })

  it('projects every dedicated context form as bounded metadata and never forwards its body', () => {
    const value = compactMobileHistoryValue({
      events: [
        { event: { type: 'user/message', seq: 1, data: { source: {
          kind: 'agent-instructions', form: 'instructions', baseline: true,
          changes: [{ action: 'set', path: 'AGENTS.md', digest: 'SECRET-DIGEST' }],
        }, content: [{ type: 'text', text: 'SECRET-INSTRUCTIONS' }] } } },
        { event: { type: 'user/message', seq: 2, data: { source: {
          kind: 'plugin', plugin: 'skills', form: 'catalog', update: true,
          entries: [{ name: 'browser', description: 'SECRET-DESCRIPTION' }],
        }, content: [{ type: 'text', text: 'SECRET-CATALOG' }] } } },
        { event: { type: 'user/message', seq: 3, data: { source: {
          kind: 'plugin', plugin: 'runtime', form: 'snapshot', sections: [{ name: 'runtime', text: 'SECRET-SNAPSHOT' }],
        }, content: [{ type: 'text', text: 'SECRET-SNAPSHOT' }] } } },
        { event: { type: 'user/message', seq: 4, data: { source: {
          kind: 'plugin', plugin: 'notice', form: 'notice', summary: 'SECRET-NOTICE',
        }, content: [{ type: 'text', text: 'SECRET-NOTICE-BODY' }] } } },
        { event: { type: 'user/message', seq: 5, data: { source: {
          kind: 'plugin', plugin: 'relay', form: 'relay', senderSessionId: 'sender-session',
        }, content: [{ type: 'text', text: 'SECRET-RELAY' }] } } },
        { event: { type: 'user/message', seq: 6, data: { source: {
          kind: 'session-reference', form: 'recall', references: [{ label: 'Earlier session', retainedMessages: 2, omittedMessages: 1, truncated: true }],
        }, content: [{ type: 'text', text: 'SECRET-RECALL' }] } } },
      ],
    }) as { events: Array<{ event: { type: string; data: Record<string, unknown> } }> }

    expect(value.events.map(item => item.event.data.metadata)).toEqual([
      { role: 'inject', producerLabel: 'AGENTS.md', form: 'instructions', bodyAvailability: 'desktop-only', changes: [{ action: 'loaded', path: 'AGENTS.md' }] },
      { role: 'inject', producerLabel: 'skills', form: 'catalog', bodyAvailability: 'desktop-only', names: ['browser'], replaced: true },
      { role: 'inject', producerLabel: 'runtime', form: 'snapshot', bodyAvailability: 'desktop-only', sectionNames: ['runtime'] },
      { role: 'inject', producerLabel: 'notice', form: 'notice', bodyAvailability: 'desktop-only' },
      { role: 'inject', producerLabel: 'relay', form: 'relay', bodyAvailability: 'desktop-only', senderSessionId: 'sender-session' },
      { role: 'recall', producerLabel: 'Earlier session', form: 'recall', bodyAvailability: 'desktop-only', references: [{ label: 'Earlier session', retainedMessages: 2, omittedMessages: 1, truncated: true }] },
    ])
    const json = JSON.stringify(value)
    for (const secret of ['SECRET-INSTRUCTIONS', 'SECRET-DESCRIPTION', 'SECRET-SNAPSHOT', 'SECRET-NOTICE', 'SECRET-RELAY', 'SECRET-RECALL', 'SECRET-DIGEST']) {
      expect(json).not.toContain(secret)
    }
  })

  it('keeps Code Mode sub-dispatch hierarchy and full developer details bounded', () => {
    const value = compactMobileHistoryValue({
      events: [
        { event: { type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: '{"description":"Find settings"}' } } },
        { event: { type: 'tool/code-dispatch-start', seq: 2, data: { turn: 1, step: 1, rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1', name: 'grep', arguments: { description: 'Find settings', query: 'settings' } } } },
        { event: { type: 'tool/code-dispatch', seq: 3, data: { turn: 1, step: 1, rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1', name: 'grep', isError: false, content: [{ type: 'text', text: 'settings.json' }] } } },
      ],
    }) as { events: Array<{ event: { type: string; data: Record<string, unknown> } }> }
    expect(value.events).toEqual([
      { event: { type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'root', name: 'run_code', summary: 'Find settings', arguments: '{"description":"Find settings"}' } } },
      { event: { type: 'tool/code-dispatch-start', seq: 2, data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1', name: 'grep', summary: 'Find settings', arguments: '{"description":"Find settings","query":"settings"}' } } },
      { event: { type: 'tool/code-dispatch', seq: 3, data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1', name: 'grep', isError: false, output: '[{"type":"text","text":"settings.json"}]' } } },
    ])
  })

  it('projects compaction and retry lifecycle without diagnostic payloads', () => {
    const value = compactMobileHistoryValue({
      events: [
        { event: { type: 'compaction/start', seq: 1, data: { compactionId: 'compact-1', turn: 1 } } },
        { event: { type: 'compaction/summary', seq: 2, data: { compactionId: 'compact-1', shadowedSeqs: [1, 2], shadowedTokenCount: 300, summary: [{ type: 'text', text: 'SECRET-SUMMARY' }], rawOutput: [{ type: 'text', text: 'SECRET-RAW' }] } } },
        { event: { type: 'compaction/end', seq: 3, data: { compactionId: 'compact-1', error: 'SECRET-COMPACTION-ERROR' } } },
        { event: { type: 'user/message', seq: 4, data: { source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text', text: 'SECRET-CHECKPOINT' }] } } },
        { event: { type: 'llm/retry', seq: 5, time: 10, data: { retryId: 'retry-1', turn: 2, step: 1, retry: 1, maxRetries: 3, delayMs: 5000, provider: 'SECRET-PROVIDER', failure: { message: 'SECRET-FAILURE' } } } },
        { event: { type: 'llm/retry-started', seq: 6, time: 20, data: { retryId: 'retry-1', turn: 2, step: 1, retry: 1 } } },
      ],
    }) as { events: Array<{ event: { type: string; data: Record<string, unknown> } }> }
    expect(value.events.map(item => item.event.type)).toEqual(['mobile/compaction', 'mobile/compaction', 'mobile/compaction', 'mobile/model-retry', 'mobile/model-retry'])
    expect(value.events[1]?.event.data).toMatchObject({ compactionId: 'compact-1', state: 'running', shadowedItems: 2, shadowedTokens: 300 })
    expect(value.events[2]?.event.data).toEqual({ compactionId: 'compact-1', state: 'error' })
    expect(value.events[4]?.event.data).toMatchObject({ retryId: 'retry-1', retry: 1, maximum: null, state: 'started' })
    const json = JSON.stringify(value)
    for (const secret of ['SECRET-SUMMARY', 'SECRET-RAW', 'SECRET-COMPACTION-ERROR', 'SECRET-CHECKPOINT', 'SECRET-PROVIDER', 'SECRET-FAILURE']) {
      expect(json).not.toContain(secret)
    }
  })

  it('uses the same sanitizer for live mux frames and projections', () => {
    const frame = compactMobileMuxFrame({
      rpcId: 'mux-1',
      payload: {
        type: 'session/event', sessionId: 's1',
        event: { type: 'user/message', seq: 1, data: { source: { kind: 'plugin', plugin: 'safe', form: 'relay', senderSessionId: 's2' }, content: [{ type: 'text', text: 'SECRET-LIVE' }] } },
      },
    }) as { payload: { event: { type: string; data: Record<string, unknown> } } }
    expect(frame.payload.event.type).toBe('context/injection')
    expect(JSON.stringify(frame)).not.toContain('SECRET-LIVE')
    expect(compactMobileMuxFrame({ rpcId: 'mux-2', payload: { type: 'session/event', event: { type: 'unknown/private', data: { secret: 'SECRET-UNKNOWN' } } } })).toBeUndefined()
    expect(compactMobileProjections({ asOfSeq: 9, values: {
      title: 'Session', goal: 'SECRET-GOAL', tokenUsage: { outputTokens: 4, private: 'SECRET-PROJECTION' },
    } })).toEqual({ asOfSeq: 9, values: { title: 'Session', tokenUsage: { outputTokens: 4 } } })
  })
})
