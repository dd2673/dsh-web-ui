# DSH Remote Relay

English | [中文](README.zh.md)

DSH Remote Relay is an optional self-hosted community component that relays one DeepSeek Harness host and a paired Android device. It is not a DeepSeek official hosted service, and operators provide their own reverse proxy, domain, and credentials.

## What it does

- Relays the versioned WebSocket protocol between one host and paired device clients.
- Keeps bounded host, device, credential-hash, and audit metadata in a local JSON state file.
- Exposes a health endpoint and authenticated lifecycle-agent polling endpoints for compatible external agents.

## Install

Run the relay from a checkout of this monorepo with Node.js 20 or later and pnpm enabled.

```sh
pnpm install
pnpm --filter @linxin666/dsh-relay-server build
```

## Config

Set these variables in the relay process environment. The three credential values are deployment secrets and must not be copied from this document or committed to source control.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DSH_RELAY_HOST_ID` | Yes | None | Host identifier; 3 to 128 characters. |
| `DSH_RELAY_HOST_TOKEN` | Yes | None | Bearer credential for the host connection; at least 24 characters. |
| `DSH_RELAY_AGENT_TOKEN` | Yes | None | Bearer credential reserved for lifecycle-agent endpoints; at least 24 characters. |
| `DSH_RELAY_LISTEN_HOST` | No | `127.0.0.1` | Local HTTP and WebSocket listen address. |
| `DSH_RELAY_PORT` | No | `3090` | Local HTTP and WebSocket listen port. |
| `DSH_RELAY_DB` | No | `./data/relay-state.json` | JSON state-file path. |

## Security model

- Terminate TLS at a reverse proxy and keep the relay bound to loopback. Do not expose the relay's plain HTTP listener directly to the internet.
- The relay hashes the host and agent credentials with SHA-256 before retaining them. Device pairing and exchanged device credentials are stored as hashes rather than clear tokens.
- A pairing credential binds its first device identity. Rotating or revoking that credential disconnects the current device and invalidates its prior token.
- The public HTTP surface is limited to `/healthz` and separately authenticated lifecycle-agent endpoints. WebSocket peers authenticate before relaying versioned messages.
- The state file stores bounded connection metadata and audit outcomes, not chat bodies, command output, repository data, or remote credentials.

## Run

Provide real deployment values through your process manager or secret store, then start the package. The repository includes `ecosystem.config.cjs` as a PM2 process definition with loopback defaults only.

```sh
pnpm --filter @linxin666/dsh-relay-server start
```

## Known limitations

- This component does not provide a hosted relay, production domain, TLS certificate, or deployment secrets.
- A reverse proxy is required for remote access because the relay intentionally defaults to loopback-only listening.
- The current configuration requires `DSH_RELAY_AGENT_TOKEN` even when no lifecycle agent is used, so reserve a distinct secret for it.
- Compatible lifecycle agents use the documented polling protocol but are not included in this publication slice.

Code maintenance and defect reports belong in the [maintainer-owned issue tracker](https://github.com/dd2673/dsh-web-ui/issues/1).
