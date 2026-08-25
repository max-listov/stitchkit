import { expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * The web role refuses a mode it does not understand.
 *
 * `argv[2] === 'development' ? 'dev' : 'start'` meant a typo, an empty string
 * and a missing argument all became production in silence — the one decision
 * that changes whether the role serves a build or compiles on demand. Run as a
 * real process, because the failure has to happen before Next is spawned.
 */
const serve = join(import.meta.dir, '../packages/frontend/scripts/serve.ts');

async function refusal(argv: string[]): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn(['bun', serve, ...argv], {
    cwd: join(import.meta.dir, '../packages/frontend'),
    env: { ...Bun.env, WEB_PORT: '3210', BIND_HOST: '127.0.0.1' },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { code, stderr };
}

test('a misspelled mode is refused, not treated as production', async () => {
  const { code, stderr } = await refusal(['produciton']);
  expect(code).not.toBe(0);
  expect(stderr).toContain('Run mode must be "development" or "production"');
  expect(stderr).toContain('produciton');
}, 30_000);

test('a missing mode is refused', async () => {
  const { code, stderr } = await refusal([]);
  expect(code).not.toBe(0);
  expect(stderr).toContain('received nothing');
}, 30_000);
