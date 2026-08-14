/**
 * Tool-layer tests: every factory must construct (the rc.6 defineTool DSL
 * rejects raw JSON Schema 'required' arrays — a regression here would fail
 * plugin startup), and the execute/render contracts must not drift.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SshEngine } from '../src/engine.ts'
import type { ExecResult, SshHostSummary, TunnelInfo } from '../src/protocol.ts'
import {
  sshClusterTool,
  sshDownloadTool,
  sshExecTool,
  sshHostKeyTool,
  sshListTool,
  sshTunnelTool,
  sshUploadTool,
} from '../src/tools.ts'

/** In-memory engine stub: enough surface for the tool factories. */
class StubEngine {
  hosts: SshHostSummary[] = []
  execFailure: Error | undefined
  tunnelStartError: Error | undefined
  tunnelExists = true

  list(): SshHostSummary[] {
    return this.hosts
  }
  find(): SshHostSummary | undefined {
    return undefined
  }
  async exec(_alias: string, _command: string, _timeoutMs?: number): Promise<ExecResult> {
    if (this.execFailure !== undefined) throw this.execFailure
    return {
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: 'hello out',
      stderr: '',
      stdoutBytes: 9,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 5,
    }
  }
  async cluster(): Promise<unknown[]> {
    return []
  }
  clusterTargets(): SshHostSummary[] {
    return this.hosts
  }
  async upload(): Promise<{ bytes: number; files: number }> {
    return { bytes: 12, files: 1 }
  }
  async download(): Promise<{ bytes: number }> {
    return { bytes: 34 }
  }
  listTunnels(): TunnelInfo[] {
    return []
  }
  async startTunnel(): Promise<TunnelInfo> {
    if (this.tunnelStartError !== undefined) throw this.tunnelStartError
    throw new Error('unexpected')
  }
  stopTunnel(_id: string): boolean {
    return this.tunnelExists
  }
  stopAllTunnels(): number {
    return 0
  }
  async test(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async inspectHostKey(): Promise<{ alias: string; pinned?: string; scanned: string; matches: boolean }> {
    return { alias: 'web-01', pinned: 'SHA256:old', scanned: 'SHA256:new', matches: false }
  }
  async trustHostKey(): Promise<{ alias: string; pinned?: string; scanned: string; matches: boolean }> {
    return { alias: 'web-01', pinned: 'SHA256:new', scanned: 'SHA256:new', matches: true }
  }
}

const engine = (stub: StubEngine): SshEngine => stub as unknown as SshEngine

/** ToolDefinition.execute needs a ToolRunContext; tests pass a dummy. */
function run(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return tool.execute(args, {} as never) as Promise<Record<string, unknown>>
}

function render(tool: ToolDefinition, value: unknown): string {
  const blocks = tool.output.render({}, value as never)
  const first = blocks[0]
  return first !== undefined && 'text' in first ? first.text : ''
}

const host: SshHostSummary = {
  alias: 'web-01',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  auth: 'key',
  keyReady: true,
  credentialReady: true,
  secretProtection: 'none',
  hostKeyPinned: true,
  nodeId: '10.0.0.1:22',
  sameHostAliases: ['web-01'],
  hostKeySha256: 'SHA256:test-fingerprint',
  proxyJump: [],
  description: 'web',
  environment: 'production',
  tags: ['web'],
  location: 'dc-a',
  createdAt: 1,
  updatedAt: 1,
}

describe('tool factories (defineTool DSL regression)', () => {
  it('constructs every tool without throwing', () => {
    const stub = new StubEngine()
    const factories = [
      sshListTool, sshExecTool, sshUploadTool, sshDownloadTool, sshTunnelTool, sshClusterTool, sshHostKeyTool,
    ]
    for (const factory of factories) {
      expect(() => factory(engine(stub))).not.toThrow()
    }
  })
})

describe('ssh_list', () => {
  it('declares every returned host field and renders a table', async () => {
    const stub = new StubEngine()
    stub.hosts = [host]
    const tool = sshListTool(engine(stub))
    const result = await run(tool, {})
    expect((result.hosts as SshHostSummary[])).toEqual([host])
    const schema = tool.output.schema as {
      properties: { hosts: { items: { properties: Record<string, unknown> } } }
    }
    expect(schema.properties.hosts.items.properties).toHaveProperty('hostKeySha256')
    expect(schema.properties.hosts.items.properties).toHaveProperty('credentialReady')
    expect(schema.properties.hosts.items.properties).toHaveProperty('sameHostAliases')
    const text = render(tool, result)
    expect(text).toContain('web-01')
    expect(text).toContain('10.0.0.1')
  })
})

describe('ssh_exec', () => {
  it('propagates engine failures as a failed result, not a throw', async () => {
    const stub = new StubEngine()
    stub.execFailure = new Error('connection refused')
    const tool = sshExecTool(engine(stub))
    const result = await run(tool, { alias: 'web-01', command: 'true' })
    expect(result.success).toBe(false)
    expect(result.error).toBe('connection refused')
  })

  it('renders timed-out results with the timed-out marker', async () => {
    const stub = new StubEngine()
    const tool = sshExecTool(engine(stub))
    const result = await run(tool, { alias: 'web-01', command: 'hang' })
    const text = render(tool, { ...result, timedOut: true, exitCode: null, stdout: '', stderr: '' })
    expect(text).toContain('[timed out]')
  })

  it('returns total lossless-JSON fields so Code Mode does not retry a completed command', async () => {
    const stub = new StubEngine()
    const tool = sshExecTool(engine(stub))
    const result = await run(tool, { alias: 'web-01', command: 'true' })
    expect(result.error).toBeNull()
    expect(result.dryRun).toBe(false)
    expect(result.preview).toBeNull()
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('returns a non-executing preview for dryRun', async () => {
    const stub = new StubEngine()
    const result = await run(sshExecTool(engine(stub)), { alias: 'web-01', command: 'uptime', dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.preview).toContain('web-01')
  })
})

describe('ssh_tunnel', () => {
  it('reports an unknown tunnel id honestly (stopped: 0 + error)', async () => {
    const stub = new StubEngine()
    stub.tunnelExists = false
    const tool = sshTunnelTool(engine(stub))
    const result = await run(tool, { action: 'stop', tunnelId: 'tun-999' })
    expect(result.ok).toBe(false)
    expect(result.stopped).toBe(0)
    expect(result.error).toContain('not found')
    const text = render(tool, result)
    expect(text).toContain('tunnel error')
  })

  it('renders a failed start as a failure, not "tunnel started"', async () => {
    const stub = new StubEngine()
    stub.tunnelStartError = new Error('EADDRINUSE')
    const tool = sshTunnelTool(engine(stub))
    const result = await run(tool, { action: 'start', alias: 'web-01', remotePort: 5432 })
    expect(result.ok).toBe(false)
    expect((result.tunnel as { state?: string } | undefined)?.state).toBe('failed')
    const text = render(tool, result)
    expect(text).toContain('tunnel failed')
    expect(text).toContain('EADDRINUSE')
  })
})

describe('ssh_upload / ssh_download', () => {
  it('maps engine outcomes into ok results', async () => {
    const stub = new StubEngine()
    const upload = sshUploadTool(engine(stub))
    const up = await run(upload, { alias: 'web-01', localPath: '/tmp/a', remotePath: '/tmp/b' })
    expect(up.ok).toBe(true)
    expect(up.transferredBytes).toBe(12)

    const download = sshDownloadTool(engine(stub))
    const down = await run(download, { alias: 'web-01', remotePath: '/tmp/b', localPath: '/tmp/a' })
    expect(down.ok).toBe(true)
    expect(down.bytes).toBe(34)
  })

  it('supports dry-run previews without touching the engine', async () => {
    const stub = new StubEngine()
    const upload = await run(sshUploadTool(engine(stub)), {
      alias: 'web-01', localPath: 'C:\\tmp\\a', remotePath: '/tmp/a', dryRun: true,
    })
    const download = await run(sshDownloadTool(engine(stub)), {
      alias: 'web-01', remotePath: '/tmp/a', localPath: 'C:\\tmp\\a', recursive: true, dryRun: true,
    })
    expect(upload.dryRun).toBe(true)
    expect(download.dryRun).toBe(true)
  })
})

describe('ssh_host_key', () => {
  it('audits and explicitly rotates a pinned fingerprint', async () => {
    const stub = new StubEngine()
    const tool = sshHostKeyTool(engine(stub))
    const verified = await run(tool, { action: 'verify', alias: 'web-01' })
    expect(verified.matches).toBe(false)
    const trusted = await run(tool, { action: 'trust', alias: 'web-01', fingerprint: 'SHA256:new' })
    expect(trusted.matches).toBe(true)
  })
})
