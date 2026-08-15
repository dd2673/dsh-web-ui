/** One validated Relay URL draft. Blank means clear the user override. */
export type ParsedRelayUrl = { kind: 'clear' } | { kind: 'set'; value: string }

/**
 * Apply the Relay transport fence shared by the browser form and Host route.
 * Public endpoints require TLS; plain WS is limited to loopback development.
 */
export function parseRelayUrl(text: string): ParsedRelayUrl | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'clear' }
  try {
    const url = new URL(trimmed)
    const loopback = url.hostname === '127.0.0.1'
      || url.hostname === 'localhost'
      || url.hostname === '::1'
      || url.hostname === '[::1]'
    if (url.username !== '' || url.password !== '') return undefined
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) return undefined
    return { kind: 'set', value: trimmed }
  } catch {
    return undefined
  }
}
