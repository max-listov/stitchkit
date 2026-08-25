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
 * Detection is mechanical: if the read survived, the READ is still in the
 * bundle. If it got folded, it is gone. So scan the built dist and require it.
 * Reach the environment through a variable (`const env = process.env;
 * env.NODE_ENV`) — a plain `process.env.NODE_ENV` is folded even inside a
 * function body.
 *
 * It looks for the comparison, not for the bare string `NODE_ENV`. The string
 * appears in comments, in type unions, in any list of known variable names — so
 * a substring scan holds only while exactly one occurrence exists, and goes
 * permanently green the day a second one arrives for an unrelated reason. That
 * is a gate that stops gating without anyone noticing, on the one property no
 * test can see: tests run from source, and the folding happens in the build.
 */
import { readdirSync, readFileSync } from 'node:fs';

const DIST = new URL('../dist/', import.meta.url);

/** The surviving read, as the bundler leaves it: `<something>.NODE_ENV ===`. */
const LIVE_READ = /[\w$]+\.NODE_ENV\s*===/;

const files = readdirSync(DIST, { recursive: true }).filter(
  (name) => typeof name === 'string' && name.endsWith('.js'),
);

const carrying = files.filter((name) =>
  LIVE_READ.test(readFileSync(new URL(name, DIST), 'utf8')),
);

if (carrying.length === 0) {
  console.error(
    '[check-env-live] no live `NODE_ENV` comparison survives in dist — the bundler folded it\n' +
      'into a literal at build time, freezing the log format for every consumer.\n' +
      'Read it through a variable: `const env = process.env; env.NODE_ENV`.',
  );
  process.exit(1);
}
console.log(
  `[check-env-live] the environment is read at run time (${carrying.length} live read${carrying.length === 1 ? '' : 's'})`,
);
