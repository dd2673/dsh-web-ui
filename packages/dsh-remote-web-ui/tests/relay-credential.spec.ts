import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { androidPairingUri, RelayCredentialStore } from '../src/relay-credential.ts'

describe('relay credential authority', () => {
  it('returns the bearer once and persists only its hash', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-relay-credential-'))
    try {
      const path = join(directory, 'credential.json')
      const store = new RelayCredentialStore(path)
      const rotated = store.rotate()
      expect(rotated.token.length).toBeGreaterThanOrEqual(40)
      const persisted = readFileSync(path, 'utf8')
      expect(persisted).not.toContain(rotated.token)
      expect(store.status()).toMatchObject({ configured: true, fingerprint: rotated.fingerprint })
      expect(new RelayCredentialStore(path).tokenHash()).toMatch(/^[a-f0-9]{64}$/)
      store.revoke()
      expect(store.status().configured).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('Android relay pairing link', () => {
  it('contains only the relay base, internal host id, and single-use bearer', () => {
    const token = 'a'.repeat(43)
    const value = androidPairingUri('wss://www.example.com/dsh-relay/relay', 'desktop-01', token)
    const uri = new URL(value)
    expect(uri.protocol).toBe('https:')
    expect(uri.host).toBe('www.example.com')
    expect(uri.pathname).toBe('/dsh-remote/pair')
    expect(uri.searchParams.get('relay')).toBe('https://www.example.com/dsh-relay')
    expect(uri.searchParams.get('host')).toBe('desktop-01')
    expect(uri.searchParams.get('token')).toBe(token)
    expect(uri.searchParams.has('device')).toBe(false)
  })

  it('keeps the private custom scheme only for loopback E2E', () => {
    const token = 'b'.repeat(43)
    const value = androidPairingUri('ws://127.0.0.1:3090/relay', 'desktop-01', token)
    const uri = new URL(value)
    expect(uri.protocol).toBe('dshremote:')
    expect(uri.host).toBe('pair')
    expect(uri.searchParams.get('relay')).toBe('http://127.0.0.1:3090')
    expect(uri.searchParams.get('host')).toBe('desktop-01')
    expect(uri.searchParams.get('token')).toBe(token)
  })
})
