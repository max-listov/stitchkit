import { env } from '../src/env';

/**
 * Run the web role.
 *
 * Next takes its port and interface as command-line arguments; the ROLE builds
 * that argv from its own bindings, so a deployment only ever has to set
 * variables. That is the whole contract of the declaration: one injection form,
 * named by the role, and no supervisor guessing how a process wants its port.
 *
 * There is no fallback port here on purpose. A default in the repository is a
 * value of the place living in the code, and a forgotten variable would start
 * the role on the wrong port in silence instead of failing by name — the
 * environment schema in `@app/config` is the one place a default may live, and
 * `WEB_PORT` deliberately has none.
 */
/**
 * The run mode, fail-closed.
 *
 * `argv[2] === 'development' ? 'dev' : 'start'` meant a typo, an empty string
 * and a missing argument all silently became production. A wrong mode is not a
 * detail — it decides whether the role serves a build or compiles on demand —
 * and the supervision files pass it explicitly, so anything else is a mistake
 * worth seeing.
 */
const MODES: Record<string, 'dev' | 'start'> = {
  development: 'dev',
  production: 'start',
};

const requested = process.argv[2];
const mode = requested === undefined ? undefined : MODES[requested];
if (mode === undefined) {
  throw new Error(
    `Run mode must be "development" or "production", received ${requested === undefined ? 'nothing' : `"${requested}"`}. The supervision files pass it explicitly; run \`bun run gen:declaration\` if they have fallen behind.`,
  );
}
const next = new URL('../node_modules/.bin/next', import.meta.url).pathname;

const child = Bun.spawn(
  [next, mode, '--port', String(env.WEB_PORT), '--hostname', env.BIND_HOST],
  { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
);

// Forward the shutdown signal rather than dying and orphaning the server: the
// supervisor's kill timeout is measured against the role, not against this
// three-line wrapper.
let stopping = false;

function forward(signal: 'SIGINT' | 'SIGTERM'): void {
  stopping = true;
  child.kill(signal);
}

process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

const code = await child.exited;
/**
 * A stop that was ASKED for is a success — but only for the codes a stop
 * actually produces.
 *
 * `stopping ? 0 : code` reported success for ANY exit during shutdown, so a
 * role that crashed while draining looked identical to one that drained. Next
 * exits 130 on SIGINT and 143 on SIGTERM, and reporting those upward would make
 * every ordinary supervised stop look like a failure; anything else during a
 * shutdown is a real failure and keeps its code.
 */
const SIGNAL_EXIT_CODES = new Set([0, 130, 143]);
process.exitCode = stopping && SIGNAL_EXIT_CODES.has(code) ? 0 : code;
