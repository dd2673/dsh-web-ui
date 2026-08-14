/** One-shot approval policy for Agent-triggered SSH side effects. */

import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

const GUARDED_TOOLS = new Set(['ssh_exec', 'ssh_cluster', 'ssh_upload', 'ssh_download', 'ssh_tunnel', 'ssh_host_key'])

function argsOf(exec: ToolExecution): Record<string, unknown> {
  return typeof exec.arguments === 'object' && exec.arguments !== null
    ? exec.arguments as Record<string, unknown>
    : {}
}

function requiresApproval(exec: ToolExecution): boolean {
  if (!GUARDED_TOOLS.has(exec.name)) return false
  const args = argsOf(exec)
  if (args.dryRun === true) return false
  if (exec.name === 'ssh_tunnel' && args.action === 'list') return false
  if (exec.name === 'ssh_host_key' && args.action !== 'trust') return false
  return true
}

function describe(exec: ToolExecution): string {
  const args = argsOf(exec)
  const alias = typeof args.alias === 'string' ? ` alias=${args.alias}` : ''
  if (exec.name === 'ssh_exec' || exec.name === 'ssh_cluster') {
    const command = typeof args.command === 'string' ? args.command.replace(/[\r\n]+/g, ' ').slice(0, 240) : '(缺失)'
    return `确认执行一次真实远程命令：${alias} command=${command}`
  }
  if (exec.name === 'ssh_upload') return `确认执行一次真实上传：${alias} ${String(args.localPath)} -> ${String(args.remotePath)}`
  if (exec.name === 'ssh_download') return `确认执行一次真实下载：${alias} ${String(args.remotePath)} -> ${String(args.localPath)}`
  if (exec.name === 'ssh_tunnel') return `确认执行 SSH 隧道操作：action=${String(args.action)}${alias}`
  return `确认更新 SSH 主机密钥：${alias} fingerprint=${String(args.fingerprint)}`
}

/** Preserve downstream deny/ask decisions, then require a one-shot grant. */
export async function sshApprovalDecision(
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  const downstream = await next()
  if (downstream.kind !== 'allow' || !requiresApproval(exec)) return downstream
  return { kind: 'ask', reason: describe(exec) }
}
