const path = require('node:path');
const { config } = require('dotenv');
const identity = require('./app.config.json');

config({ path: path.join(__dirname, '.env'), quiet: true });

const frontendArgs = ['dev', '--port', process.env.WEB_PORT, '--hostname', '0.0.0.0'];

module.exports = {
  apps: [
    {
      name: `${identity.slug}-backend-dev`,
      cwd: path.join(__dirname, 'packages/backend'),
      script: 'src/index.ts',
      interpreter: 'bun',
      interpreter_args: '--watch',
      autorestart: true,
      kill_timeout: 10000,
      env: { NODE_ENV: 'development' },
    },
    {
      name: `${identity.slug}-frontend-dev`,
      cwd: path.join(__dirname, 'packages/frontend'),
      script: 'node_modules/.bin/next',
      args: frontendArgs,
      interpreter: 'bun',
      autorestart: true,
      kill_timeout: 10000,
      env: { NODE_ENV: 'development' },
    },
  ],
};
