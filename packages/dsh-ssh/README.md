# dsh-wending-ssh-manager — 稳定 SSH/SFTP 管理插件

基于 [badseal/ssh-skill](https://github.com/badseal/ssh-skill) 的能力清单，为
DeepSeek Harness（DSH）定制的远程 SSH 插件：Host 进程内的持久连接池 + Web GUI
主机管理面板 + Web 终端 + Agent 工具，全部通过官方 NPM SDK 实现，不修改 DSH
源码。

## 能力

| 能力 | 说明 |
| --- | --- |
| 主机管理 | 同一 IP 可按不同 alias 保存多个账号；增删改查、搜索、连接测试；支持密钥 / 密码认证、passphrase 密钥、ProxyJump 跳板机（多级） |
| 配置导入 | 一键解析标准 `~/.ssh/config`（Host/HostName/User/Port/IdentityFile/ProxyJump 等），已有别名自动跳过 |
| 持久连接池 | 每台主机复用长连接，空闲 30 分钟自动断开；连接前失败可重试，已经开始的远程命令绝不自动重放 |
| 命令执行 | exec 带超时（默认 60s），stdout/stderr 分离；引擎按 UTF-8 字节截断并报告原始字节数/截断状态，Agent 输出另有可调 1KB-256KB 上限 |
| Web 终端 | xterm.js + WebSocket PTY 终端，自适应尺寸，实时输出 |
| 文件传输 | SFTP 上传/下载文件及受限目录树；Agent 默认禁止覆盖，递归下载限制文件数/总字节且不跟随 symlink；远程目录浏览 |
| 端口转发 | 本地端口转发隧道（仅监听 127.0.0.1），访问远程数据库 / 内网服务，支持列表 / 停止 |
| 集群执行 | 一条命令并发跑多台主机（按别名 / 环境 / 标签过滤，默认并发 8）；同一 endpoint 多 alias 默认整批拒绝，须明确允许才重复执行 |
| Agent 工具 | `ssh_list` / `ssh_exec` / `ssh_upload` / `ssh_download` / `ssh_tunnel` / `ssh_cluster` / `ssh_host_key`，GUI 与 Agent 共享同一份主机配置 |

## 安全模型

- 所有 `/api/dsh-ssh/*` 路由仅限 loopback 访问（含同源校验）——对远程服务器执行
  命令的接口不会暴露给局域网。
- Windows 上密码 / 密钥口令使用当前用户 DPAPI 加密后保存在 `~/.dsh/dsh-ssh.json`；
  其他平台仍使用权限 0600、目录 0700 的用户私有文件。
- 首次连接必须在主机列表中读取并确认服务器 SHA-256 Host Key；后续指纹变化会拒绝连接。
- 隧道只监听 `127.0.0.1`。
- Agent 使用工具前，主机需先在 GUI 中配置（或从 ~/.ssh/config 导入）。
- `ssh_upload` / `ssh_download` 以宿主进程权限直接读写本机任意路径（不经 bash
  沙箱）。Agent 侧要求绝对路径、默认拒绝覆盖，并通过 DSH 官方 approval seam 请求一次性确认；
  仍需在确认卡中核对路径。
- Agent 的 exec / cluster 输出会移除 ANSI、OSC 和其他控制符，按高置信规则遮盖环境变量
  secret、Authorization、URI userinfo、SSH_CONNECTION/SSH_CLIENT 等，并按字节上限截断；
  这不是通用 DLP，业务正文中的任意敏感数据仍需调用者避免输出。Web PTY 终端保持原始字节流。
- `ssh_exec`、`ssh_cluster`、传输、隧道变更和 Host Key trust 通过官方
  `tools/pre-execute -> approval` 一次性确认；`dryRun=true` 只生成计划，不连接服务器。
- DSH Web 的 `Full access` 预设对应 `approval=never`，因此需要确认的 SSH 操作会直接
  fail-close；需要真实操作时切换到会显示“允许一次 / 拒绝”的 `Workspace Write` 预设。
- `ssh_exec` 的 Agent 返回值为完整 JSON：无错误/非预览时也固定返回
  `error: null`、`dryRun: false`、`preview: null`，避免 Code Mode 因 `undefined` 判失败后诱发重试。
- `ssh_list` 明确区分 `auth`、`credentialReady`、仅密钥认证存在的 `keyReady`，并显示
  `secretProtection`、`hostKeyPinned`、`nodeId` 与同 endpoint alias 列表。

## 安装

当前硬化版尚未发布到 npm，使用官方 `link:` 插件机制安装：

```sh
git clone https://github.com/dd2673/dsh-web-ui.git
cd dsh-web-ui
pnpm install && pnpm -r build
dsh plugin --profile <独立测试 profile> add link:$(pwd)/packages/dsh-ssh

```

安装后**重启 `dsh web`**：侧边栏出现「SSH」入口；Agent 提示词中自动出现插件说明。

## 配置

设置面板（插件配置）可开关 `announceToAgent`（是否向 Agent 宣告插件）与
`enabled`（总开关）。

## 数据

- 主机配置：`~/.dsh/dsh-ssh.json`（版本化 JSON，原子写入）
- 传输暂存：`os.tmpdir()/dsh-ssh-uploads/`

## 开发

```sh
pnpm install --filter dsh-wending-ssh-manager...
pnpm --filter dsh-wending-ssh-manager test
pnpm --filter dsh-wending-ssh-manager build
```

## 已知限制

- 上传的远程目标路径必须是绝对路径（相对路径会被拒绝）。
- 已开始执行的命令断线后不会自动重放；用户可在确认远端状态后手动重试。
- 跳板机 ProxyJump 的每一跳必须是本插件已配置的主机别名。
- 断点续传（resume）暂未实现。
- Agent 工具的传输为宿主机器本地路径（与 ssh-skill 相同的语义）。
- 高置信输出脱敏不是内容分类器，无法保证识别日志正文中的所有专有敏感格式。
