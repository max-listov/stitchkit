import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { waitForPublication } from '../src/tools/cli/publication-control';

for (const mode of ['pointer', 'admission']) {
  test(`caller cancellation at the native ${mode} close refuses safely and allows recovery`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'fixtures/cli-publication-cancellation.ts'),
        mode,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    const controls = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(controls).toEqual(
      [false, true].map((cancel) => ({
        mode,
        cancel,
        boundary: true,
        unhandled: 0,
        passed: true,
      })),
    );
  }, 10_000);
}

test('an already-aborted publication wait still observes rejection and cancels a late stream', async () => {
  const reason = new Error('stop before waiting');
  const signal = AbortSignal.abort(reason);
  const operation = Promise.withResolvers<ReadableStream<Uint8Array>>();
  const pending = waitForPublication(operation.promise, signal);
  await expect(pending).rejects.toBe(reason);
  let cancelled: unknown;
  operation.resolve(
    new ReadableStream({
      cancel(value) {
        cancelled = value;
      },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(cancelled).toBe(reason);
  await expect(
    waitForPublication(Promise.reject(new Error('late callback refusal')), signal),
  ).rejects.toBe(reason);
});
