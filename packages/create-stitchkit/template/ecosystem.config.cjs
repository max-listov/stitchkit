const path = require('node:path');
const { config } = require('dotenv');

config({ path: path.join(__dirname, '.env'), quiet: true, override: true });

module.exports = {
  apps: [
    {
      name: 'stitchkit-starter-backend',
      cwd: path.join(__dirname, 'packages/backend'),
      script: 'dist/index.js',
      interpreter: 'bun',
      autorestart: true,
      kill_timeout: 15000,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'stitchkit-starter-frontend',
      cwd: path.join(__dirname, 'packages/frontend'),
      script: 'node_modules/.bin/next',
      args: ['start', '--port', process.env.WEB_PORT, '--hostname', '0.0.0.0'],
      interpreter: 'bun',
      autorestart: true,
      kill_timeout: 15000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
