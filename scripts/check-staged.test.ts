import { expect, test } from 'bun:test';

test('the staged-path hook checks root and nested template Biome projects', async () => {
  const child = Bun.spawn(['bun', 'scripts/check-staged.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    'scripts/check-staged.ts\0packages/create-stitchkit/template/package.json\0',
  );
  child.stdin.end();

  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(stderr).not.toContain('No files were processed');
  expect(exitCode).toBe(0);
});
