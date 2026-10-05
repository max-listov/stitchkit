import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

async function isolated(fixture: string) {
  const program = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
  const child = Bun.spawn([process.execPath, program], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(stderr);
  return stdout;
}

test('a paused stale guard removal blocks competing recovery through a separately owned guard', async () => {
  expect(await isolated('exclusive-lock-paused-guard-recovery.ts')).toContain(
    'serialized guard recovery: ok',
  );
});

test('Darwin transient group EPERM settles only on a real signal or absence; persistent denial stays red', async () => {
  expect(await isolated('process-group-eperm-darwin.ts')).toContain(
    'bounded EPERM controls: ok',
  );
});
