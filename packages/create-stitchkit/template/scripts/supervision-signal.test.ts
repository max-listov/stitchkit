import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Why the supervision files run each role from its OWN directory.
 *
 * A supervisor that reaches into a workspace from the root — `bun run --filter
 * @app/backend start` — puts a launcher process between itself and the role.
 * `SIGTERM` sent to that launcher does not arrive at the role: the launcher
 * dies and the role is torn down without ever running its shutdown. Every
 * drain, every `kill_timeout`, every grace period is then decoration.
 *
 * This test spawns both shapes and compares what the role actually receives, so
 * the choice in `scripts/declaration.ts` is pinned by behaviour rather than by
 * a comment that a later refactor can talk itself out of.
 */
async function roleReceivesSignal(from: 'role directory' | 'workspace root'): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), 'starter-signal-'));
  try {
    const rolePath = join(root, 'role');
    await Bun.$`mkdir -p ${rolePath}`.quiet();
    await writeFile(
      join(rolePath, 'role.ts'),
      [
        "process.on('SIGTERM', () => { console.log('DRAINED'); process.exit(0); });",
        "console.log('UP');",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    await writeFile(
      join(rolePath, 'package.json'),
      JSON.stringify({ name: '@t/role', scripts: { start: 'bun role.ts' } }),
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['role'] }),
    );

    // `detached` makes the child a process-group LEADER, which is what lets the
    // negative-pid signal below reach the role behind the launcher. The
    // NEGATIVE case is the point: there the role never sees the signal, so
    // killing the launcher alone would leave it running for the life of the
    // machine — this test used to leak one role per run.
    const child =
      from === 'role directory'
        ? Bun.spawn(['bun', 'run', 'start'], {
            cwd: rolePath,
            detached: true,
            stdout: 'pipe',
            stderr: 'ignore',
          })
        : Bun.spawn(['bun', 'run', '--filter', '@t/role', 'start'], {
            cwd: root,
            detached: true,
            stdout: 'pipe',
            stderr: 'ignore',
          });

    const output = new Response(child.stdout).text();
    await Bun.sleep(1500);
    // The role first, exactly as a supervisor would; then the whole group, so
    // nothing that ignored the request outlives the test.
    child.kill('SIGTERM');
    await child.exited;
    const printed = await output;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The group is already gone, which is the outcome this wants.
    }
    // Without this the negative case passes when the spawn simply failed —
    // proving nothing about signal delivery, which is the only thing it exists
    // to prove.
    if (!printed.includes('UP')) {
      throw new Error(`The role never started when launched from the ${from}: ${printed}`);
    }
    return printed.includes('DRAINED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a role started in its own directory receives the shutdown signal', async () => {
  expect(await roleReceivesSignal('role directory')).toBe(true);
}, 20_000);

test('a role started through a workspace filter never receives it', async () => {
  // The reason `cwd` is per role in the generated supervision files. If this
  // ever starts passing, the generator may be simplified — until then it may
  // not.
  expect(await roleReceivesSignal('workspace root')).toBe(false);
}, 20_000);
