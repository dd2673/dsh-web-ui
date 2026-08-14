/**
 * Agent tools: the DSH-native counterpart of ssh-skill's CLI. Every tool
 * talks to the same engine the web UI uses, so a host configured in the GUI
 * is immediately operable by any agent, and vice versa.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SshEngine } from './engine.ts'
import type { ClusterResult, SshHostSummary, TunnelInfo } from './protocol.ts'
import { sanitizeClusterResults, sanitizeExecResult, type SafeExecResult } from './tool-output.ts'

const DEFAULT_MODEL_OUTPUT_BYTES = 64 * 1024
const MAX_MODEL_OUTPUT_BYTES = 256 * 1024

interface ToolExecResult extends Omit<SafeExecResult, 'error'> {
  /** Total JSON fields keep Code Mode callers from returning `undefined`. */
  error: string | null
  dryRun: boolean
  preview: string | null
}

function completeExecResult(result: SafeExecResult, dryRun = false, preview: string | null = null): ToolExecResult {
  return {
    ...result,
    error: result.error ?? null,
    dryRun,
    preview,
  }
}

function outputLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MODEL_OUTPUT_BYTES
  if (!Number.isInteger(limit) || limit < 1_024 || limit > MAX_MODEL_OUTPUT_BYTES) {
    throw new Error(`maxOutputBytes must be an integer in 1024..${String(MAX_MODEL_OUTPUT_BYTES)}`)
  }
  return limit
}

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Host table render shared by list surfaces. */
function renderHosts(hosts: SshHostSummary[]): string {
  if (hosts.length === 0) return 'no hosts configured'
  const rows = hosts.map(host => [
    host.alias,
    host.host,
    String(host.port),
    host.user,
    host.auth,
    host.credentialReady ? 'ready' : 'missing',
    host.secretProtection,
    host.hostKeyPinned ? 'pinned' : 'untrusted',
    host.sameHostAliases.join(','),
    host.environment ?? '-',
    (host.tags.length > 0 ? host.tags.join(',') : '-'),
    host.description ?? '',
  ].join(' | '))
  return ['alias | host | port | user | auth | credential | secret protection | host key | same endpoint aliases | environment | tags | description', '--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---', ...rows].join('\n')
}

/** Render one exec result (mirrors the bash-tool exit-code convention). */
function renderExec(result: ToolExecResult): string {
  if (result.dryRun === true) return `[dry run — not executed]\n${result.preview ?? ''}`
  const marker = result.timedOut
    ? '[timed out]'
    : `[exit code: ${result.exitCode ?? 'null'}]`
  const parts = [marker]
  if (result.stdout !== '') parts.push('stdout:\n' + result.stdout)
  if (result.stderr !== '') parts.push('stderr:\n' + result.stderr)
  if (result.error !== null) parts.push('error: ' + result.error)
  if (result.stdoutTruncated || result.stderrTruncated) parts.push('[output truncated]')
  if (result.redactions > 0 || result.controlSequencesRemoved > 0) {
    parts.push(`sanitized: ${result.controlSequencesRemoved} control sequence(s), ${result.redactions} redaction(s)`)
  }
  parts.push(`duration: ${result.durationMs} ms`)
  return parts.join('\n')
}

/** Render cluster outcomes compactly. */
function renderCluster(results: ClusterResult[]): string {
  if (results.length === 0) return 'no hosts matched'
  return results.map(result => {
    const status = result.ok ? 'ok' : result.timedOut === true ? 'timed out' : 'failed'
    const tail = result.error !== undefined ? ' (' + result.error + ')' : ''
    return `${result.alias}: ${status} [exit code: ${result.exitCode ?? 'null'}]${tail}`
  }).join('\n')
}

/** One tunnel line. */
function renderTunnel(tunnel: TunnelInfo): string {
  return `${tunnel.id} ${tunnel.alias} 127.0.0.1:${tunnel.localPort} -> ${tunnel.remoteHost}:${tunnel.remotePort} [${tunnel.state}]`
}

