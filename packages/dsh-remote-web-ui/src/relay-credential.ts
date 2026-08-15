import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isTrustedApiRequest } from './routes.ts'

interface StoredCredential {
  version: 1
  tokenSha256?: string
  pairingExpiresAt?: number
  updatedAt: number
}

const PAIRING_TTL_MS = 5 * 60_000

/** Local authority for the phone bearer: only a hash is durable. */
export class RelayCredentialStore {
  readonly path: string
  #value: StoredCredential

  constructor(path = defaultCredentialPath()) {
    this.path = resolve(path)
    this.#value = this.#read()
  }

  tokenHash(): string | undefined {
    return this.#value.tokenSha256
  }

  pairingExpiresAt(): number | undefined {
    return this.#value.pairingExpiresAt
  }

  status(): { configured: boolean; fingerprint?: string; expiresAt?: number; expired: boolean; updatedAt: number } {
    const hash = this.#value.tokenSha256
    const expiresAt = this.#value.pairingExpiresAt
    return {
      configured: hash !== undefined,
      ...(hash === undefined ? {} : { fingerprint: hash.slice(0, 12) }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      expired: expiresAt !== undefined && expiresAt <= Date.now(),
      updatedAt: this.#value.updatedAt,
    }
  }

  /** Mint a 256-bit bearer and persist only its SHA-256 hash. */
  rotate(): { token: string; fingerprint: string; expiresAt: number; updatedAt: number } {
    const token = randomBytes(32).toString('base64url')
    const tokenSha256 = createHash('sha256').update(token).digest('hex')
    const updatedAt = Date.now()
    const pairingExpiresAt = updatedAt + PAIRING_TTL_MS
    this.#value = { version: 1, tokenSha256, pairingExpiresAt, updatedAt }
    this.#write()
    return { token, fingerprint: tokenSha256.slice(0, 12), expiresAt: pairingExpiresAt, updatedAt }
  }

  revoke(): void {
    this.#value = { version: 1, updatedAt: Date.now() }
    this.#write()
  }

  #read(): StoredCredential {
    if (!existsSync(this.path)) return { version: 1, updatedAt: 0 }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredCredential>
      if (parsed.version !== 1) return { version: 1, updatedAt: 0 }
      const tokenSha256 = typeof parsed.tokenSha256 === 'string' && /^[a-f0-9]{64}$/.test(parsed.tokenSha256)
        ? parsed.tokenSha256
        : undefined
      // Legacy credentials had no expiry. Preserve only their hash identity
      // and mark the pairing window expired so an old QR cannot be redeemed.
      const pairingExpiresAt = Number.isFinite(parsed.pairingExpiresAt)
        ? Number(parsed.pairingExpiresAt)
        : tokenSha256 === undefined ? undefined : 1
      return {
        version: 1,
        ...(tokenSha256 === undefined ? {} : { tokenSha256 }),
        ...(pairingExpiresAt === undefined ? {} : { pairingExpiresAt }),
        updatedAt: Number(parsed.updatedAt) || 0,
      }
    } catch {
      return { version: 1, updatedAt: 0 }
    }
  }

  #write(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid.toString(10)}.tmp`
    writeFileSync(temporary, JSON.stringify(this.#value, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.path)
  }
}

export interface RelayCredentialRoutesOptions {
  store: RelayCredentialStore
  /** Resolve only after the relay has confirmed the new hash. */
  onChange: () => Promise<void>
  /** Current relay endpoint and internal host identity used to mint the Android deep link. */
  pairingInfo: () => { relayUrl?: string; hostId?: string }
}

/** Convert the host WSS endpoint into the HTTPS base consumed by Android. */
export function androidRelayBase(value: string): string {
  const url = new URL(value)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  else if (url.protocol === 'ws:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')) url.protocol = 'http:'
  else if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('relay URL must use WSS or HTTPS')
  const path = url.pathname.replace(/\/+$/, '').replace(/\/relay$/, '')
  url.pathname = path === '' ? '/' : `${path}/`
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

/** Build the one-time Android pairing deep link without persisting it. */
export function androidPairingUri(relayUrl: string, hostId: string, token: string): string {
  const relayBase = androidRelayBase(relayUrl)
  const relay = new URL(relayBase)
  // HTTPS relay deployments can use an OS-verified App Link without an
  // extra desktop setting. Loopback E2E keeps the private test scheme.
  const uri = relay.protocol === 'https:'
    ? new URL('/dsh-remote/pair', relay)
    : new URL('dshremote://pair')
  uri.searchParams.set('relay', relayBase)
  uri.searchParams.set('host', hostId)
  uri.searchParams.set('token', token)
  return uri.toString()
}

/** Loopback-only rotate/revoke surface. Tokens are returned once with no-store. */
export function makeRelayCredentialRoutes(options: RelayCredentialRoutesOptions): WebRoute[] {
  const write = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify(value))
  }
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isTrustedApiRequest(request, [])) {
      write(response, 403, { ok: false, error: 'loopback-only' })
      return
    }
    const pathname = new URL(request.url ?? '/', 'http://local').pathname
    if (request.method === 'GET' && pathname === '/api/remote-web-ui/relay-token') {
      write(response, 200, { ok: true, value: options.store.status() })
      return
    }
    if (request.method === 'POST' && pathname === '/api/remote-web-ui/relay-token/rotate') {
      const pairing = options.pairingInfo()
      if (pairing.relayUrl === undefined || pairing.hostId === undefined) {
        write(response, 409, { ok: false, error: 'relay-not-configured' })
        return
      }
      const result = options.store.rotate()
      try {
        await options.onChange()
      } catch {
        write(response, 503, { ok: false, error: 'relay-sync-pending' })
        return
      }
      write(response, 200, {
        ok: true,
        value: {
          ...result,
          pairingUri: androidPairingUri(pairing.relayUrl, pairing.hostId, result.token),
          relayUrl: androidRelayBase(pairing.relayUrl),
          hostId: pairing.hostId,
          synced: true,
        },
      })
      return
    }
    if (request.method === 'POST' && pathname === '/api/remote-web-ui/relay-token/revoke') {
      options.store.revoke()
      try {
        await options.onChange()
      } catch {
        write(response, 503, { ok: false, error: 'relay-sync-pending' })
        return
      }
      write(response, 200, { ok: true, value: options.store.status() })
      return
    }
    write(response, 404, { ok: false, error: 'not-found' })
  }
  return [{ kind: 'prefix', path: '/api/remote-web-ui/relay-token', handler }]
}

export function defaultCredentialPath(): string {
  const base = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(base, 'dsh-remote-relay-credential.json')
}
