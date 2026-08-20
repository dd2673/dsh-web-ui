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
/** Context metadata stays useful on a phone without becoming another body carrier. */
const MOBILE_CONTEXT_MAX_BYTES = 24 * 1024
const MOBILE_CONTEXT_MAX_ENTRIES = 50
const MOBILE_CONTEXT_STRING_MAX_BYTES = 512
const MOBILE_TOOL_DETAIL_MAX_BYTES = 12 * 1024

const MOBILE_CONTEXT_FORMS = new Set([
  'instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall',
])

const MOBILE_PROJECTION_KEYS = new Set([
  'title', 'permissions', 'contextPressure', 'contextBreakdown', 'tokenUsage', 'sessionStats',
])

type MobileContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'
type MobileInstructionAction = 'loaded' | 'added' | 'updated' | 'removed'

/** Privacy-minimised context facts shared by history and the live mobile mux. */
export interface MobileContextMetadata {
  role: 'inject' | 'recall'
  producerLabel: string | null
  form: MobileContextForm | null
  bodyAvailability: 'desktop-only'
  changes?: Array<{ action: MobileInstructionAction; path: string }>
  names?: string[]
  replaced?: boolean
  sectionNames?: string[]
  senderSessionId?: string
  references?: Array<{
    label: string
    retainedMessages: number
    omittedMessages: number
    truncated: boolean
  }>
  truncated?: true
  omittedEntries?: number
}

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

/** One JSON value narrowed to the record shape accepted at this boundary. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Truncate a UTF-8 string without leaving an incomplete code point. */
function boundedUtf8String(value: unknown, maxBytes: number): { value: string | undefined; truncated: boolean } {
  if (typeof value !== 'string' || value === '') return { value: undefined, truncated: false }
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false }
  const source = Buffer.from(value, 'utf8').subarray(0, maxBytes)
  const bounded = new TextDecoder('utf-8', { fatal: false }).decode(source).replace(/\uFFFD+$/u, '')
  return { value: bounded === '' ? undefined : bounded, truncated: true }
}

/** A finite non-negative number, or undefined for an unreadable wire value. */
function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** A finite non-negative integer, or undefined for an unreadable wire value. */
function nonNegativeInteger(value: unknown): number | undefined {
  const number = nonNegativeNumber(value)
  return number !== undefined && Number.isInteger(number) ? number : undefined
}

/** Derive the one-line label while keeping full developer details in a separate field. */
function mobileToolSummary(name: unknown, argumentsValue: unknown, projected: unknown): string | undefined {
  const bounded = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.trim() === '') return undefined
    const line = value.split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim()
    return boundedUtf8String(line, 180).value
  }
  const projectedSummary = bounded(projected)
  if (projectedSummary !== undefined) return projectedSummary
  const args = typeof argumentsValue === 'string'
    ? (() => { try { return asRecord(JSON.parse(argumentsValue)) } catch (_) { return undefined } })()
    : asRecord(argumentsValue)
  const toolName = typeof name === 'string' ? name : ''
  const keys = toolName === 'grep' || toolName === 'glob' || toolName === 'web_search'
    ? ['description', 'query', 'pattern', 'summary']
    : ['description', 'summary']
  return keys.map(key => bounded(args?.[key])).find(value => value !== undefined)
}

/** Preserve developer-facing tool details, bounded only to protect the mobile frame budget. */
function mobileToolDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof serialized !== 'string' || serialized === '') return undefined
  return truncateHistoryText(serialized).text.slice(0, MOBILE_TOOL_DETAIL_MAX_BYTES)
}

function mobileToolOutput(data: Record<string, unknown>): string | undefined {
  const message = asRecord(data.message)
  return mobileToolDetail(message?.content ?? data.content ?? data.output)
}

/**
 * User and completed assistant messages are the durable conversation surface.
 * Tool-heavy turns can otherwise fill the host page before the relay sees an
 * older prompt, so history compaction gives these rows first claim on the
 * bounded mobile frame.
 */
function isConversationHistoryEvent(event: Record<string, unknown>): boolean {
  const type = event.type
  const data = asRecord(event.data) ?? {}
  if (type === 'assistant/message') {
    const message = asRecord(data.message) ?? data
    const content = message.content
    return Array.isArray(content) && content.some(block => asRecord(block)?.type === 'text'
      && typeof asRecord(block)?.text === 'string' && asRecord(block)?.text !== '')
  }
  if (type !== 'user/message') return false
  const source = asRecord(data.source)
  if (source?.kind !== undefined && source.kind !== 'user') return false
  const content = data.content ?? asRecord(data.message)?.content
  return Array.isArray(content) && content.some(block => asRecord(block)?.type === 'text'
    && typeof asRecord(block)?.text === 'string' && asRecord(block)?.text !== '')
}