/** The host-list tool. */
export function sshListTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_list',
    description: 'List configured SSH hosts (alias, host, user, auth, environment, tags, description). Use ssh_exec etc. with the alias. ' +
      'Includes credential readiness, at-rest secret protection, host-key pin state, and aliases grouped by physical endpoint. ' +
      'Triggers: SSH, remote server, server IP/hostname, connect/login, check server/status, deploy, upload/download, jump host, tunnel, port forward.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy match against alias, description, host, and tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                user: { type: 'string', required: true },
                auth: { type: 'string', enum: ['key', 'password'], required: true },
                keyReady: { type: 'boolean' },
                credentialReady: { type: 'boolean', required: true },
                secretProtection: { type: 'string', enum: ['dpapi-current-user', 'file-0600', 'legacy-plaintext', 'none'], required: true },
                hostKeyPinned: { type: 'boolean', required: true },
                nodeId: { type: 'string', required: true },
                sameHostAliases: { type: 'array', items: { type: 'string' }, required: true },
                hostKeySha256: { type: 'string' },
                proxyJump: { type: 'array', items: { type: 'string' }, required: true },
                description: { type: 'string' },
                environment: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                location: { type: 'string' },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { hosts?: SshHostSummary[] }) => text(renderHosts(value.hosts ?? [])),
    },
    async execute(args) {
      return { hosts: engine.list(args.query) }
    },
  })
}

/** The command-execution tool. */
export function sshExecTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_exec',
    description: 'Execute a command on a configured SSH host by alias. Model-visible output is stripped of terminal controls, high-confidence secrets are redacted, and output is byte-capped. ' +
      'Use dryRun=true to preview without connecting; real execution requires one-shot user approval. Prefer combining independent read-only queries into one command. ' +
      'Triggers: run command on server, deploy, check server/status, service control, view logs, any remote operation.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_list.' },
      command: { type: 'string', required: true, description: 'The shell command to run remotely.' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 60000).' },
      maxOutputBytes: { type: 'integer', description: 'Model-output byte cap per stdout/stderr stream (1024..262144; default 65536).' },
      dryRun: { type: 'boolean', description: 'Preview the alias and command without opening SSH or executing anything.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          stdoutBytes: { type: 'integer', required: true },
          stderrBytes: { type: 'integer', required: true },
          stdoutTruncated: { type: 'boolean', required: true },
          stderrTruncated: { type: 'boolean', required: true },
          redactions: { type: 'integer', required: true },
          controlSequencesRemoved: { type: 'integer', required: true },
          durationMs: { type: 'integer', required: true },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          dryRun: { type: 'boolean', required: true },
          preview: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value: ToolExecResult) => text(renderExec(value)),
    },
    async execute(args) {
      const limit = outputLimit(args.maxOutputBytes)
      if (args.dryRun === true) {
        return completeExecResult({
          success: true,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          redactions: 0,
          controlSequencesRemoved: 0,
          durationMs: 0,
        }, true, `alias=${args.alias}\ncommand=${args.command}`)
      }
      try {
        if (args.command.trim() === '') throw new Error('command must not be empty')
        if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 100 || args.timeoutMs > 3_600_000)) {
          throw new Error('timeoutMs must be an integer in 100..3600000')
        }
        return completeExecResult(sanitizeExecResult(await engine.exec(args.alias, args.command, args.timeoutMs), limit))
      } catch (error) {
        return completeExecResult(sanitizeExecResult({
          success: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
        }, limit))
      }
    },
  })
}

