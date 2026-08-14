import { describe, expect, it } from 'vitest'
import { sanitizeExecResult } from '../src/tool-output.ts'

describe('model-facing SSH output safety', () => {
  it('removes ANSI/control sequences and redacts high-confidence secrets', () => {
    const result = sanitizeExecResult({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: '\u001b[31mred\u001b[0m\nSSH_CONNECTION=1.2.3.4 123 5.6.7.8 22\nAPI_TOKEN=top-secret\nTOKEN=exact-name-secret\nPASSWORD=another-secret\nAuthorization: Bearer abcdefghijklmnop',
      stderr: 'postgres://user:password@example.test/db\u0000\n--token "quoted secret value"',
      stdoutBytes: 120,
      stderrBytes: 45,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 5,
    }, 64 * 1024)

    expect(result.stdout).toContain('red')
    expect(result.stdout).not.toContain('\u001b')
    expect(result.stdout).not.toContain('top-secret')
    expect(result.stdout).not.toContain('exact-name-secret')
    expect(result.stdout).not.toContain('another-secret')
    expect(result.stdout).toContain('API_TOKEN=[REDACTED]')
    expect(result.stdout).toContain('SSH_CONNECTION=[REDACTED]')
    expect(result.stdout).not.toContain('1.2.3.4')
    expect(result.stdout).not.toContain('abcdefghijklmnop')
    expect(result.stderr).not.toContain('password')
    expect(result.stderr).not.toContain('quoted secret value')
    expect(result.stderr).toContain('postgres://user:[REDACTED]@example.test/db')
    expect(result.stderr).not.toContain('\u0000')
    expect(result.redactions).toBeGreaterThanOrEqual(4)
    expect(result.controlSequencesRemoved).toBeGreaterThan(0)
  })

  it('applies a model-output byte limit and exposes truncation', () => {
    const result = sanitizeExecResult({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: '你'.repeat(1_000),
      stderr: '',
      stdoutBytes: 3_000,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    }, 128)
    expect(result.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(128)
    expect(result.stdout).not.toContain('\uFFFD')
  })
})
