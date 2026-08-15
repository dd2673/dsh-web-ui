/**
 * The mobile surface's data channel: `/m/api` proxies the host ApiProxy
 * service for the standalone phone page. The phone's RPC calls ride THIS
 * prefix instead of the connection plugin's `/api` — so the tunneled Host
 * never needs to enter the connection trust fence (a distributable plugin
 * cannot change that fence), and this plugin's own pairing gate is the
 * access control instead.
 *
 * Security model:
 * - Every request must carry a live paired-device cookie (the same gate
 *   semantic as the LAN fence), enforced before any host call.
 * - Only an explicit allowlist of methods is proxied; privileged domains
 *   (settings, credentials, host actions, goals, subagents, …) are never
 *   reachable from the phone.
 * - `session.list` is paged here (the host API returns everything; this
 *   layer slices stable pages) so the phone never transfers the whole list.
 * - The live mux stream is bridged over Server-Sent Events on the same
 *   prefix (one-directional push; answers to questions/approvals ride the
 *   unary channel), gated identically.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { ClientResponse, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { PairingService } from './pairing.ts'
import { readCookie } from './gate.ts'

/** Methods the phone surface may call. Everything else is refused. */
export const MOBILE_ALLOWLIST = new Set([
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
])

/** Keep one relay response comfortably below the 128 KiB WebSocket frame cap. */
const MOBILE_HISTORY_MAX_BYTES = 96 * 1024
/** One unusually long message must not evict the whole recent conversation. */
const MOBILE_HISTORY_TEXT_MAX_BYTES = 24 * 1024
const MOBILE_HISTORY_TRUNCATION_MARKER = '\n[内容过长，移动端仅显示部分内容]'

/** Public guard shared by the local HTTP carrier and the relay carrier. */
export function isMobileMethodAllowed(method: string): boolean {
  return MOBILE_ALLOWLIST.has(method)
}

/**
 * Locally answered display-preference method (the phone's read-only
 * surface preferences; never proxied to the host ApiProxy and never a
 * settings-domain write).
 */
const MOBILE_PREFERENCES_METHOD = 'mobile.preferences'

/** One session.list page (thin phones load incrementally). */
const SESSION_PAGE_SIZE = 20
/** SSE keep-alive ping cadence for the live mux stream (single connection). */
const DEFAULT_EVENTS_HEARTBEAT_MS = 15_000

/** Encode one list position as an opaque continuation cursor. */
function sessionListCursor(updatedAt: number, sessionId: string): string {
  return `${updatedAt}:${sessionId}`
}

/** Parse a cursor; malformed cursors mean "start over" (safe failure mode). */
function parseSessionListCursor(cursor: string): { updatedAt: number; sessionId: string } | undefined {
  const separator = cursor.indexOf(':')
  if (separator < 0) return undefined
  const updatedAt = Number(cursor.slice(0, separator))
  if (!Number.isFinite(updatedAt)) return undefined
  return { updatedAt, sessionId: cursor.slice(separator + 1) }
}

/** Whether a row comes strictly after the cursor position. */
function afterCursor(row: { updatedAt: number; sessionId: string }, position: { updatedAt: number; sessionId: string }): boolean {
  return row.updatedAt < position.updatedAt
    || (row.updatedAt === position.updatedAt && row.sessionId > position.sessionId)
}

/** A stable turn/step key for replacing streamed chunks with the final message. */
function historyStepKey(event: { data?: Record<string, unknown> }): string {
  const data = event.data ?? {}
  return `${String(data.turn ?? '')}:${String(data.step ?? '')}`
}

