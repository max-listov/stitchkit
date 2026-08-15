import { expect, test } from 'bun:test';
import { z } from 'zod';

const ResultSchema = z.object({
  outcome: z.literal('clean'),
  pendingRequests: z.literal(0),
  pendingWebSockets: z.literal(0),
  signalCount: z.literal(1),
});

test('Bun subprocess handles real SIGTERM and exits naturally after managed shutdown', async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, 'tests/fixtures/bun-shutdown-signal.ts'],
    cwd: import.meta.dir.replace(/\/tests$/, ''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    while (!output.includes('READY\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Bun shutdown fixture exited before readiness');
      output += decoder.decode(chunk.value);
    }
    child.kill('SIGTERM');
    while (!output.includes('RESULT ')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value);
    }
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
    const resultLine = output.split('\n').find((line) => line.startsWith('RESULT '));
    expect(resultLine).toBeDefined();
    const result = ResultSchema.parse(JSON.parse(resultLine?.slice('RESULT '.length) ?? ''));
    expect(result).toMatchObject({
      outcome: 'clean',
      pendingRequests: 0,
      pendingWebSockets: 0,
      signalCount: 1,
    });
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill('SIGKILL');
    reader.releaseLock();
  }
});
