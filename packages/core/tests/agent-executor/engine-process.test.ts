/** Bounded stdin queue and backpressure behavior of `spawnEngineProcess`. */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnEngineProcess } from '../../src/entrypoints/agent-executor';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

function childScript(pidFile: string, body: string): string[] {
  return [
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${body}`,
  ];
}

async function nextLine(iterator: AsyncIterator<string>): Promise<string> {
  const next = await iterator.next();
  if (next.done) throw new Error('Engine stdout ended unexpectedly');
  return next.value;
}

describe('spawnEngineProcess stdin queue bounds', () => {
  test('validates maxPendingStdinBytes eagerly before spawning', () => {
    const controller = new AbortController();
    try {
      for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          spawnEngineProcess({
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: tmpdir(),
            env: {},
            signal: controller.signal,
            maxPendingStdinBytes: invalid,
          }),
        ).toThrow(TypeError);
      }
    } finally {
      controller.abort();
    }
  });

  test('send() rejects once pending stdin fills on a paused child without unbounded memory growth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-engine-paused-'));
    const pidFile = join(root, 'child.pid');
    trackPidFile(pidFile);
    const controller = new AbortController();
    const maxPendingStdinBytes = 16 * 1024;
    const engine = spawnEngineProcess({
      executable: process.execPath,
      args: childScript(
        pidFile,
        "process.stdin.pause(); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
      ),
      cwd: root,
      env: {},
      signal: controller.signal,
      maxPendingStdinBytes,
    });
    const lines = engine.lines[Symbol.asyncIterator]();
    try {
      expect(await nextLine(lines)).toBe('ready');

      const line = JSON.stringify({ pad: 'a'.repeat(4000) });
      let sent = 0;
      let overflow: unknown;
      for (let i = 0; i < 200; i++) {
        try {
          engine.send(line);
          sent++;
        } catch (error) {
          overflow = error;
          break;
        }
        await Bun.sleep(1);
      }

      expect(overflow).toBeInstanceOf(RangeError);
      expect(sent).toBeLessThan(200);
    } finally {
      await engine.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('send() refuses a chunk larger than the full budget or remaining window without corrupting NDJSON framing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-engine-window-'));
    const pidFile = join(root, 'child.pid');
    trackPidFile(pidFile);
    const controller = new AbortController();
    const maxPendingStdinBytes = 1024;
    const engine = spawnEngineProcess({
      executable: process.execPath,
      args: childScript(
        pidFile,
        `let buf = '';
         process.stdin.setEncoding('utf8');
         process.stdin.on('data', (chunk) => {
           buf += chunk;
           let idx;
           while ((idx = buf.indexOf('\\n')) !== -1) {
             const line = buf.slice(0, idx);
             buf = buf.slice(idx + 1);
             const parsed = JSON.parse(line);
             process.stdout.write(JSON.stringify({ id: parsed.id }) + '\\n');
           }
         });
         process.stdout.write('ready\\n');`,
      ),
      cwd: root,
      env: {},
      signal: controller.signal,
      maxPendingStdinBytes,
    });
    const lines = engine.lines[Symbol.asyncIterator]();
    try {
      expect(await nextLine(lines)).toBe('ready');

      // Prime the pipe so pumpStdin is actively waiting on reader.read().
      engine.send(JSON.stringify({ id: 'prime' }));
      expect(JSON.parse(await nextLine(lines))).toEqual({ id: 'prime' });

      // Single frame larger than maxPendingStdinBytes is refused immediately (including multi-byte UTF-8).
      const tooLargeForBudget = JSON.stringify({ id: 'too-big', pad: 'x'.repeat(1200) });
      expect(() => engine.send(tooLargeForBudget)).toThrow(RangeError);
      const multiByteOverBudget = JSON.stringify({ id: 'utf8', pad: '€'.repeat(400) });
      expect(multiByteOverBudget.length).toBeLessThan(maxPendingStdinBytes);
      expect(() => engine.send(multiByteOverBudget)).toThrow(RangeError);

      // Synchronous burst: two 402-byte frames always fit (804 <= 1024) and leave available
      // strictly > 0 (either 622 or 220 bytes), so a 709-byte frame (< 1024) must be refused
      // specifically because bytes.byteLength > available.
      const medium1 = JSON.stringify({ id: 'm1', pad: 'a'.repeat(380) });
      const medium2 = JSON.stringify({ id: 'm2', pad: 'b'.repeat(380) });
      const largerThanRemaining = JSON.stringify({ id: 'over-window', pad: 'c'.repeat(680) });

      engine.send(medium1);
      engine.send(medium2);
      expect(() => engine.send(largerThanRemaining)).toThrow(RangeError);

      // The rejected write neither closed the session nor tore NDJSON framing:
      // a small frame still fits and every accepted frame arrives intact in order.
      engine.send(JSON.stringify({ id: 'after' }));

      const expectedIds = ['m1', 'm2', 'after'];
      const received: unknown[] = [];
      for (let i = 0; i < expectedIds.length; i++) {
        received.push(JSON.parse(await nextLine(lines)));
      }
      expect(received).toEqual(expectedIds.map((id) => ({ id })));
    } finally {
      await engine.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('negative control: an actively reading child receives more than 2x maxPendingStdinBytes across awaited sends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-engine-drain-'));
    const pidFile = join(root, 'child.pid');
    trackPidFile(pidFile);
    const controller = new AbortController();
    const maxPendingStdinBytes = 16 * 1024;
    const engine = spawnEngineProcess({
      executable: process.execPath,
      args: childScript(
        pidFile,
        `let buf = '';
         process.stdin.setEncoding('utf8');
         process.stdin.resume();
         process.stdin.on('data', (chunk) => {
           buf += chunk;
           let idx;
           while ((idx = buf.indexOf('\\n')) !== -1) {
             const line = buf.slice(0, idx);
             buf = buf.slice(idx + 1);
             const parsed = JSON.parse(line);
             process.stdout.write(JSON.stringify({ seq: parsed.seq, bytes: Buffer.byteLength(line) + 1 }) + '\\n');
           }
         });
         process.stdout.write('ready\\n');`,
      ),
      cwd: root,
      env: {},
      signal: controller.signal,
      maxPendingStdinBytes,
    });
    const lines = engine.lines[Symbol.asyncIterator]();
    try {
      expect(await nextLine(lines)).toBe('ready');

      const payload = 'd'.repeat(4000);
      let totalBytes = 0;
      for (let seq = 0; seq < 12; seq++) {
        const line = JSON.stringify({ seq, payload });
        const expectedBytes = Buffer.byteLength(line) + 1;
        engine.send(line);
        const ack: unknown = JSON.parse(await nextLine(lines));
        expect(ack).toEqual({ seq, bytes: expectedBytes });
        totalBytes += expectedBytes;
      }

      expect(totalBytes).toBeGreaterThan(2 * maxPendingStdinBytes);
    } finally {
      await engine.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('spawnEngineProcess options checked before the spawn', () => {
  test('a maxLineBytes or maxStdinBytes out of range is refused, and no engine is started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-engine-options-'));
    const controller = new AbortController();
    try {
      for (const [option, invalid] of [
        ['maxLineBytes', 0],
        ['maxLineBytes', 1.5],
        ['maxStdinBytes', -1],
        ['maxStdinBytes', Number.NaN],
      ] as const) {
        const pidFile = join(root, `${option}-${String(invalid)}.pid`);
        trackPidFile(pidFile);
        expect(() =>
          spawnEngineProcess({
            executable: process.execPath,
            args: childScript(pidFile, 'setTimeout(() => {}, 60_000);'),
            cwd: root,
            env: {},
            signal: controller.signal,
            [option]: invalid,
          }),
        ).toThrow(TypeError);
        // An engine spawned before the refusal writes its pid well within this wait.
        await Bun.sleep(500);
        expect(existsSync(pidFile), `${option} ${invalid}`).toBe(false);
      }
    } finally {
      controller.abort();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('spawnEngineProcess lifetime stdin budget', () => {
  test('send() refuses a line past maxStdinBytes and the engine keeps running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-engine-budget-'));
    const pidFile = join(root, 'child.pid');
    trackPidFile(pidFile);
    const controller = new AbortController();
    const engine = spawnEngineProcess({
      executable: process.execPath,
      args: childScript(
        pidFile,
        `process.stdin.setEncoding('utf8');
         process.stdin.on('data', (chunk) => process.stdout.write(chunk));
         process.stdout.write('ready\\n');`,
      ),
      cwd: root,
      env: {},
      signal: controller.signal,
      maxStdinBytes: 64,
    });
    const lines = engine.lines[Symbol.asyncIterator]();
    try {
      expect(await nextLine(lines)).toBe('ready');
      const line = 'x'.repeat(39);
      engine.send(line);
      expect(await nextLine(lines)).toBe(line);
      // 40 bytes written, 40 more would pass the connection's 64.
      expect(() => engine.send(line)).toThrow(RangeError);
      engine.send('y'.repeat(23));
      expect(await nextLine(lines)).toBe('y'.repeat(23));
      expect(() => engine.send('')).toThrow(RangeError);
    } finally {
      await engine.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('spawnEngineProcess pid, pidReady and stdoutMode', () => {
  test('exposes leader pid via pidReady, drains large stdout under stdoutMode: drain, and refuses invalid stdoutMode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-engine-drain-mode-'));
    const pidFile = join(root, 'child.pid');
    trackPidFile(pidFile);
    const controller = new AbortController();
    try {
      expect(() =>
        spawnEngineProcess({
          executable: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: root,
          env: {},
          signal: controller.signal,
          // Intentionally pass an invalid mode at runtime to prove eager TypeError refusal.
          stdoutMode: JSON.parse('"invalid"'),
        }),
      ).toThrow(TypeError);

      // Large stdout (>1.5 MiB) under stdoutMode: 'drain' completes cleanly without pipe stall,
      // and pidReady resolves to the real child PID.
      const engine = spawnEngineProcess({
        executable: process.execPath,
        args: childScript(
          pidFile,
          'process.stdout.write("x".repeat(1_500_000)); process.exit(0);',
        ),
        cwd: root,
        env: {},
        signal: controller.signal,
        stdoutMode: 'drain',
      });
      const pid = await engine.pidReady;
      expect(pid).toBeNumber();
      expect(pid).toBeGreaterThan(0);
      expect(engine.pid).toBe(pid);
      const result = await engine.result;
      expect(result.exitCode).toBe(0);

      // Failed startup (missing executable) still settles pidReady without hanging.
      const missing = spawnEngineProcess({
        executable: join(root, 'definitely-missing-binary'),
        args: [],
        cwd: root,
        env: {},
        signal: controller.signal,
      });
      const missingPid = await missing.pidReady;
      expect(missingPid).toBeUndefined();
      await expect(missing.result).rejects.toThrow();
    } finally {
      controller.abort();
      await rm(root, { recursive: true, force: true });
    }
  });
});