/** Truncate by UTF-8 bytes rather than JS code units so CJK text stays within the wire budget. */
function truncateHistoryText(value: unknown): { text: string; truncated: boolean } {
  const text = typeof value === 'string' ? value : ''
  if (Buffer.byteLength(text, 'utf8') <= MOBILE_HISTORY_TEXT_MAX_BYTES) return { text, truncated: false }
  const markerBytes = Buffer.byteLength(MOBILE_HISTORY_TRUNCATION_MARKER, 'utf8')
  const bodyBudget = Math.max(0, MOBILE_HISTORY_TEXT_MAX_BYTES - markerBytes)
  const source = Buffer.from(text, 'utf8').subarray(0, bodyBudget)
  // Drop incomplete trailing UTF-8 bytes instead of emitting a replacement character.
  const body = new TextDecoder('utf-8', { fatal: false }).decode(source).replace(/\uFFFD+$/u, '')
  return { text: `${body}${MOBILE_HISTORY_TRUNCATION_MARKER}`, truncated: true }
}

/** Keep only text blocks needed by the Android transcript. */
function compactContent(value: unknown): { content: Array<{ type: 'text'; text: string }>; truncated: boolean } {
  if (!Array.isArray(value)) return { content: [], truncated: false }
  let truncated = false
  const content = value.flatMap((block): Array<{ type: 'text'; text: string }> => {
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate?.type !== 'text') return []
    const bounded = truncateHistoryText(candidate.text)
    truncated ||= bounded.truncated
    return [{ type: 'text', text: bounded.text }]
  })
  return { content, truncated }
}

/**
 * Harness logs injected workspace instructions as a system-reminder carrier.
 * Desktop renders that carrier as context chrome, not as a user message. The
 * phone keeps the same semantic without transferring the instruction body.
 */
