/**
 * The agent template against this checkout's framework.
 *
 * The template links `stitchkit` to `packages/core`, so it is a HEAD lane: it
 * proves the template compiles and runs against the framework being released.
 * The generated-templates lane proves the same source against the version the
 * starter catalog names on the registry. A hard-cut core minor can make those
 * two disagree, and one source cannot satisfy both; the same exact-version
 * deferred review that skips `starter-head-lane` then skips this lane, and the
 * starter migrates in a later train (ADR 0099). Without that record it runs.
 */
import { join, resolve } from 'node:path';
import { starterHeadDecision } from './release-starter-head';

const root = resolve(import.meta.dir, '..');

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} failed with exit code ${code}`);
}

if ((await starterHeadDecision(root)) === 'skip') {
  console.log(
    '[agent-template-lane] skipped: scripts/starter-head-review.json defers the template for this core version',
  );
} else {
  const template = join(root, 'packages/create-stitchkit/templates/agent');
  await run(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], template);
  await run(['bun', 'run', 'check'], template);
  await run(['bun', 'test'], template);
  await run(['bun', 'run', 'build'], template);
}
