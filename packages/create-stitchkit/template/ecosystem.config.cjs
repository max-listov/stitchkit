// GENERATED FILE — do not edit.
//
// Rendered from `project.json` by `scripts/declaration.ts`; run
// `bun run gen:declaration` after changing a role. Roles, commands and the
// drain floor come from the declaration because they are true of the code;
// restart policy and the kill timeout are this machine's, and the generator
// refuses a timeout shorter than any role's full shutdown budget.
const path = require('node:path');
const { config } = require('dotenv');
const declaration = require('./project.json');

// NOT `override`: an environment a deployment injected into this process must
// win over a file in the repository. The file fills gaps; it does not overrule
// the place.
config({ path: path.join(__dirname, '.env'), quiet: true });

module.exports = {
  apps: [
    {
      name: `${declaration.identity.slug}-api`,
      // The role's OWN process, in its OWN directory — no launcher in between.
      // Measured: a launcher makes the role see the stop signal twice (once from
      // the supervisor, once forwarded), the second press forces the shutdown,
      // and a declared drain of seconds collapses to milliseconds. A workspace
      // filter is worse: the signal never arrives at all.
      cwd: path.join(__dirname, "packages/backend"),
      script: "bun",
      // No argv invented here: the deployment injects `API_PORT` and the command
      // reads it. Serialised rather than concatenated — an argument with a space
      // or a quote has to survive this file intact.
      args: ["dist/index.js"],
      interpreter: 'none',
      autorestart: true,
      // >= this role's full shutdown budget of 25000ms.
      kill_timeout: 30000,
      env: { NODE_ENV: 'production' },
    },
    {
      name: `${declaration.identity.slug}-web`,
      // The role's OWN process, in its OWN directory — no launcher in between.
      // Measured: a launcher makes the role see the stop signal twice (once from
      // the supervisor, once forwarded), the second press forces the shutdown,
      // and a declared drain of seconds collapses to milliseconds. A workspace
      // filter is worse: the signal never arrives at all.
      cwd: path.join(__dirname, "packages/frontend"),
      script: "bun",
      // No argv invented here: the deployment injects `WEB_PORT` and the command
      // reads it. Serialised rather than concatenated — an argument with a space
      // or a quote has to survive this file intact.
      args: ["scripts/serve.ts","production"],
      interpreter: 'none',
      autorestart: true,
      // >= this role's full shutdown budget of 15000ms.
      kill_timeout: 30000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
