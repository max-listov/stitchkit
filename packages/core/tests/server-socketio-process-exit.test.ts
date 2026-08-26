import { expect, test } from 'bun:test';
import { io as ioClient } from 'socket.io-client';
import { z } from 'zod';

const ReadySchema = z.object({ url: z.url() });
const ResultSchema = z.object({
  outcome: z.literal('clean'),
  cleanupComplete: z.literal(true),
  resources: z.array(
    z.object({
      id: z.literal('http'),
      state: z.literal('closed'),
      failures: z.array(z.never()),
    }),
  ),
});

function linePayload(output: string, prefix: string): string | undefined {
  return output
    .split('\n')
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
}

test('a clean managed Socket.IO shutdown lets the Bun process exit naturally', async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, 'tests/fixtures/bun-socketio-clean-shutdown.ts'],
    cwd: import.meta.dir.replace(/\/tests$/, ''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let client: ReturnType<typeof ioClient> | undefined;

  try {
    while (linePayload(output, 'READY ') === undefined) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Socket.IO shutdown fixture exited before readiness');
      output += decoder.decode(chunk.value, { stream: true });
    }
    const ready = ReadySchema.parse(JSON.parse(linePayload(output, 'READY ') ?? ''));
    client = ioClient(ready.url, { transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => {
      client?.once('connect', () => resolve());
      client?.once('connect_error', reject);
    });

    const disconnected = new Promise<void>((resolve) =>
      client?.once('disconnect', () => resolve()),
    );
    child.kill('SIGTERM');

    const completion = (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
      }
      output += decoder.decode();
      return child.exited;
    })();
    const bounded = await Promise.race([
      completion.then((exitCode) => ({ exitCode })),
      Bun.sleep(5_000).then(() => ({ exitCode: undefined })),
    ]);

    if (bounded.exitCode === undefined) {
      child.kill('SIGKILL');
      await completion;
      const diagnostics = await new Response(child.stderr).text();
      throw new Error(
        `Socket.IO shutdown fixture did not exit within 5s after SIGTERM\n${diagnostics}`,
      );
    }

    const diagnostics = await new Response(child.stderr).text();
    expect(bounded.exitCode, diagnostics).toBe(0);
    expect(linePayload(output, 'RESULT '), output).toBeDefined();
    const result = ResultSchema.parse(JSON.parse(linePayload(output, 'RESULT ') ?? ''));
    expect(result).toMatchObject({
      outcome: 'clean',
      cleanupComplete: true,
      resources: [{ id: 'http', state: 'closed', failures: [] }],
    });
    await disconnected;
  } finally {
    client?.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    reader.releaseLock();
  }
});