/** The upload tool. */
export function sshUploadTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_upload',
    description: 'Upload a local file or bounded directory tree to a configured SSH host. The local path is on THIS machine (the dsh host). ' +
      'Defaults to refusing remote overwrite; use dryRun=true to preview, and real transfer requires one-shot user approval. ' +
      'Triggers: upload file to server, deploy artifact, copy config to server.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_list.' },
      localPath: { type: 'string', required: true, description: 'Absolute local file path on this machine.' },
      remotePath: { type: 'string', required: true, description: 'Destination path on the remote host (parent dirs are created).' },
      recursive: { type: 'boolean', description: 'Allow directory upload (default false).' },
      maxFiles: { type: 'integer', description: 'Upload file cap (default 500, max 10000).' },
      maxBytes: { type: 'integer', description: 'Upload total byte cap (default 536870912, max 8589934592).' },
      overwrite: { type: 'boolean', description: 'Allow replacing existing remote files (default false).' },
      dryRun: { type: 'boolean', description: 'Preview the transfer without reading local data or connecting.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          transferredBytes: { type: 'integer' },
          files: { type: 'integer' },
          error: { type: 'string' },
          dryRun: { type: 'boolean' },
          preview: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; transferredBytes?: number; files?: number; error?: string; dryRun?: boolean; preview?: string }) => text(value.dryRun === true
        ? `[dry run — not uploaded]\n${value.preview ?? ''}`
        : value.ok ? `uploaded ${value.files ?? 1} file(s), ${value.transferredBytes ?? 0} bytes`
        : `upload failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      if (args.dryRun === true) {
        return { ok: true, dryRun: true, preview: `${args.localPath} -> ${args.alias}:${args.remotePath}\nrecursive=${String(args.recursive === true)} maxFiles=${String(args.maxFiles ?? 500)} maxBytes=${String(args.maxBytes ?? 536_870_912)} overwrite=${String(args.overwrite === true)}` }
      }
      try {
        const outcome = await engine.upload(args.alias, args.localPath, args.remotePath, args.recursive === true, undefined, args.overwrite === true, {
          maxFiles: args.maxFiles ?? 500,
          maxBytes: args.maxBytes ?? 512 * 1024 * 1024,
        })
        return { ok: true, transferredBytes: outcome.bytes, files: outcome.files }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The download tool. */
export function sshDownloadTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_download',
    description: 'Download a remote file or bounded directory tree from a configured SSH host to an absolute local path on this machine. ' +
      'Recursive mode skips symlinks/special nodes and enforces file/byte caps. Local overwrite defaults off; real transfer requires one-shot user approval. ' +
      'Triggers: download file from server, fetch remote log/artifact.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_list.' },
      remotePath: { type: 'string', required: true, description: 'Remote file path.' },
      localPath: { type: 'string', required: true, description: 'Absolute destination path on this machine.' },
      recursive: { type: 'boolean', description: 'Download a remote directory tree (default false).' },
      maxFiles: { type: 'integer', description: 'Recursive file cap (default 500, max 10000).' },
      maxBytes: { type: 'integer', description: 'Recursive total byte cap (default 536870912, max 8589934592).' },
      overwrite: { type: 'boolean', description: 'Allow replacing existing local files (default false).' },
      dryRun: { type: 'boolean', description: 'Preview without connecting or writing local files.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          bytes: { type: 'integer' },
          files: { type: 'integer' },
          error: { type: 'string' },
          dryRun: { type: 'boolean' },
          preview: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; bytes?: number; files?: number; error?: string; dryRun?: boolean; preview?: string }) => text(value.dryRun === true
        ? `[dry run — not downloaded]\n${value.preview ?? ''}`
        : value.ok ? `downloaded ${value.files ?? 1} file(s), ${value.bytes ?? 0} bytes`
        : `download failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      if (args.dryRun === true) {
        return { ok: true, dryRun: true, preview: `${args.alias}:${args.remotePath} -> ${args.localPath}\nrecursive=${String(args.recursive === true)} overwrite=${String(args.overwrite === true)}` }
      }
      try {
        if (args.recursive === true) {
          const outcome = await engine.downloadDirectory(args.alias, args.remotePath, args.localPath, {
            maxFiles: args.maxFiles,
            maxBytes: args.maxBytes,
            overwrite: args.overwrite === true,
          })
          return { ok: true, bytes: outcome.bytes, files: outcome.files }
        }
        const outcome = await engine.download(args.alias, args.remotePath, args.localPath, undefined, args.overwrite === true)
        return { ok: true, bytes: outcome.bytes, files: 1 }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The tunnel tool. */
export function sshTunnelTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_tunnel',
    description: 'Manage local port-forward tunnels to a configured SSH host. Start a tunnel to reach a remote internal service (database, web UI, API) through 127.0.0.1 on this machine. ' +
      'List is read-only; start/stop actions require one-shot user approval and support dryRun preview. ' +
      'Triggers: tunnel, port forward, connect database, access internal service.',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'list', 'stop', 'stop-all'], description: 'start / list / stop / stop-all.' },
      alias: { type: 'string', description: 'Host alias (required for start, optional for stop-all).' },
      remotePort: { type: 'integer', description: 'Port on the remote side (required for start).' },
      remoteHost: { type: 'string', description: 'Remote host to forward to (default 127.0.0.1 — the server itself).' },
      localPort: { type: 'integer', description: 'Local listening port (default: auto-assigned).' },
      tunnelId: { type: 'string', description: 'Tunnel id (required for stop).' },
      dryRun: { type: 'boolean', description: 'Preview a mutating tunnel action without changing tunnel state.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tunnel: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              alias: { type: 'string', required: true },
              localPort: { type: 'integer', required: true },
              remoteHost: { type: 'string', required: true },
              remotePort: { type: 'integer', required: true },
              state: { type: 'string', enum: ['forwarding', 'connecting', 'failed'], required: true },
              error: { type: 'string' },
              startedAt: { type: 'integer', required: true },
            },
          },
          tunnels: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                alias: { type: 'string', required: true },
                localPort: { type: 'integer', required: true },
                remoteHost: { type: 'string', required: true },
                remotePort: { type: 'integer', required: true },
                state: { type: 'string', enum: ['forwarding', 'connecting', 'failed'], required: true },
                error: { type: 'string' },
                startedAt: { type: 'integer', required: true },
              },
            },
          },
          stopped: { type: 'integer' },
          error: { type: 'string' },
          dryRun: { type: 'boolean' },
          preview: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; tunnel?: TunnelInfo; tunnels?: TunnelInfo[]; stopped?: number; error?: string; dryRun?: boolean; preview?: string }) => {
        if (value.dryRun === true) return text(`[dry run — tunnel unchanged]\n${value.preview ?? ''}`)
        if (value.error !== undefined) return text(`tunnel error: ${value.error}`)
        if (value.tunnel !== undefined) {
          if (value.tunnel.state === 'failed') return text(`tunnel failed: ${value.tunnel.error ?? 'unknown error'}`)
          return text(`tunnel started: ${renderTunnel(value.tunnel)}`)
        }
        if (value.tunnels !== undefined) return text(value.tunnels.length === 0 ? 'no active tunnels' : value.tunnels.map(renderTunnel).join('\n'))
        return text(`stopped ${value.stopped ?? 0} tunnel(s)`)
      },
    },
    async execute(args) {
      if (args.dryRun === true && args.action !== 'list') {
        return { ok: true, dryRun: true, preview: `action=${args.action} alias=${args.alias ?? '-'} remote=${args.remoteHost ?? '127.0.0.1'}:${String(args.remotePort ?? '-')} localPort=${String(args.localPort ?? 'auto')} tunnelId=${args.tunnelId ?? '-'}` }
      }
      if (args.action === 'list') {
        return { ok: true, tunnels: engine.listTunnels() }
      }
      if (args.action === 'start') {
        if (args.alias === undefined || args.remotePort === undefined) {
          throw new Error('alias and remotePort are required for start')
        }
        try {
          const tunnel = await engine.startTunnel(args.alias, {
            remotePort: args.remotePort,
            remoteHost: args.remoteHost,
            localPort: args.localPort,
          })
          return { ok: true, tunnel }
        } catch (error) {
          return { ok: false, tunnel: { id: '', alias: args.alias, localPort: 0, remoteHost: args.remoteHost ?? '127.0.0.1', remotePort: args.remotePort, state: 'failed' as const, error: error instanceof Error ? error.message : String(error), startedAt: Date.now() } }
        }
      }
      if (args.action === 'stop') {
        if (args.tunnelId === undefined) throw new Error('tunnelId is required for stop')
        const stopped = engine.stopTunnel(args.tunnelId)
        return stopped
          ? { ok: true, stopped: 1 }
          : { ok: false, stopped: 0, error: `tunnel '${args.tunnelId}' not found` }
      }
      if (args.action === 'stop-all') {
        const stopped = engine.stopAllTunnels(args.alias)
        return { ok: true, stopped }
      }
      throw new Error(`unknown action '${String(args.action)}'`)
    },
  })
}