/** Bound one context string and remember that the display is incomplete. */
function contextString(value: unknown, state: { truncated: boolean }): string | undefined {
  const bounded = boundedUtf8String(value, MOBILE_CONTEXT_STRING_MAX_BYTES)
  state.truncated ||= bounded.truncated
  return bounded.value
}

/** The producer role and label projected from a durable source without forwarding it. */
function mobileContextProvenance(
  source: Record<string, unknown>,
  state: { truncated: boolean },
): Pick<MobileContextMetadata, 'role' | 'producerLabel'> {
  const kind = contextString(source.kind, state)
  const collect = (member: string, field: string): string[] => {
    const list = source[member]
    if (!Array.isArray(list)) return []
    const values: string[] = []
    for (const entry of list) {
      const value = contextString(asRecord(entry)?.[field], state)
      if (value !== undefined && !values.includes(value)) values.push(value)
    }
    return values
  }
  const joined = (values: string[]): string | null => {
    if (values.length === 0) return null
    return contextString(values.join(', '), state) ?? null
  }
  if (kind === undefined) return { role: 'inject', producerLabel: null }
  if (kind === 'session-reference') {
    return { role: 'recall', producerLabel: joined(collect('references', 'label')) ?? kind }
  }
  if (kind === 'agent-instructions') {
    return { role: 'inject', producerLabel: joined(collect('changes', 'path')) ?? kind }
  }
  if (kind === 'plugin') {
    return { role: 'inject', producerLabel: contextString(source.plugin, state) ?? kind }
  }
  if (kind === 'skill-invocation') {
    return { role: 'inject', producerLabel: contextString(source.name, state) ?? kind }
  }
  return { role: 'inject', producerLabel: kind }
}

/** Add list truncation facts without exposing why individual source rows were unreadable. */
function markOmitted(metadata: MobileContextMetadata, omittedEntries: number): void {
  if (omittedEntries <= 0) return
  metadata.truncated = true
  metadata.omittedEntries = (metadata.omittedEntries ?? 0) + omittedEntries
}

/** Trim the one form-specific list until the complete metadata record fits its byte budget. */
function fitContextMetadata(metadata: MobileContextMetadata): MobileContextMetadata {
  const list = metadata.changes ?? metadata.names ?? metadata.sectionNames ?? metadata.references
  if (list === undefined) return metadata
  let omitted = 0
  while (list.length > 0 && Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MOBILE_CONTEXT_MAX_BYTES) {
    list.pop()
    omitted += 1
  }
  markOmitted(metadata, omitted)
  return metadata
}

/**
 * Project a durable context source to the only metadata the paired Android UI may receive.
 * Any malformed dedicated form degrades to opaque rather than forwarding its raw source.
 */
