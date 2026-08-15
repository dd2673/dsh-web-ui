/**
 * Browser-side wire helpers for the /api/pair surface. Plain fetch over
 * same-origin /api (like the connection client); JSON bodies, string
 * responses for the error codes.
 */

/** issue() response. */
export interface IssueResult {
  ok: true
  url: string
  token: string
  expiresAt: number
  /** Every constructible LAN base address (interface order). */
  lanAddresses: string[]
  /** The configured public (tunneled) base URL, when present. */
  publicBaseUrl?: string
}

/** issue() refusal: the server is not LAN-reachable. */
export interface IssueLanRequired {
  ok: false
  code: 'lan-required'
}

/** issue() refusal: the requested LAN address is not constructible. */
export interface IssueUnknownAddress {
  ok: false
  code: 'unknown-address'
}

/** issue() refusal: the loopback-only fence rejected this origin. */
export interface IssueLoopbackRequired {
  ok: false
  code: 'forbidden'
}

export type IssueResponse = IssueResult | IssueLanRequired | IssueUnknownAddress | IssueLoopbackRequired

/** accept() refusal codes. */
export type AcceptFailure = { ok: false; code: 'invalid' | 'used' | 'forbidden' }

/** One auto-tunnel status frame (absent while the feature is off). */
export interface TunnelStatusFrame {
  state: 'starting' | 'running' | 'failed'
  url?: string
  error?: string
}

/** One /api/pair/events frame. */
export interface PairStateFrame {
  type: 'state'
  phase: 'lan-required' | 'stopped' | 'waiting' | 'connected' | 'disconnected'
  lanAvailable: boolean
  tokenId?: string
  tokenExpiresAt?: number
  deviceCount: number
  onlineCount: number
  /** Auto-tunnel status, while the auto-tunnel feature is active. */
  tunnel?: TunnelStatusFrame
}

export interface RelayTokenStatus {
  configured: boolean
  fingerprint?: string
  updatedAt: number
  expiresAt?: number
  expired?: boolean
  /** Present only in the response that rotated the token. */
  token?: string
  /** One-time Android deep link rendered as a QR; absent from status reads. */
  pairingUri?: string
  /** Secret-free relay base shown beside the QR. */
  relayUrl?: string
  /** Internal desktop identity encoded into the QR. */
  hostId?: string
}

async function relayTokenCall(path = '', method = 'GET'): Promise<RelayTokenStatus> {
  const response = await fetch(`/api/remote-web-ui/relay-token${path}`, { method, cache: 'no-store' })
  if (!response.ok) throw new Error(`relay token request failed with ${String(response.status)}`)
  const body = await response.json() as { ok?: boolean; value?: RelayTokenStatus }
  if (body.ok !== true || body.value === undefined) throw new Error('invalid relay token response')
  return body.value
}

/** Read secret-free token status from the loopback-only plugin route. */
export function relayTokenStatus(): Promise<RelayTokenStatus> {
  return relayTokenCall()
}

/** Rotate the unique Android bearer; the clear token is returned exactly once. */
export function rotateRelayToken(): Promise<RelayTokenStatus> {
  return relayTokenCall('/rotate', 'POST')
}

/** Revoke the Android bearer locally and on the relay. */
export function revokeRelayToken(): Promise<RelayTokenStatus> {
  return relayTokenCall('/revoke', 'POST')
}

/**
 * Mint a fresh pairing token (one active token at a time — this invalidates
 * any previous link).
 * @param workspaceId - optional current workspace to deep-link the phone into.
 * @param address - optional LAN IP literal the QR must be built from (the
 * default is the first interface); unknown literals refuse with
 * 'unknown-address'.
 * @returns the issued link, the lan-required refusal (server never bound
 * 0.0.0.0), or the forbidden refusal (the loopback-only fence rejected this
 * origin — the panel is a desktop control endpoint).
 */
export async function issuePair(workspaceId?: string, address?: string): Promise<IssueResponse> {
  const response = await fetch('/api/pair/issue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(address !== undefined ? { address } : {}),
    }),
  })
  if (!response.ok) {
    if (response.status === 409) return { ok: false, code: 'lan-required' }
    if (response.status === 403) return { ok: false, code: 'forbidden' }
    if (response.status === 400) return { ok: false, code: 'unknown-address' }
    throw new Error(`remote-web-ui: issue failed with ${String(response.status)}`)
  }
  return await response.json() as IssueResult
}

/**
 * Accept a pairing token (the phone's first open of the QR link). Success
 * sets the device cookie; the page then reloads to boot with it.
 * @param token - the token from the URL.
 * @returns the wire result.
 */
export async function acceptPair(token: string): Promise<{ ok: true } | AcceptFailure> {
  const response = await fetch('/api/pair/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (response.ok) return { ok: true }
  if (response.status === 404) return { ok: false, code: 'invalid' }
  if (response.status === 409) return { ok: false, code: 'used' }
  return { ok: false, code: 'forbidden' }
}

/** Revoke mobile access (paired devices + the current token). */
export async function stopPair(): Promise<void> {
  const response = await fetch('/api/pair/stop', { method: 'POST' })
  if (!response.ok) throw new Error(`remote-web-ui: stop failed with ${String(response.status)}`)
}

/** Presence heartbeat from a paired phone (unpaired heartbeats 401 harmlessly). */
export async function sendHeartbeat(): Promise<void> {
  await fetch('/api/pair/heartbeat', { method: 'POST' })
}

/** Whether the current page URL carries a pairing token / workspace target. */
export function readPairParams(search: string): { pair?: string; workspace?: string } {
  const params = new URLSearchParams(search)
  const pair = params.get('pair')
  const workspace = params.get('workspace')
  return {
    ...(pair !== null && pair !== '' ? { pair } : {}),
    ...(workspace !== null && workspace !== '' ? { workspace } : {}),
  }
}

/**
 * Strip one query parameter from the current URL without reloading.
 * @param name - the parameter to remove.
 * @returns the new search string ('' when empty).
 */
export function stripParam(name: string): string {
  const url = new URL(window.location.href)
  url.searchParams.delete(name)
  return url.search
}/** Human-readable expiry clock, e.g. "10:35". */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * Copy text to the clipboard with a fallback for insecure contexts
 * (plain-HTTP LAN origins lack navigator.clipboard).
 * @param text - the text to copy.
 * @returns whether the copy succeeded.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the execCommand path
    }
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