function internalContextSummary(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const text = value
    .filter(block => block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
    .map(block => String((block as { text?: unknown }).text ?? ''))
    .join('')
    .trimStart()
  if (text.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')) {
    return '已应用运行上下文'
  }
  if (text.startsWith('<system-reminder>')) {
    return /workspace instructions|Instructions from:/i.test(text)
      ? '已应用工作区说明'
      : '已应用会话上下文'
  }
  return undefined
}

/**
 * Project Host history onto the small, privacy-minimised transcript needed by Android.
 * Stream deltas are retained only for an unfinished step; completed steps use their
 * final assistant message. Tool arguments/results, context bodies, reasoning,
 * usage and approvals do not cross the relay; only a safe tool lifecycle bit
 * and a compact context summary remain.
 */
export function compactMobileHistoryValue(value: unknown): unknown {
  const source = value as { events?: unknown[]; hasMore?: boolean; projections?: unknown }
  const wrappers = Array.isArray(source?.events) ? source.events : []
  const events = wrappers
    .map(wrapper => (wrapper as { event?: unknown })?.event ?? wrapper)
    .filter((event): event is Record<string, unknown> => event !== null && typeof event === 'object')
  const finalized = new Set(events
    .filter(event => event.type === 'assistant/message')
    .map(event => historyStepKey(event as { data?: Record<string, unknown> })))
  let mobileTruncated = false
  const compacted = events.flatMap((event): unknown[] => {
    const type = typeof event.type === 'string' ? event.type : ''
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    const time = typeof event.time === 'number' ? event.time : undefined
    const data = event.data !== null && typeof event.data === 'object'
      ? event.data as Record<string, unknown>
      : {}
    const envelope = (nextData: unknown, nextType = type): unknown => ({
      event: {
        type: nextType,
        ...(seq !== undefined ? { seq } : {}),
        ...(time !== undefined ? { time } : {}),
        data: nextData,
      },
    })
    if (type === 'user/message') {
      const contextSummary = internalContextSummary(data.content)
      if (contextSummary !== undefined) {
        return [envelope({ summary: contextSummary, source: 'harness-context' }, 'context/injection')]
      }
      const bounded = compactContent(data.content)
      mobileTruncated ||= bounded.truncated
      return [envelope({ content: bounded.content, id: data.id })]
    }
    if (type === 'assistant/message') {
      const message = data.message !== null && typeof data.message === 'object'
        ? data.message as Record<string, unknown>
        : {}
      const bounded = compactContent(message.content)
      mobileTruncated ||= bounded.truncated
      return [envelope({
        turn: data.turn,
        step: data.step,
        message: { role: 'assistant', content: bounded.content, id: message.id },
      })]
    }
    if (type === 'assistant/chunk') {
      if (finalized.has(historyStepKey({ data }))) return []
      const chunk = data.chunk !== null && typeof data.chunk === 'object'
        ? data.chunk as Record<string, unknown>
        : {}
      if (chunk.type !== 'text-delta') return []
      const bounded = truncateHistoryText(chunk.text)
      mobileTruncated ||= bounded.truncated
      return [envelope({
        turn: data.turn,
        step: data.step,
        chunk: { type: 'text-delta', index: chunk.index, text: bounded.text },
      })]
    }
    if (type === 'tool/call') {
      return [envelope({ turn: data.turn, step: data.step, callId: data.callId, name: data.name })]
    }
    if (type === 'tool/result') {
      const message = data.message !== null && typeof data.message === 'object'
        ? data.message as Record<string, unknown>
        : {}
      const sourceData = message.source !== null && typeof message.source === 'object'
        ? message.source as Record<string, unknown>
        : {}
      const blocks = Array.isArray(message.content) ? message.content : []
      const isError = data.error !== undefined || blocks.some(block => (
        block !== null && typeof block === 'object' && (block as { isError?: unknown }).isError === true
      ))
      return [envelope({
        turn: data.turn,
        step: data.step,
        callId: sourceData.callId ?? data.callId,
        isError,
      })]
    }
    const reason = data.reason !== null && typeof data.reason === 'object'
      ? data.reason as Record<string, unknown>
      : undefined
    if (type === 'turn/end' && typeof reason?.kind === 'string') {
      const safeKind = ['completed', 'error', 'interrupted', 'cancelled', 'max-tokens'].includes(reason.kind)
        ? reason.kind
        : 'completed'
      return [envelope({ turn: data.turn, reason: { kind: safeKind } })]
    }
    return []
  })

  // Keep the newest complete transcript slice when even compacted history is too large.
  const accepted: unknown[] = []
  for (let index = compacted.length - 1; index >= 0; index -= 1) {
    const candidate = [compacted[index], ...accepted]
    const projected = {
      events: candidate,
      hasMore: source.hasMore === true || index > 0,
      ...(source.projections !== undefined ? { projections: source.projections } : {}),
      ...(mobileTruncated || index > 0 ? { mobileTruncated: true } : {}),
    }
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > MOBILE_HISTORY_MAX_BYTES) {
      mobileTruncated = true
      continue
    }
    accepted.unshift(compacted[index])
  }
  return {
    events: accepted,
    hasMore: source.hasMore === true || accepted.length < compacted.length,
    ...(source.projections !== undefined ? { projections: source.projections } : {}),
    ...(mobileTruncated || accepted.length < compacted.length ? { mobileTruncated: true } : {}),
  }
}

/** Route-family dependencies. */
export interface MobileApiDeps {
  /** The pairing service (device gate + cookie name). */
  service: PairingService
  /** The host ApiProxy service (injected by the plugin). */
  apiProxy: ApiProxy
  /** The resolved mobile composer preference (live per request). */
  mobileEnterToSend: () => boolean
  /** SSE keep-alive ping cadence for the mux stream (default 15000 ms; test seam). */
  eventsHeartbeatMs?: number
}

/** Mobile API route paths. */
export const MOBILE_API_PATHS = {
  events: '/m/api/events.mux',
} as const

/** The mobile-api prefix (every other path under it is a method name). */
const MOBILE_API_PREFIX = '/m/api'
/** Method extraction: the prefix plus one slash. */
const MOBILE_API_METHOD_PREFIX = `${MOBILE_API_PREFIX}/`

