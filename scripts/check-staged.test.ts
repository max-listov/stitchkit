import { expect, test } from 'bun:test';

test('the staged-path hook checks root and nested template Biome projects', async () => {
  const child = Bun.spawn(['bun', 'scripts/check-staged.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    'scripts/check-staged.ts\0packages/create-stitchkit/template/package.json\0' +
      'packages/create-stitchkit/templates/agent/src/runtime.ts\0' +
      'packages/create-stitchkit/templates/telegram-bot/package.json\0',
  );
  child.stdin.end();

  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(stderr).not.toContain('No files were processed');
  expect(exitCode).toBe(0);
});

test('the staged-path hook skips files explicitly ignored by a template biome.json and still refuses missing paths', async () => {
  const run = async (stdin: string) => {
    const child = Bun.spawn(['bun', 'scripts/check-staged.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.write(stdin);
    child.stdin.end();
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr };
  };

  const ignored = await run('packages/create-stitchkit/templates/telegram-bot/project.json\0');
  expect(ignored.stderr).not.toContain('No files were processed');
  expect(ignored.exitCode).toBe(0);

  const missing = await run('scripts/does-not-exist-staged.ts\0');
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr).toContain('Staged path missing from tree');
});
