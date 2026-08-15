import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { parseRelayUrl } from './relay-url.ts'

export const RELAY_SETTINGS_PATH = '/api/remote-web-ui/relay-config'

export interface RelaySettingsValue {
  relayUrl: string
  writable: boolean
}

export interface RelaySettingsRoutesOptions {
  /** This is a desktop control surface and must remain loopback-only. */
  fence(request: IncomingMessage): boolean
  read(): RelaySettingsValue
  /** Undefined clears the user override and re-inherits the composition value. */
  write(relayUrl: string | undefined): Promise<RelaySettingsValue>
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

async function readRelayUrl(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 4096) return undefined
    chunks.push(buffer)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { relayUrl?: unknown }
    return typeof body.relayUrl === 'string' ? body.relayUrl : undefined
  } catch {
    return undefined
  }
}

/** Host-backed fallback for shells that do not expose third-party SettingsScope. */
export function makeRelaySettingsRoutes(options: RelaySettingsRoutesOptions): WebRoute[] {
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!options.fence(request)) {
      writeJson(response, 403, { ok: false, error: 'loopback-only' })
      return
    }
    if (request.method === 'GET') {
      writeJson(response, 200, { ok: true, value: options.read() })
      return
    }
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const draft = await readRelayUrl(request)
    const parsed = draft === undefined ? undefined : parseRelayUrl(draft)
    if (parsed === undefined) {
      writeJson(response, 400, { ok: false, error: 'invalid-relay-url' })
      return
    }
    try {
      const value = await options.write(parsed.kind === 'clear' ? undefined : parsed.value)
      writeJson(response, 200, { ok: true, value })
    } catch {
      writeJson(response, 503, { ok: false, error: 'settings-unavailable' })
    }
  }
  return [{ kind: 'exact', path: RELAY_SETTINGS_PATH, handler }]
}
