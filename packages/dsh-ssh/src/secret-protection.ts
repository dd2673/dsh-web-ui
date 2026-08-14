/**
 * At-rest protection for SSH passwords and key passphrases.
 *
 * Windows uses DPAPI CurrentUser so copied store files cannot be decrypted by
 * another account or machine. Other platforms retain the existing 0600 file
 * model; the prefix keeps the on-disk format forward-compatible with a future
 * native keychain backend.
 */

import { spawnSync } from 'node:child_process'

const DPAPI_PREFIX = 'dpapi:v1:'

export type SecretProtection = 'dpapi-current-user' | 'file-0600' | 'legacy-plaintext' | 'none'

/** Report the actual persisted protection of the supplied password/passphrase fields. */
export function persistedSecretProtection(...values: Array<string | undefined>): SecretProtection {
  const secrets = values.filter((value): value is string => value !== undefined && value !== '')
  if (secrets.length === 0) return 'none'
  const dpapiCount = secrets.filter(value => value.startsWith(DPAPI_PREFIX)).length
  if (dpapiCount === secrets.length) return 'dpapi-current-user'
  if (process.platform === 'win32') return 'legacy-plaintext'
  return 'file-0600'
}

const PROTECT_SCRIPT = [
  '$value=[Console]::In.ReadToEnd()',
  '$bytes=[Text.Encoding]::UTF8.GetBytes($value)',
  '$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($cipher))',
].join(';')

const UNPROTECT_SCRIPT = [
  '$value=[Console]::In.ReadToEnd()',
  '$cipher=[Convert]::FromBase64String($value)',
  '$bytes=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))',
].join(';')

/** Whether this process can protect secrets with the Windows user profile. */
export function usesDpapi(): boolean {
  return process.platform === 'win32'
}

function runDpapi(script: string, input: string): string {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0 || result.error !== undefined) {
    const detail = result.error?.message ?? (result.stderr.trim() || `exit code ${String(result.status)}`)
    throw new Error(`Windows DPAPI operation failed: ${detail}`)
  }
  return result.stdout.trim()
}

/** Encode a secret for the persisted store. Empty/absent values stay absent. */
export function protectSecret(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return value
  if (!usesDpapi()) return value
  return DPAPI_PREFIX + runDpapi(PROTECT_SCRIPT, value)
}

/** Decode a persisted secret. Legacy plaintext values remain readable. */
export function unprotectSecret(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return value
  if (!value.startsWith(DPAPI_PREFIX)) return value
  if (!usesDpapi()) {
    throw new Error('this SSH store contains Windows DPAPI secrets and can only be opened by the owning Windows user')
  }
  return runDpapi(UNPROTECT_SCRIPT, value.slice(DPAPI_PREFIX.length))
}
