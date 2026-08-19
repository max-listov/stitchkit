import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

describe('createCli default stdout', () => {
  test('a payload beyond the 64 KB pipe buffer survives process.exit untruncated', async () => {
    const size = 200_000;
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, 'fixtures/cli-big-output.ts'),
        'blob',
        '--json',
      ],
      env: { ...process.env, STITCHKIT_TEST_PAYLOAD_SIZE: String(size) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(child.stdout).text();
    const code = await child.exited;

    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(size); // JSON envelope around the data
    const parsed: unknown = JSON.parse(out);
    expect(
      typeof parsed === 'object' && parsed !== null && 'data' in parsed
        ? String(parsed.data).length
        : -1,
    ).toBe(size);
  });
});
