const path = require('node:path');
const { config } = require('dotenv');

config({ path: path.join(__dirname, '.env'), quiet: true, override: true });

module.exports = {
  apps: [
    {
      name: 'stitchkit-starter-backend-dev',
      cwd: path.join(__dirname, 'packages/backend'),
      script: 'src/index.ts',
      interpreter: 'bun',
      interpreter_args: '--watch',
      autorestart: true,
      kill_timeout: 10000,
      env: { NODE_ENV: 'development' },
    },
    {
      name: 'stitchkit-starter-frontend-dev',
      cwd: path.join(__dirname, 'packages/frontend'),
      script: 'node_modules/.bin/next',
      args: ['dev', '--port', process.env.WEB_PORT, '--hostname', '0.0.0.0'],
      interpreter: 'bun',
      autorestart: true,
      kill_timeout: 10000,
      env: { NODE_ENV: 'development' },
    },
  ],
};
