/** Model-facing output sanitization; the Web terminal intentionally stays raw. */

import type { ClusterResult, ExecResult } from './protocol.ts'

export interface SafeExecResult extends ExecResult {
  redactions: number
  controlSequencesRemoved: number
}

interface SanitizedText {
  text: string
  redactions: number
  controls: number
}

function replaceCount(input: string, pattern: RegExp, replacement: string | ((...args: string[]) => string)): { text: string; count: number } {
  if (typeof replacement === 'string') {
    return { text: input.replace(pattern, replacement), count: input.match(pattern)?.length ?? 0 }
  }
  let count = 0
  const text = input.replace(pattern, (...args: string[]) => {
    count += 1
    return replacement(...args)
  })
  return { text, count }
}

function sanitizeText(input: string): SanitizedText {
  let text = input
  let controls = 0
  let redactions = 0
  const strip = (pattern: RegExp): void => {
    const result = replaceCount(text, pattern, '')
    text = result.text
    controls += result.count
  }

  // OSC/DCS/APC/PM, CSI, two-byte ESC sequences, then remaining C0/C1 controls.
  strip(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g)
  strip(/\u001B[PX^_][\s\S]*?\u001B\\/g)
  strip(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g)
  strip(/\u001B[ -/]*[@-~]/g)
  strip(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g)

  const redact = (pattern: RegExp, replacement: string | ((...args: string[]) => string)): void => {
    const result = replaceCount(text, pattern, replacement)
    text = result.text
    redactions += result.count
  }
  redact(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, '[REDACTED_PRIVATE_KEY]')
  redact(/^(SSH_(?:CONNECTION|CLIENT))=.*$/gmi, '$1=[REDACTED]')
  // The lookahead starts at the variable name, so exact names such as TOKEN
  // and PASSWORD are covered as well as prefixed/suffixed variants.
  redact(/^((?:export\s+)?(?=[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*=)[A-Z_][A-Z0-9_]*)=.*$/gmi, '$1=[REDACTED]')
  redact(/^(Authorization\s*:\s*)(?:Bearer|Basic)\s+\S+.*$/gmi, '$1[REDACTED]')
  redact(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
  redact(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@')
  redact(/(--?(?:password|passwd|token|secret|api-key|access-key)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
  return { text, redactions, controls }
}

function truncateUtf8(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(input, 'utf8')
  if (bytes.length <= maxBytes) return { text: input, truncated: false }
  const marker = Buffer.from('...[tool output truncated]', 'utf8')
  const budget = Math.max(0, maxBytes - marker.length)
  const prefix = bytes.subarray(0, budget).toString('utf8').replace(/\uFFFD$/, '')
  const text = prefix + marker.toString('utf8')
  return { text: Buffer.byteLength(text, 'utf8') <= maxBytes ? text : marker.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

/** Sanitize, redact, and byte-cap one exec result before it reaches model context. */
export function sanitizeExecResult(result: ExecResult, maxBytesPerStream: number): SafeExecResult {
  const stdout = sanitizeText(result.stdout)
  const stderr = sanitizeText(result.stderr)
  const error = result.error === undefined ? undefined : sanitizeText(result.error)
  const safeStdout = truncateUtf8(stdout.text, maxBytesPerStream)
  const safeStderr = truncateUtf8(stderr.text, maxBytesPerStream)
  return {
    ...result,
    stdout: safeStdout.text,
    stderr: safeStderr.text,
    stdoutTruncated: result.stdoutTruncated || safeStdout.truncated,
    stderrTruncated: result.stderrTruncated || safeStderr.truncated,
    ...(error !== undefined ? { error: error.text } : {}),
    redactions: stdout.redactions + stderr.redactions + (error?.redactions ?? 0),
    controlSequencesRemoved: stdout.controls + stderr.controls + (error?.controls ?? 0),
  }
}

/** Apply the same model boundary to every cluster member under one total budget. */
export function sanitizeClusterResults(results: ClusterResult[], totalOutputBytes: number): ClusterResult[] {
  const perStream = Math.max(64, Math.floor(totalOutputBytes / Math.max(1, results.length * 2)))
  return results.map((result) => {
    const safe = sanitizeExecResult({
      success: result.ok,
      exitCode: result.exitCode ?? null,
      timedOut: result.timedOut ?? false,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout ?? '', 'utf8'),
      stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr ?? '', 'utf8'),
      stdoutTruncated: result.stdoutTruncated ?? false,
      stderrTruncated: result.stderrTruncated ?? false,
      durationMs: result.durationMs ?? 0,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }, perStream)
    return {
      alias: result.alias,
      ok: result.ok,
      exitCode: safe.exitCode,
      timedOut: safe.timedOut,
      stdout: safe.stdout,
      stderr: safe.stderr,
      stdoutBytes: safe.stdoutBytes,
      stderrBytes: safe.stderrBytes,
      stdoutTruncated: safe.stdoutTruncated,
      stderrTruncated: safe.stderrTruncated,
      durationMs: safe.durationMs,
      redactions: safe.redactions,
      controlSequencesRemoved: safe.controlSequencesRemoved,
      ...(safe.error !== undefined ? { error: safe.error } : {}),
    }
  })
}