/**
 * Build the mobile data-channel routes.
 * @param deps - pairing service + apiProxy.
 * @returns the routes to register on webServer.
 */
export function makeMobileApiRoutes(deps: MobileApiDeps): WebRoute[] {
  const { service, apiProxy, mobileEnterToSend } = deps
  const eventsHeartbeatMs = deps.eventsHeartbeatMs ?? DEFAULT_EVENTS_HEARTBEAT_MS

  /** The phone gate: a live paired-device cookie, or nothing else proceeds. */
  const gateOk = (req: IncomingMessage): boolean => {
    const deviceId = readCookie(req.headers.cookie, service.config.cookieName)
    return deviceId !== undefined && service.hasDevice(deviceId)
  }

  const writeJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const handleMethod = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    if (!gateOk(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'unpaired', message: 'mobile session is not paired' } })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (!pathname.startsWith(MOBILE_API_METHOD_PREFIX)) {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown mobile api path' } })
      return
    }
    const method = pathname.slice(MOBILE_API_METHOD_PREFIX.length)
    const local = method === MOBILE_PREFERENCES_METHOD
    if (!isMobileMethodAllowed(method) && !local) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: `method ${method} is not exposed to the mobile surface` } })
      return
    }
    let envelope: unknown
    try {
      envelope = await readJsonBody(req)
    } catch {
      writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'invalid json body' } })
      return
    }
    const parsed = envelope as { rpcId?: unknown; payload?: unknown }
    const rpcId = typeof parsed?.rpcId === 'string' ? parsed.rpcId : ''
    if (rpcId === '') {
      writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'missing rpcId' } })
      return
    }
    if (local) {
      writeJson(res, 200, {
        type: 'server-response',
        rpcId,
        result: { ok: true, value: { mobileEnterToSend: mobileEnterToSend() } },
      })
      return
    }
    try {
      const response = await dispatchMobileMethod(apiProxy, method, parsed?.payload, rpcId)
      writeJson(res, 200, response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeJson(res, 200, {
        type: 'server-response',
        rpcId,
        result: { ok: false, error: { code: 'internal', message } },
      })
    }
  }

  /** Bridge the host mux stream over SSE: one `data:` frame per mux frame. */
  const handleEvents = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    if (!gateOk(req)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const controller = new AbortController()
    let closed = false
    const heartbeat = setInterval(() => {
      if (closed) return
      try {
        res.write(': ping\n\n')
      } catch {
        // The write failed; the close handler tears the subscription down.
      }
    }, eventsHeartbeatMs)
    const onClose = (): void => {
      if (closed) return
      closed = true
      controller.abort()
      clearInterval(heartbeat)
    }
    res.on('close', onClose)
    req.on('close', onClose)
    try {
      const frames = apiProxy.events.mux({ rpcId: RpcId(`mobile-mux-${Date.now().toString(36)}`), payload: {} }, controller.signal)
      for await (const frame of frames) {
        if (closed) break
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      }
    } catch {
      // The stream ended or errored; the EventSource reconnects.
    } finally {
      controller.abort()
      clearInterval(heartbeat)
    }
    if (!closed) res.end()
  }

  return [
    { kind: 'prefix', path: MOBILE_API_PREFIX, handler: handleMethod },
    { kind: 'exact', path: MOBILE_API_PATHS.events, handler: handleEvents },
  ]
}

