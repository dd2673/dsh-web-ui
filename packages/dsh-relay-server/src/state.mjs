import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const FORMAT_VERSION = 1
const AUDIT_LIMIT = 500

function emptyState() {
  return { version: FORMAT_VERSION, hosts: {}, credentials: {}, devices: {}, audit: [] }
}

/**
 * Tiny atomic JSON state store. The relay owns one user/host and bounded
 * metadata only, so this avoids a native database dependency and stays
 * compatible with the relay's maintained Node 20 runtime.
 */
export class RelayStateStore {
  #path
  #state

  constructor(path = ':memory:') {
    this.#path = path
    this.#state = this.#read()
  }

  hostSeen(hostId, patch = {}) {
    const now = Date.now()
    const previous = this.status(hostId)
    const next = {
      hostId,
      dshState: patch.dshState ?? previous?.dshState ?? 'stopped',
      agentState: patch.agentState ?? previous?.agentState ?? 'offline',
      dshVersion: patch.dshVersion ?? previous?.dshVersion,
      port: patch.port ?? previous?.port,
      lastSeenAt: now,
      updatedAt: now,
    }
    this.#state.hosts[hostId] = next
    this.#write()
    return { ...next }
  }

  hostOffline(hostId) {
    const previous = this.#state.hosts[hostId]
    if (previous === undefined) return
    this.#state.hosts[hostId] = { ...previous, dshState: 'stopped', updatedAt: Date.now() }
    this.#write()
  }

  deviceSeen(hostId, deviceId) {
    this.#state.devices[`${hostId}\u0000${deviceId}`] = {
      hostId, deviceId, lastSeenAt: Date.now(), revokedAt: undefined,
    }
    this.#write()
  }

  revokeDevice(hostId, deviceId) {
    const key = `${hostId}\u0000${deviceId}`
    const previous = this.#state.devices[key]
    this.#state.devices[key] = {
      hostId, deviceId, lastSeenAt: previous?.lastSeenAt ?? Date.now(), revokedAt: Date.now(),
    }
    this.#write()
  }

  isRevoked(hostId, deviceId) {
    return this.#state.devices[`${hostId}\u0000${deviceId}`]?.revokedAt !== undefined
  }

  syncDeviceCredential(hostId, tokenSha256, pairingExpiresAt) {
    const previous = this.deviceCredential(hostId)
    const desired = tokenSha256 ?? undefined
    // After exchange the pairing hash remains as the host-owned epoch id, but
    // device authentication uses only deviceTokenSha256 while deviceId is
    // bound. Re-sending the same host hash on reconnect is therefore a no-op.
    if (previous?.pairingTokenSha256 === desired
      && previous?.pairingExpiresAt === (pairingExpiresAt ?? undefined)
      && (desired !== undefined || previous?.deviceTokenSha256 === undefined)) return previous
    this.#state.credentials[hostId] = {
      pairingTokenSha256: desired,
      pairingExpiresAt: pairingExpiresAt ?? undefined,
      deviceTokenSha256: undefined,
      deviceId: undefined,
      version: (previous?.version ?? 0) + 1,
      updatedAt: Date.now(),
    }
    // A token rotation starts a new single-device binding epoch.
    for (const key of Object.keys(this.#state.devices)) {
      if (key.startsWith(`${hostId}\u0000`)) delete this.#state.devices[key]
    }
    this.#write()
    return this.deviceCredential(hostId)
  }

  deviceCredential(hostId) {
    const value = this.#state.credentials[hostId]
    if (value === undefined) return undefined
    // Read old v1 deployments without keeping the reusable QR bearer: a
    // bound legacy token becomes the device token; an unbound one remains a
    // one-time pairing token and is exchanged on its first successful hello.
    if (value.pairingTokenSha256 === undefined && value.deviceTokenSha256 === undefined && value.tokenSha256 !== undefined) {
      return {
        ...value,
        pairingTokenSha256: value.deviceId === undefined ? value.tokenSha256 : undefined,
        pairingExpiresAt: value.pairingExpiresAt,
        deviceTokenSha256: value.deviceId === undefined ? undefined : value.tokenSha256,
      }
    }
    return { ...value }
  }

  /** Exchange the single-use QR bearer for a device-bound long-lived bearer. */
  exchangePairingCredential(hostId, pairingTokenSha256, deviceId, deviceTokenSha256) {
    const credential = this.deviceCredential(hostId)
    if (credential?.pairingTokenSha256 !== pairingTokenSha256 || credential.deviceId !== undefined) return false
    this.#state.credentials[hostId] = {
      pairingTokenSha256,
      pairingExpiresAt: credential.pairingExpiresAt,
      deviceTokenSha256,
      deviceId,
      version: credential.version,
      updatedAt: Date.now(),
    }
    this.#write()
    return true
  }

  /** Validate an already exchanged bearer against its device binding. */
  matchDeviceCredential(hostId, deviceTokenSha256, deviceId) {
    const credential = this.deviceCredential(hostId)
    return credential?.deviceTokenSha256 === deviceTokenSha256 && credential.deviceId === deviceId
  }

  audit({ hostId, deviceId = null, kind, messageId = null, outcome }) {
    this.#state.audit.push({ hostId, deviceId, kind, messageId, outcome, createdAt: Date.now() })
    if (this.#state.audit.length > AUDIT_LIMIT) this.#state.audit.splice(0, this.#state.audit.length - AUDIT_LIMIT)
    this.#write()
  }

  status(hostId) {
    const value = this.#state.hosts[hostId]
    return value === undefined ? undefined : { ...value }
  }

  close() {
    this.#write()
  }

  #read() {
    if (this.#path === ':memory:' || !existsSync(this.#path)) return emptyState()
    try {
      const value = JSON.parse(readFileSync(this.#path, 'utf8'))
      if (value?.version !== FORMAT_VERSION) return emptyState()
      return {
        version: FORMAT_VERSION,
        hosts: value.hosts ?? {},
        credentials: value.credentials ?? {},
        devices: value.devices ?? {},
        audit: Array.isArray(value.audit) ? value.audit.slice(-AUDIT_LIMIT) : [],
      }
    } catch {
      return emptyState()
    }
  }

  #write() {
    if (this.#path === ':memory:') return
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.${process.pid.toString(10)}.tmp`
    writeFileSync(temporary, JSON.stringify(this.#state), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.#path)
  }
}
