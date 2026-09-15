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

  test('a SLOW reader on a non-blocking pipe still receives every byte', async () => {
    // The second truncation, and the one the first fix hid. Once anything has
    // touched `process.stdout` the descriptor is non-blocking, and `writeSync`
    // into a pipe whose reader has not started yet writes only what the 64 KB
    // buffer takes, returns that count and throws nothing. Ignoring the count
    // lost the tail at exactly 65536 bytes with exit code 0 — indistinguishable
    // from the bug the sync writer was introduced to fix.
    //
    // `sleep 1` is the subject, not scaffolding: an eager reader drains the
    // pipe as fast as it fills and no short write ever happens, which is why
    // the test above stayed green through the whole defect.
    const size = 200_000;
    const child = Bun.spawn({
      cmd: [
        'sh',
        '-c',
        '"$0" "$1" blob --json | (sleep 1; cat)',
        process.execPath,
        join(import.meta.dir, 'fixtures/cli-big-output.ts'),
      ],
      env: {
        ...process.env,
        STITCHKIT_TEST_PAYLOAD_SIZE: String(size),
        STITCHKIT_TEST_NONBLOCKING_STDOUT: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(child.stdout).text();
    await child.exited;

    // Byte length, before parsing: a truncated payload is still valid-looking
    // text, and `JSON.parse` would report a column number rather than the fact
    // that output was lost.
    expect(Buffer.byteLength(out, 'utf8')).toBeGreaterThan(size);
    const parsed: unknown = JSON.parse(out);
    expect(
      typeof parsed === 'object' && parsed !== null && 'data' in parsed
        ? String(parsed.data).length
        : -1,
    ).toBe(size);
  });
});