function mobileContextMetadata(value: unknown): MobileContextMetadata {
  const source = asRecord(value) ?? {}
  const state = { truncated: false }
  const provenance = mobileContextProvenance(source, state)
  const declared = typeof source.form === 'string' && MOBILE_CONTEXT_FORMS.has(source.form)
    ? source.form as MobileContextForm
    : null
  const metadata: MobileContextMetadata = {
    ...provenance,
    form: declared,
    bodyAvailability: 'desktop-only',
  }
  let omitted = 0
  const limited = <T>(items: T[]): T[] => {
    if (items.length <= MOBILE_CONTEXT_MAX_ENTRIES) return items
    omitted += items.length - MOBILE_CONTEXT_MAX_ENTRIES
    return items.slice(0, MOBILE_CONTEXT_MAX_ENTRIES)
  }

  if (declared === 'instructions') {
    const entries = Array.isArray(source.changes) ? source.changes : undefined
    const baseline = source.baseline === true
    const seen = new Set<string>()
    const changes: NonNullable<MobileContextMetadata['changes']> = []
    let readable = entries !== undefined && entries.length > 0
    for (const entry of entries ?? []) {
      const record = asRecord(entry)
      const path = contextString(record?.path, state)
      const action = record?.action
      if (path === undefined || (action !== 'set' && action !== 'replace' && action !== 'remove')) {
        readable = false
        break
      }
      if (seen.has(path)) continue
      seen.add(path)
      changes.push({
        path,
        action: action === 'remove' ? 'removed' : baseline ? 'loaded' : action === 'set' ? 'added' : 'updated',
      })
    }
    if (readable) metadata.changes = limited(changes)
    else metadata.form = null
  } else if (declared === 'catalog') {
    const entries = Array.isArray(source.entries) ? source.entries : undefined
    const names: string[] = []
    let readable = entries !== undefined
    for (const entry of entries ?? []) {
      const name = contextString(asRecord(entry)?.name, state)
      if (name === undefined) {
        readable = false
        break
      }
      names.push(name)
    }
    if (readable) {
      metadata.names = limited(names)
      metadata.replaced = source.update === true
    } else metadata.form = null
  } else if (declared === 'snapshot') {
    const sections = Array.isArray(source.sections) ? source.sections : undefined
    const names: string[] = []
    let readable = sections !== undefined && sections.length > 0
    for (const section of sections ?? []) {
      const name = contextString(asRecord(section)?.name, state)
      if (name === undefined) {
        readable = false
        break
      }
      names.push(name)
    }
    if (readable) metadata.sectionNames = limited(names)
    else metadata.form = null
  } else if (declared === 'notice') {
    if (typeof source.summary !== 'string' || source.summary === '') metadata.form = null
  } else if (declared === 'relay') {
    const sender = contextString(source.senderSessionId, state)
    if (sender === undefined) metadata.form = null
    else metadata.senderSessionId = sender
  } else if (declared === 'recall') {
    const entries = Array.isArray(source.references) ? source.references : undefined
    const references: NonNullable<MobileContextMetadata['references']> = []
    let readable = entries !== undefined && entries.length > 0
    for (const entry of entries ?? []) {
      const record = asRecord(entry)
      const label = contextString(record?.label, state)
      const retainedMessages = nonNegativeInteger(record?.retainedMessages)
      const omittedMessages = nonNegativeInteger(record?.omittedMessages)
      if (label === undefined || retainedMessages === undefined || omittedMessages === undefined
        || typeof record?.truncated !== 'boolean') {
        readable = false
        break
      }
      references.push({ label, retainedMessages, omittedMessages, truncated: record.truncated })
    }
    if (readable) metadata.references = limited(references)
    else metadata.form = null
  }

  if (state.truncated) metadata.truncated = true
  markOmitted(metadata, omitted)
  return fitContextMetadata(metadata)
}

