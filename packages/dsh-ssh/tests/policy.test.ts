import { describe, expect, it } from 'vitest'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { sshApprovalDecision } from '../src/policy.ts'

const allow = async (): Promise<PreToolDecision> => ({ kind: 'allow' })
const call = (name: string, args: Record<string, unknown> = {}): ToolExecution => ({
  name,
  arguments: args,
} as ToolExecution)

describe('SSH tool approval policy', () => {
  it.each([
    ['ssh_exec', { alias: 'prod', command: 'true' }],
    ['ssh_cluster', { command: 'true' }],
    ['ssh_upload', { alias: 'prod', localPath: 'C:\\a', remotePath: '/a' }],
    ['ssh_download', { alias: 'prod', remotePath: '/a', localPath: 'C:\\a' }],
    ['ssh_tunnel', { action: 'start', alias: 'prod', remotePort: 22 }],
    ['ssh_host_key', { action: 'trust', alias: 'prod', fingerprint: 'SHA256:x' }],
  ])('asks for one-shot approval before %s side effects', async (name, args) => {
    const decision = await sshApprovalDecision(call(name, args), allow)
    expect(decision.kind).toBe('ask')
    if (decision.kind === 'ask') expect(decision.reason).toMatch(/^确认/)
  })

  it('allows inventory, host-key audit, tunnel listing, and dry runs without approval', async () => {
    expect(await sshApprovalDecision(call('ssh_list'), allow)).toEqual({ kind: 'allow' })
    expect(await sshApprovalDecision(call('ssh_host_key', { action: 'verify' }), allow)).toEqual({ kind: 'allow' })
    expect(await sshApprovalDecision(call('ssh_tunnel', { action: 'list' }), allow)).toEqual({ kind: 'allow' })
    expect(await sshApprovalDecision(call('ssh_exec', { dryRun: true }), allow)).toEqual({ kind: 'allow' })
  })

  it('never weakens a downstream denial', async () => {
    const deny = async (): Promise<PreToolDecision> => ({ kind: 'deny', reason: 'blocked elsewhere' })
    expect(await sshApprovalDecision(call('ssh_exec'), deny)).toEqual({ kind: 'deny', reason: 'blocked elsewhere' })
  })
})
