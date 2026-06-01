module.exports = {
  apps: [
    {
      name: 'ratan-backend',
      cwd: './backend',
      script: 'src/server.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
      autorestart: true,
      // A crash that recurs within 10s (e.g. port already in use) is treated as
      // unstable: PM2 backs off exponentially and stops after max_restarts
      // instead of spawning processes forever (the "many windows" storm).
      min_uptime: '10s',
      max_restarts: 8,
      exp_backoff_restart_delay: 500,
      log_file: './logs/backend.log',
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      time: true,
    },
    {
      name: 'ratan-frontend',
      cwd: './frontend',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 4500',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 8,
      exp_backoff_restart_delay: 500,
      log_file: './logs/frontend.log',
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      time: true,
    },
  ],
};