/** Stable, non-body summary retained for Android versions predating metadata disclosures. */
function mobileContextSummary(metadata: MobileContextMetadata, fallback?: string): string {
  switch (metadata.form) {
    case 'instructions': return '已应用工作区说明'
    case 'catalog': return metadata.replaced === true ? '已替换上下文目录' : '已应用上下文目录'
    case 'snapshot': return '已应用运行上下文'
    case 'notice': return '已应用上下文通知'
    case 'relay': return '已接收代理上下文'
    case 'recall': return '已召回会话上下文'
    default: return fallback ?? '已应用会话上下文'
  }
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

/** Copy only known non-negative numeric fields from a projection value. */
function numericProjection(value: unknown, fields: readonly string[]): Record<string, number> | undefined {
  const source = asRecord(value)
  if (source === undefined) return undefined
  const projected: Record<string, number> = {}
  for (const field of fields) {
    const number = nonNegativeNumber(source[field])
    if (number !== undefined) projected[field] = number
  }
  return Object.keys(projected).length > 0 ? projected : undefined
}

/** Validate one allowlisted projection and discard all unrecognized members. */
function mobileProjectionValue(key: unknown, value: unknown): { value: unknown } | undefined {
  if (typeof key !== 'string' || !MOBILE_PROJECTION_KEYS.has(key)) return undefined
  if (value === null) return { value: null }
  if (key === 'title') {
    const title = boundedUtf8String(value, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    return title === undefined ? undefined : { value: title }
  }
  if (key === 'permissions') {
    const source = asRecord(value)
    if (source === undefined) return undefined
    const currentValue = boundedUtf8String(source.currentValue, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    const options = Array.isArray(source.options) ? source.options.slice(0, MOBILE_CONTEXT_MAX_ENTRIES).flatMap(entry => {
      const record = asRecord(entry)
      const optionValue = boundedUtf8String(record?.value, MOBILE_CONTEXT_STRING_MAX_BYTES).value
      if (optionValue === undefined) return []
      const name = boundedUtf8String(record?.name, MOBILE_CONTEXT_STRING_MAX_BYTES).value
      return [{ value: optionValue, ...(name === undefined ? {} : { name }) }]
    }) : []
    if (currentValue === undefined && options.length === 0) return undefined
    return { value: { ...(currentValue === undefined ? {} : { currentValue }), ...(options.length === 0 ? {} : { options }) } }
  }
  if (key === 'contextPressure') {
    return { value: numericProjection(value, ['projectedTokens', 'pressureTokens', 'contextWindow']) ?? {} }
  }
  if (key === 'contextBreakdown') {
    const projected = numericProjection(value, ['systemTokens', 'toolsTokens', 'messageTokens'])
    return projected === undefined ? undefined : { value: projected }
  }
  if (key === 'tokenUsage') {
    const projected = numericProjection(value, [
      'uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    ])
    return projected === undefined ? undefined : { value: projected }
  }
  const projected = numericProjection(value, [
    'turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens',
  ])
  return projected === undefined ? undefined : { value: projected }
}

/** Projection snapshot sanitizer shared by session.list and session.history. */
export function compactMobileProjections(value: unknown): unknown {
  const source = asRecord(value)
  const values = asRecord(source?.values)
  const compacted: Record<string, unknown> = {}
  for (const [key, candidate] of Object.entries(values ?? {})) {
    const projected = mobileProjectionValue(key, candidate)
    if (projected !== undefined) compacted[key] = projected.value
  }
  const asOfSeq = nonNegativeInteger(source?.asOfSeq)
  return {
    ...(asOfSeq === undefined ? {} : { asOfSeq }),
    values: compacted,
  }
}

/** Sanitize the live mux without altering approval/question carriers. */
export function compactMobileMuxFrame(value: unknown): unknown | undefined {
  const envelope = asRecord(value)
  const payload = asRecord(envelope?.payload)
  if (envelope === undefined || payload === undefined) return undefined
  if (payload.type === 'session/event') {
    const event = compactMobileSessionEvent(payload.event)
    if (event === undefined) return undefined
    return { ...envelope, payload: { ...payload, event } }
  }
  if (payload.type === 'session/projection') {
    const projected = mobileProjectionValue(payload.key, payload.value)
    if (projected === undefined) return undefined
    return { ...envelope, payload: { ...payload, value: projected.value } }
  }
  return value
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

/** A non-user user/message projected to the safe context event understood by Android. */
function mobileContextEvent(data: Record<string, unknown>): { data: Record<string, unknown>; dropCheckpoint: boolean } | undefined {
  const source = asRecord(data.source)
  const kind = source?.kind
  if (kind === 'plugin' && source?.plugin === 'compact') return { data: {}, dropCheckpoint: true }
  const fallback = internalContextSummary(data.content)
  const nonUser = source !== undefined && kind !== 'user'
  if (!nonUser && fallback === undefined) return undefined
  const metadata = mobileContextMetadata(nonUser ? data.source : undefined)
  return {
    dropCheckpoint: false,
    data: {
      summary: mobileContextSummary(metadata, fallback),
      source: 'harness-context',
      metadata,
    },
  }
}

/**
 * Sanitize one durable event for the paired mobile transcript.
 * Unknown events are omitted; a dedicated mobile event never impersonates the complete Host schema.
 */
export function compactMobileSessionEvent(
  value: unknown,
  finalized: ReadonlySet<string> = new Set(),
): Record<string, unknown> | undefined {
  const event = asRecord(value)
  if (event === undefined) return undefined
  const type = typeof event.type === 'string' ? event.type : ''
  const seq = typeof event.seq === 'number' ? event.seq : undefined
  const time = typeof event.time === 'number' ? event.time : undefined
  const data = asRecord(event.data) ?? {}
  const envelope = (nextData: unknown, nextType = type): Record<string, unknown> => ({
    type: nextType,
    ...(seq !== undefined ? { seq } : {}),
    ...(time !== undefined ? { time } : {}),
    data: nextData,
  })

  if (type === 'user/message') {
    const context = mobileContextEvent(data)
    if (context?.dropCheckpoint === true) return undefined
    if (context !== undefined) return envelope(context.data, 'context/injection')
    const bounded = compactContent(data.content ?? asRecord(data.message)?.content)
    const id = boundedUtf8String(data.id, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    return envelope({ content: bounded.content, ...(id === undefined ? {} : { id }) })
  }
  if (type === 'assistant/message') {
    const message = asRecord(data.message) ?? {}
    const bounded = compactContent(message.content)
    const reasoning = Array.isArray(message.content)
      ? truncateHistoryText(message.content.filter(block => asRecord(block)?.type === 'reasoning').map(block => asRecord(block)?.text || '').join('')).text
      : ''
    const id = boundedUtf8String(message.id, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    return envelope({
      turn: data.turn,
      step: data.step,
      message: { role: 'assistant', content: bounded.content, ...(id === undefined ? {} : { id }) },
      ...(reasoning === '' ? {} : { reasoning }),
    })
  }
  if (type === 'assistant/chunk') {
    if (finalized.has(historyStepKey({ data }))) return undefined
    const chunk = asRecord(data.chunk) ?? {}
    if (chunk.type === 'reasoning-delta') {
      const bounded = truncateHistoryText(chunk.text)
      return envelope({ turn: data.turn, step: data.step, text: bounded.text }, 'assistant/reasoning')
    }
    if (chunk.type !== 'text-delta') return undefined
    const bounded = truncateHistoryText(chunk.text)
    return envelope({
      turn: data.turn,
      step: data.step,
      chunk: { type: 'text-delta', index: chunk.index, text: bounded.text },
    })
  }
  if (type === 'tool/call') {
    const callId = boundedUtf8String(data.callId, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    const name = boundedUtf8String(data.name, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    const summary = mobileToolSummary(data.name, data.arguments, data.summary)
    return envelope({
      turn: data.turn,
      step: data.step,
      ...(callId === undefined ? {} : { callId }),
      ...(name === undefined ? {} : { name }),
      ...(summary === undefined ? {} : { summary }),
      ...(mobileToolDetail(data.arguments) === undefined ? {} : { arguments: mobileToolDetail(data.arguments) }),
    })
  }
  if (type === 'tool/result') {
    const message = asRecord(data.message) ?? {}
    const sourceData = asRecord(message.source) ?? {}
    const blocks = Array.isArray(message.content) ? message.content : []
    const isError = data.error !== undefined || blocks.some(block => asRecord(block)?.isError === true)
    const callId = boundedUtf8String(sourceData.callId ?? data.callId, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    return envelope({
      turn: data.turn,
      step: data.step,
      ...(callId === undefined ? {} : { callId }),
      isError,
      ...(mobileToolOutput(data) === undefined ? {} : { output: mobileToolOutput(data) }),
    })
  }
  if (type === 'tool/code-dispatch-start' || type === 'tool/code-dispatch') {
    const rootCallId = boundedUtf8String(data.rootCallId, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    const parentCallId = boundedUtf8String(data.parentCallId, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    const subCallId = boundedUtf8String(data.subCallId, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    const name = boundedUtf8String(data.name, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    const summary = mobileToolSummary(data.name, data.arguments, data.summary)
    if (rootCallId === undefined || parentCallId === undefined || subCallId === undefined || name === undefined) return undefined
    return envelope({
      rootCallId, parentCallId, subCallId, name,
      ...(summary === undefined ? {} : { summary }),
      ...(mobileToolDetail(data.arguments) === undefined ? {} : { arguments: mobileToolDetail(data.arguments) }),
      ...(type === 'tool/code-dispatch'
        ? { isError: data.isError === true, ...(mobileToolOutput(data) === undefined ? {} : { output: mobileToolOutput(data) }) }
        : {}),
    })
  }
  if (type === 'compaction/start' || type === 'compaction/summary' || type === 'compaction/end') {
    const compactionId = boundedUtf8String(data.compactionId, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    if (compactionId === undefined) return undefined
    const shadowedItems = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : undefined
    const shadowedTokens = nonNegativeNumber(data.shadowedTokenCount)
    return envelope({
      compactionId,
      state: type === 'compaction/end' ? (data.error === undefined ? 'complete' : 'error') : 'running',
      ...(shadowedItems === undefined ? {} : { shadowedItems }),
      ...(shadowedTokens === undefined ? {} : { shadowedTokens }),
    }, 'mobile/compaction')
  }
  if (type === 'llm/retry' || type === 'llm/retry-started') {
    const retryId = boundedUtf8String(data.retryId, MOBILE_CONTEXT_STRING_MAX_BYTES).value
    const retry = nonNegativeInteger(data.retry)
    const turn = nonNegativeInteger(data.turn)
    const step = nonNegativeInteger(data.step)
    if (retryId === undefined || retry === undefined || turn === undefined || step === undefined) return undefined
    const maximum = nonNegativeInteger(data.maxRetries)
    const delayMs = nonNegativeNumber(data.delayMs)
    return envelope({
      retryId,
      turn,
      step,
      retry,
      maximum: maximum ?? null,
      delayMs: delayMs ?? 0,
      state: type === 'llm/retry-started' ? 'started' : 'scheduled',
    }, 'mobile/model-retry')
  }
  const reason = asRecord(data.reason)
  if (type === 'turn/end' && typeof reason?.kind === 'string') {
    const safeKind = ['completed', 'error', 'interrupted', 'cancelled', 'max-tokens'].includes(reason.kind)
      ? reason.kind
      : 'completed'
    return envelope({ turn: data.turn, reason: { kind: safeKind } })
  }
  return undefined
}

/**
 * Project Host history onto the small, developer-facing transcript needed by Android.
 * Stream deltas are retained only for an unfinished step; completed steps use their
 * final assistant message. Tool details are carried in bounded fields for the
 * developer-owned companion UI and remain behind folded controls.
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
  const compactedSourceIndices: number[] = []
  const compacted = events.flatMap((event, sourceIndex): unknown[] => {
    const compactedEvent = compactMobileSessionEvent(event, finalized)
    if (compactedEvent === undefined) return []
    const eventData = asRecord(compactedEvent.data)
    const contextMetadata = asRecord(eventData?.metadata)
    if (contextMetadata?.truncated === true) mobileTruncated = true
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      const sourceContent = event.type === 'user/message'
        ? (asRecord(event.data)?.content ?? asRecord(asRecord(event.data)?.message)?.content)
        : asRecord(asRecord(event.data)?.message)?.content
      if (compactContent(sourceContent).truncated) mobileTruncated = true
    } else if (event.type === 'assistant/chunk' && truncateHistoryText(asRecord(asRecord(event.data)?.chunk)?.text).truncated) {
      mobileTruncated = true
    }
    compactedSourceIndices.push(sourceIndex)
    return [{ event: compactedEvent }]
  })

  const projections = compactMobileProjections(source.projections)

  // User and assistant rows are the conversation itself. Reserve them first;
  // only then spend the remaining frame budget on intermediate tool/process
  // events, otherwise a long tool-heavy turn hides every earlier prompt.
  const priority = new Set<number>()
  compactedSourceIndices.forEach((sourceIndex, compactedIndex) => {
    if (isConversationHistoryEvent(events[sourceIndex])) priority.add(compactedIndex)
  })
  const acceptedIndices = new Set<number>()
  const serialized = (indices: Set<number>) => {
    const ordered = [...indices].sort((left, right) => left - right).map(index => compacted[index])
    return {
      events: ordered,
      hasMore: source.hasMore === true || acceptedIndices.size < compacted.length,
      ...(source.projections !== undefined ? { projections } : {}),
      ...(mobileTruncated ? { mobileTruncated: true } : {}),
    }
  }
  const fits = (indices: Set<number>): boolean => Buffer.byteLength(JSON.stringify(serialized(indices)), 'utf8') <= MOBILE_HISTORY_MAX_BYTES

  for (const index of priority) {
    const candidate = new Set(acceptedIndices)
    candidate.add(index)
    if (fits(candidate)) acceptedIndices.add(index)
    else mobileTruncated = true
  }
  // Prefer the newest process rows, while keeping their original order in the
  // final array. The direct conversation rows above remain present even when
  // the tool trace has to be shortened.
  for (let index = compacted.length - 1; index >= 0; index -= 1) {
    if (acceptedIndices.has(index)) continue
    const candidate = new Set(acceptedIndices)
    candidate.add(index)
    if (fits(candidate)) acceptedIndices.add(index)
    else mobileTruncated = true
  }
  const accepted = [...acceptedIndices].sort((left, right) => left - right).map(index => compacted[index])
  return {
    events: accepted,
    hasMore: source.hasMore === true || accepted.length < compacted.length,
    ...(source.projections !== undefined ? { projections } : {}),
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
        const compacted = compactMobileMuxFrame(frame)
        if (compacted !== undefined) res.write(`data: ${JSON.stringify(compacted)}\n\n`)
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
          items: page.map(item => {
            const record = item as Record<string, unknown>
            return {
              ...record,
              ...(record.projections === undefined ? {} : { projections: compactMobileProjections(record.projections) }),
            }
          }),
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