/** Audit or explicitly rotate the pinned server host key from the Agent surface. */
export function sshHostKeyTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_host_key',
    description: 'Scan/verify a server SSH Host Key without sending login credentials, or explicitly trust a freshly observed SHA-256 fingerprint. ' +
      'scan and verify are read-only; trust requires the exact fingerprint and one-shot user approval.',
    parameters: {
      action: { type: 'string', required: true, enum: ['scan', 'verify', 'trust'], description: 'scan / verify / trust.' },
      alias: { type: 'string', required: true, description: 'Host alias from ssh_list.' },
      fingerprint: { type: 'string', description: 'Exact freshly scanned SHA256 fingerprint (required for trust).' },
      dryRun: { type: 'boolean', description: 'Preview trust without changing the pin.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          alias: { type: 'string', required: true },
          pinned: { type: 'string' },
          scanned: { type: 'string' },
          matches: { type: 'boolean' },
          trusted: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          preview: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; alias: string; pinned?: string; scanned?: string; matches?: boolean; trusted?: boolean; dryRun?: boolean; preview?: string; error?: string }) => {
        if (value.dryRun === true) return text(`[dry run — host key unchanged]\n${value.preview ?? ''}`)
        if (!value.ok) return text(`host-key operation failed for ${value.alias}: ${value.error ?? 'unknown error'}`)
        return text([
          `alias: ${value.alias}`,
          `pinned: ${value.pinned ?? '(none)'}`,
          `scanned: ${value.scanned ?? '(not scanned)'}`,
          `matches: ${String(value.matches ?? false)}`,
          `trusted: ${String(value.trusted ?? false)}`,
        ].join('\n'))
      },
    },
    async execute(args) {
      if (args.action === 'trust' && args.dryRun === true) {
        return { ok: true, alias: args.alias, dryRun: true, preview: `trust ${args.alias} fingerprint=${args.fingerprint ?? '(missing)'}` }
      }
      try {
        if (args.action === 'trust') {
          if (args.fingerprint === undefined || args.fingerprint === '') throw new Error('fingerprint is required for trust')
          const result = await engine.trustHostKey(args.alias, args.fingerprint)
          return { ok: true, ...result, trusted: true }
        }
        const result = await engine.inspectHostKey(args.alias)
        return { ok: true, ...result, trusted: false }
      } catch (error) {
        return { ok: false, alias: args.alias, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The cluster tool. */
export function sshClusterTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_cluster',
    description: 'Run one command concurrently across many SSH hosts (all hosts, or filtered by aliases / environment / tags). ' +
      'Fails closed when multiple aliases resolve to the same host:port unless allowDuplicateHosts=true is explicit. Output is sanitized/redacted/capped. Use dryRun to inspect targets without executing. ' +
      'Triggers: run on all servers, batch operation, production servers, cluster command.',
    parameters: {
      command: { type: 'string', required: true, description: 'The shell command to run on every matched host.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Explicit alias list; when absent every configured host matches.' },
      environment: { type: 'string', description: 'Only hosts with this environment label.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only hosts carrying ALL these tags.' },
      timeoutMs: { type: 'integer', description: 'Per-host timeout in milliseconds.' },
      maxWorkers: { type: 'integer', description: 'Concurrency cap (default 8).' },
      allowDuplicateHosts: { type: 'boolean', description: 'Intentionally execute once per matching alias even when aliases share one physical endpoint (default false).' },
      maxOutputBytes: { type: 'integer', description: 'Approximate total model-output budget across cluster stdout/stderr (1024..262144; default 65536).' },
      dryRun: { type: 'boolean', description: 'Return selected aliases without opening SSH or executing commands.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                timedOut: { type: 'boolean' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                stdoutBytes: { type: 'integer' },
                stderrBytes: { type: 'integer' },
                stdoutTruncated: { type: 'boolean' },
                stderrTruncated: { type: 'boolean' },
                redactions: { type: 'integer' },
                controlSequencesRemoved: { type: 'integer' },
                durationMs: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
          targets: { type: 'array', items: { type: 'string' } },
          dryRun: { type: 'boolean' },
          preview: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { results?: ClusterResult[]; targets?: string[]; dryRun?: boolean; preview?: string; error?: string }) => {
        if (value.dryRun === true) return text(`[dry run — not executed]\n${value.preview ?? ''}`)
        if (value.error !== undefined) return text(`cluster failed: ${value.error}`)
        return text(renderCluster(value.results ?? []))
      },
    },
    async execute(args) {
      const limit = outputLimit(args.maxOutputBytes)
      if (args.dryRun === true) {
        const targets = engine.clusterTargets(args).map(target => target.alias)
        return { results: [], targets, dryRun: true, preview: `targets=${targets.join(', ') || '(none)'}\ncommand=${args.command}` }
      }
      try {
        const results = await engine.cluster(args)
        return { results: sanitizeClusterResults(results, limit) }
      } catch (error) {
        return { results: [], error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
