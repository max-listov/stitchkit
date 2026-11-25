/**
 * A URL that answers an error status is refused without keeping its body.
 *
 * `resolveMedia` refuses a status that is not 2xx with `VIEW_HTTP_ERROR`. The body
 * of that answer is cancelled before the refusal, as a video or an oversized
 * answer is, so the connection of the pinned transport is released at once
 * instead of when the response is collected.
 */
import { expect, test } from 'bun:test';
import { resolveMedia } from '../src/entrypoints/tools';

test('an error status cancels the body it came with', async () => {
  let cancelled = false;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024));
            // Never closes: only a cancelled body ends it.
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500, headers: { 'content-type': 'image/png' } },
      ),
  });
  try {
    await expect(
      resolveMedia(`http://127.0.0.1:${server.port}/broken.png`, { allowPrivateHosts: true }),
    ).rejects.toMatchObject({ code: 'VIEW_HTTP_ERROR' });
    const deadline = performance.now() + 1_000;
    while (!cancelled && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cancelled).toBe(true);
  } finally {
    server.stop(true);
  }
});
