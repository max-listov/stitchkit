/**
 * Guard: the built package must still read the environment at **run** time.
 *
 * A bundler folds a literal `process.env.NODE_ENV` into its value — and for a
 * library that happens during *our* build, so the result is frozen for every
 * consumer no matter what they run under. The symptom is invisible in source
 * and invisible in tests (which run from source): only the published artifact
 * carries `var isProd = false`, and the whole structured-log path becomes
 * unreachable for everyone.
 *
 * Detection is mechanical: if the read survived, the string `NODE_ENV` is still
 * in the bundle. If it got folded, the string is gone. So scan the built dist
 * and require it. Reach the environment through a variable
 * (`const env = process.env; env.NODE_ENV`) — a plain `process.env.NODE_ENV` is
 * folded even inside a function body.
 */
import { readdirSync, readFileSync } from 'node:fs';

const DIST = new URL('../dist/', import.meta.url);

const files = readdirSync(DIST, { recursive: true }).filter(
  (name) => typeof name === 'string' && name.endsWith('.js'),
);

const found = files.some((name) =>
  readFileSync(new URL(name, DIST), 'utf8').includes('NODE_ENV'),
);

if (!found) {
  console.error(
    '[check-env-live] no `NODE_ENV` read survives in dist — the bundler folded it into a\n' +
      'literal at build time, freezing the log format for every consumer.\n' +
      'Read it through a variable: `const env = process.env; env.NODE_ENV`.',
  );
  process.exit(1);
}
console.log('[check-env-live] the environment is read at run time');