/** Read a request body as JSON (bounded). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Dispatch one allowlisted method through the host ApiProxy. */
export async function dispatchMobileMethod(apiProxy: ApiProxy, method: string, payload: unknown, rpcId: string): Promise<unknown> {
  if (!isMobileMethodAllowed(method)) throw new Error(`mobile method ${method} is not allowed`)
  const request: RpcRequest<unknown> = { rpcId: RpcId(rpcId), payload }
  if (method === 'session.list') {
    const full = await apiProxy.sessions.list(request as never)
    if (!full.result.ok) return full
    const items = full.result.value.items as Array<{ updatedAt: number; sessionId: string }>
    const cursor = (payload as { cursor?: string } | undefined)?.cursor
    // Every call pages (the first call with no cursor IS the first page):
    // the phone must never transfer the whole session list at once.
    // One stable page over (updatedAt desc, sessionId asc); pages never skip
    // or repeat a row while the list changes between calls.
    items.sort((a, b) => b.updatedAt - a.updatedAt
      || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    const position = cursor === undefined ? undefined : parseSessionListCursor(cursor)
    const from = position === undefined ? 0 : items.findIndex(row => afterCursor(row, position))
    const start = from < 0 ? items.length : from
    const page = items.slice(start, start + SESSION_PAGE_SIZE)
    const last = page[page.length - 1]
    const nextCursor = last !== undefined && start + page.length < items.length
      ? sessionListCursor(last.updatedAt, last.sessionId)
      : undefined
    return {
      type: 'server-response',
      rpcId,
      result: {
        ok: true,
        value: {
          items: page,
          hasMore: nextCursor !== undefined,
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        },
      },
    }
  }
  // The ApiProxy unary methods resolve to the internal response shape
  // ({ rpcId, result }) without the transport envelope the phone's callUnary
  // requires — wrap every pass-through in the same 'server-response'
  // envelope session.list builds above.
  const wrap = (response: { rpcId: string; result: unknown }): unknown => ({
    type: 'server-response' as const,
    rpcId,
    result: response.result,
  })
  if (method === 'workspace.list') return wrap(await apiProxy.workspace.list(request as never))
  if (method === 'workspace.create') return wrap(await apiProxy.workspace.create(request as never))
  if (method === 'workspace.archiveSession') return wrap(await apiProxy.workspace.archiveSession(request as never))
  if (method === 'host.listDirectory') return wrap(await apiProxy.host.listDirectory(request as never, new AbortController().signal))
  if (method === 'session.create') return wrap(await apiProxy.sessions.create(request as never))
  if (method === 'session.history') {
    const response = await apiProxy.sessions.history(request as never)
    if (!response.result.ok) return wrap(response)
    return {
      type: 'server-response' as const,
      rpcId,
      result: { ok: true, value: compactMobileHistoryValue(response.result.value) },
    }
  }
  if (method === 'session.search') return wrap(await apiProxy.sessions.search(request as never, new AbortController().signal))
  if (method === 'session.prompt') return wrap(await apiProxy.sessions.prompt(request as never))
  if (method === 'session.models') return wrap(await apiProxy.sessions.models(request as never))
  if (method === 'session.selectModel') return wrap(await apiProxy.sessions.selectModel(request as never))
  if (method === 'session.rename') return wrap(await apiProxy.sessions.rename(request as never))
  if (method === 'session.cancel') return wrap(await apiProxy.sessions.cancel(request as never))
  if (method === 'session.updateQueue') return wrap(await apiProxy.sessions.updateQueue(request as never))
  if (method === 'skill.list') return wrap(await apiProxy.skills.list(request as never))
  if (method === 'agentPreset.list') return wrap(await apiProxy.agentPresets.list(request as never))
  if (method === 'agentPreset.select') return wrap(await apiProxy.agentPresets.select(request as never))
  if (method === 'events.respond') {
    const value = payload as { result?: unknown } | undefined
    const message: ClientResponse = {
      type: 'client-response',
      rpcId: RpcId(rpcId),
      result: value?.result as ClientResponse['result'],
    }
    const receipt = await apiProxy.respond(message)
    return {
      type: 'server-response' as const,
      rpcId,
      result: receipt.accepted
        ? { ok: true, value: receipt }
        : { ok: false, error: { code: 'not-found', message: receipt.reason } },
    }
  }
  throw new Error(`unhandled allowlisted method ${method}`)
}
