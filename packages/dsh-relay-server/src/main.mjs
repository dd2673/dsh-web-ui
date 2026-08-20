import { createRelayServer } from './server.mjs'

const relay = createRelayServer({
  hostId: process.env.DSH_RELAY_HOST_ID,
  hostToken: process.env.DSH_RELAY_HOST_TOKEN,
  agentToken: process.env.DSH_RELAY_AGENT_TOKEN,
  listenHost: process.env.DSH_RELAY_LISTEN_HOST ?? '127.0.0.1',
  port: Number(process.env.DSH_RELAY_PORT ?? '3090'),
  databasePath: process.env.DSH_RELAY_DB ?? './data/relay-state.json',
})

await relay.listen()
console.log('dsh-relay-server listening')

const stop = async () => {
  await relay.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
