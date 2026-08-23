module.exports = {
  apps: [
    {
      name: 'jic-watcher',
      script: 'server.js',
      cwd: __dirname,

      // Single instance only: the poller keeps its target state and browser
      // in memory, so cluster mode / multiple instances would each run their
      // own independent (and conflicting) poll loop.
      instances: 1,
      exec_mode: 'fork',

      // This has to run unattended for weeks. Headless Chromium can leak
      // memory over that long a stretch, so let pm2 recycle the process if
      // it grows too large, and keep retrying restarts rather than giving up.
      max_memory_restart: '500M',
      autorestart: true,
      max_restarts: 100,
      min_uptime: '30s',
      restart_delay: 5000,

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
