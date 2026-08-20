module.exports = {
  apps: [{
    name: 'dsh-remote-relay',
    script: './src/main.mjs',
    cwd: __dirname,
    interpreter: 'node',
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    env: {
      NODE_ENV: 'production',
      DSH_RELAY_LISTEN_HOST: '127.0.0.1',
      DSH_RELAY_PORT: '3090',
      DSH_RELAY_DB: './data/relay-state.json',
    },
  }],
}
