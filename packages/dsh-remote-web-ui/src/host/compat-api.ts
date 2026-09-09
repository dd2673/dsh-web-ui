/** Stable private device wire implemented through the public 0.1.2 Gateway. */
import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { createRemoteHostApi, type TypertGatewayLike, type HostConnectionLike } from './remote-host-api.ts'
import type { RespondResult } from './protocol.ts'

export function createRemoteCompatibilityApi(gateway: TypertGatewayLike, connection: HostConnectionLike): ApiProxy {
  const remote = createRemoteHostApi(gateway, connection, true)
  const invoke = (method: string) => async (request: { rpcId: string; payload: unknown }, signal = new AbortController().signal) => ({
    rpcId: request.rpcId,
    result: await remote.call({ ...request, payload: request.payload ?? {}, method, signal }),
  })
  const domain = (name: string, methods: string[]) => Object.fromEntries(methods.map(method => [method, invoke(`${name}.${method}`)]))
  return {
    sessions: domain('session', ['list', 'create', 'history', 'search', 'prompt', 'models', 'selectModel', 'rename', 'cancel', 'updateQueue', 'attachment']),
    workspace: domain('workspace', ['list', 'create', 'archiveSession']),
    host: domain('host', ['listDirectory']),
    skills: domain('skill', ['list']),
    agentPresets: domain('agentPreset', ['list', 'select']),
    settings: domain('settings', ['describe', 'mutate']),
    credentials: domain('credentials', ['describe', 'set', 'unset']),
    llm: domain('llm', ['discoverModels']),
    events: { mux: (_request: unknown, signal: AbortSignal) => remote.events(signal) },
    respond: (message: { rpcId: string; result: RespondResult }) => remote.respond(message.rpcId, message.result, new AbortController().signal),
  } as unknown as ApiProxy
}

/** Carrier for the existing authenticated bridge server; no HTTP request leaves this process. */
export function compatibilityFetchHandler(api: ApiProxy): { fetch(request: Request): Promise<Response> } {
  return { async fetch(request) {
    const body = await request.json() as { rpcId: string; method: string; payload: unknown }
    if (body.method === 'events.respond') {
      const payload = body.payload as { result: RespondResult }
      const receipt = await api.respond({ type: 'client-response', rpcId: body.rpcId, result: payload.result } as never)
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: receipt.accepted ? { ok: true, value: receipt } : { ok: false, error: { code: 'not-found', message: receipt.reason, details: {} } } })
    }
    const [namespace, method] = body.method.split('.')
    const domains: Record<string, string> = { session: 'sessions', skill: 'skills', agentPreset: 'agentPresets' }
    const domainName = Object.hasOwn(domains, namespace!) ? domains[namespace!]! : namespace!
    const owners = api as unknown as Record<string, Record<string, unknown>>
    const owner = Object.hasOwn(owners, domainName) ? owners[domainName] : undefined
    const operation = owner && Object.hasOwn(owner, method!) ? owner[method!] : undefined
    if (typeof operation !== 'function') return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'not-found', message: 'Unsupported bridge method', details: {} } } })
    const result = await operation.call(owner, { rpcId: body.rpcId, payload: body.payload }, request.signal) as { result: unknown }
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: result.result })
  } }
}

/** Connection is present after the release-specific Host API owner has mounted. */
export function resolveCompatibilityApi(ctx: Context): ApiProxy {
  const legacy = ctx.get('apiProxy')
  if (legacy !== undefined) return legacy
  const gateway = ctx.get('typertGateway' as never) as unknown as TypertGatewayLike
  const connection = ctx.get('connection' as never) as unknown as HostConnectionLike
  if (typeof gateway?.invoke !== 'function' || typeof gateway?.wireStream?.open !== 'function'
    || typeof connection?.createSharedFetchHandler !== 'function') {
    throw new Error('DSH remote control requires apiProxy or the 0.1.2 Gateway wire API')
  }
  return createRemoteCompatibilityApi(gateway, connection)
}
