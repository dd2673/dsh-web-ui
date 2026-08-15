# DSH Remote Relay

[English](README.md) | 中文

DSH Remote Relay 是可选的社区自托管组件，用于在一个 DeepSeek Harness host 与已配对 Android 设备之间中继通信。它不是 DeepSeek 官方托管服务，运维方需自行提供反向代理、域名和凭据。

## 能力

- 在一个 host 和已配对设备客户端之间中继版本化 WebSocket 协议。
- 将受限的 host、设备、凭据哈希和审计元数据保存到本地 JSON 状态文件。
- 提供健康检查端点，以及供兼容外部 agent 使用的已认证 lifecycle 轮询端点。

## 安装

使用 Node.js 20 或更高版本并启用 pnpm，在本 monorepo checkout 中运行 relay。

```sh
pnpm install
pnpm --filter @linxin666/dsh-relay-server build
```

## 配置

在 relay 进程环境中设置以下变量。三个凭据值都是部署机密，不得从本文档复制，也不得提交到源代码管理。

| 变量 | 必填 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `DSH_RELAY_HOST_ID` | 是 | 无 | Host 标识，长度为 3 至 128 个字符。 |
| `DSH_RELAY_HOST_TOKEN` | 是 | 无 | Host 连接的 bearer 凭据，至少 24 个字符。 |
| `DSH_RELAY_AGENT_TOKEN` | 是 | 无 | 为 lifecycle-agent 端点预留的 bearer 凭据，至少 24 个字符。 |
| `DSH_RELAY_LISTEN_HOST` | 否 | `127.0.0.1` | 本地 HTTP 和 WebSocket 监听地址。 |
| `DSH_RELAY_PORT` | 否 | `3090` | 本地 HTTP 和 WebSocket 监听端口。 |
| `DSH_RELAY_DB` | 否 | `./data/relay-state.json` | JSON 状态文件路径。 |

## 安全模型

- 在反向代理处终止 TLS，并让 relay 继续绑定 loopback。不得将 relay 的明文 HTTP 监听器直接暴露到互联网。
- Relay 在保存前以 SHA-256 哈希 host 和 agent 凭据。设备配对凭据和交换后的设备凭据均以哈希形式保存，不保存明文 token。
- 配对凭据会绑定首个设备身份。轮换或撤销该凭据会断开当前设备，并使其旧 token 失效。
- 公开 HTTP 面仅包含 `/healthz` 和独立认证的 lifecycle-agent 端点。WebSocket 对等端先完成认证，才中继版本化消息。
- 状态文件只保存受限的连接元数据和审计结果，不保存聊天正文、命令输出、仓库数据或远程凭据。

## 运行

通过进程管理器或 secret store 提供真实部署值，然后启动该包。仓库提供 `ecosystem.config.cjs` 作为 PM2 进程定义，其中只包含 loopback 默认值。

```sh
pnpm --filter @linxin666/dsh-relay-server start
```

## 已知限制

- 此组件不提供托管 relay、生产域名、TLS 证书或部署机密。
- 因为 relay 有意默认仅监听 loopback，远程访问需要反向代理。
- 当前配置即使未使用 lifecycle agent 也要求 `DSH_RELAY_AGENT_TOKEN`，因此应为它预留独立 secret。
- 兼容 lifecycle agent 使用已记录的轮询协议，但不随本发布切片提供。
