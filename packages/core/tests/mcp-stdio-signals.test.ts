import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('a real SIGTERM closes stdio, preserves stdout and exits naturally', async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, 'fixtures/mcp-stdio-signal-server.ts')],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let stderr = '';
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    while (!stderr.includes('READY\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('stdio signal fixture exited before readiness');
      stderr += decoder.decode(chunk.value, { stream: true });
    }
    child.kill('SIGTERM');
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stderr += decoder.decode(chunk.value, { stream: true });
    }
    stderr += decoder.decode();
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stderr).toContain('READY\n');
    expect(stderr).toContain('CLOSED\n');
    expect(stderr).not.toContain('ERROR ');
    expect(stdout).toBe('');
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill('SIGKILL');
    reader.releaseLock();
  }
});
