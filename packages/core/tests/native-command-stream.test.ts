import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeCommandError, streamNativeCommand } from '../src/entrypoints/process';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';
import { processAlive } from './support/process-state';
import { until } from './support/until';

const LEADER = fileURLToPath(
  new URL('./fixtures/native-cooperative-leader.mjs', import.meta.url),
);

let dir: string;
reapAfterEachTest();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stitchkit-command-stream-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const text = new TextDecoder();

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.byteLength;
  return bytes;
}

describe('streamNativeCommand', () => {
  test('hands output over while the command still runs', async () => {
    const command = streamNativeCommand({
      executable: process.execPath,
      args: [
        '-e',
        "process.stdout.write('first'); setTimeout(() => process.stdout.write('second'), 400)",
      ],
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    const reader = command.stdout.getReader();
    const first = await reader.read();
    expect(text.decode(first.value)).toBe('first');
    expect(
      await Promise.race([
        command.result.then(() => 'settled'),
        Bun.sleep(100).then(() => 'pending'),
      ]),
    ).toBe('pending');
    const rest = await reader.read();
    expect(text.decode(rest.value)).toBe('second');
    expect((await reader.read()).done).toBe(true);
    expect((await command.result).exitCode).toBe(0);
    expect(await drain(command.stderr)).toBe(0);
  });

  test('stop() ends the leader and every member of its group', async () => {
    const command = streamNativeCommand({
      executable: process.execPath,
      args: [LEADER, dir, 'exit-on-signal'],
      timeoutMs: 20_000,
      stop: { target: 'group', graceMs: 2000 },
      onLeaderStarted: trackGroupLeader,
    });
    const reader = command.stdout.getReader();
    expect(text.decode((await reader.read()).value)).toBe('ready');
    const member = Number(await readFile(join(dir, 'member-pid'), 'utf8'));
    expect(processAlive(member)).toBe(true);
    await command.stop();
    await until(() => !processAlive(member), 'the group member to end');
    await expect(command.result).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a caller abort stops the group and errors the streams with its reason', async () => {
    const controller = new AbortController();
    const command = streamNativeCommand({
      executable: process.execPath,
      args: [LEADER, dir, 'ignore-signal'],
      signal: controller.signal,
      stop: { target: 'group', graceMs: 100 },
      onLeaderStarted: trackGroupLeader,
    });
    const reader = command.stdout.getReader();
    await reader.read();
    const member = Number(await readFile(join(dir, 'member-pid'), 'utf8'));
    const reason = new Error('caller left');
    controller.abort(reason);
    await expect(reader.read()).rejects.toBe(reason);
    await expect(command.result).rejects.toBe(reason);
    expect(processAlive(member)).toBe(false);
  });

  test('stopping a command that already ended resolves and leaves the streams readable', async () => {
    const command = streamNativeCommand({
      executable: process.execPath,
      args: ['-e', 'void 0'],
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    await command.result;
    await command.stop();
    expect(await drain(command.stdout)).toBe(0);
  });

  test('a reader that does not read holds the child back; reading releases it', async () => {
    const total = 16 * 1024 * 1024;
    const command = streamNativeCommand({
      executable: process.execPath,
      args: ['-e', `process.stdout.write(Buffer.alloc(${total}), () => undefined)`],
      timeoutMs: 20_000,
      onLeaderStarted: trackGroupLeader,
    });
    const reader = command.stdout.getReader();
    let read = (await reader.read()).value?.byteLength ?? 0;
    let finished = false;
    void command.result.then(() => {
      finished = true;
    });
    await Bun.sleep(300);
    expect(finished).toBe(false);
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      read += next.value.byteLength;
    }
    expect(read).toBe(total);
    expect((await command.result).exitCode).toBe(0);
  });

  test('past 1 MiB an unread stream holds the command, a cancelled one releases it', async () => {
    const script =
      "process.stderr.write('x'.repeat(4 * 1024 * 1024)); process.stdout.write('done')";
    const held = streamNativeCommand({
      executable: process.execPath,
      args: ['-e', script],
      timeoutMs: 1500,
      onLeaderStarted: trackGroupLeader,
    });
    await drain(held.stdout).catch(() => undefined);
    await expect(held.result).rejects.toMatchObject({ code: 'COMMAND_LIMIT' });
    const released = streamNativeCommand({
      executable: process.execPath,
      args: ['-e', script],
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    void released.stderr.cancel();
    expect(await drain(released.stdout)).toBe(4);
    expect((await released.result).exitCode).toBe(0);
  });

  test('small outputs may be read in any order, and after the result', async () => {
    const command = streamNativeCommand({
      executable: process.execPath,
      args: ['-e', "process.stderr.write('warn'); process.stdout.write('out')"],
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    expect((await command.result).exitCode).toBe(0);
    expect(await drain(command.stdout)).toBe(3);
    expect(await drain(command.stderr)).toBe(4);
  });

  test('a slow reader leaves no abort listener behind per chunk', async () => {
    const live = new Set<unknown>();
    const add = AbortSignal.prototype.addEventListener;
    const remove = AbortSignal.prototype.removeEventListener;
    const adding = spyOn(AbortSignal.prototype, 'addEventListener').mockImplementation(
      function (this: AbortSignal, ...args: Parameters<typeof add>) {
        if (args[0] === 'abort') live.add(args[1]);
        return add.apply(this, args);
      },
    );
    const removing = spyOn(AbortSignal.prototype, 'removeEventListener').mockImplementation(
      function (this: AbortSignal, ...args: Parameters<typeof remove>) {
        if (args[0] === 'abort') live.delete(args[1]);
        return remove.apply(this, args);
      },
    );
    try {
      const command = streamNativeCommand({
        executable: process.execPath,
        args: [
          '-e',
          `process.stdout.write(Buffer.alloc(${24 * 1024 * 1024}), () => undefined)`,
        ],
        timeoutMs: 20_000,
        onLeaderStarted: trackGroupLeader,
      });
      void command.stderr.cancel();
      let peak = 0;
      for await (const _ of command.stdout) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        peak = Math.max(peak, live.size);
      }
      await command.result;
      expect(peak).toBeLessThan(50);
    } finally {
      adding.mockRestore();
      removing.mockRestore();
    }
  });

  test('a cancelled stream drops its bytes and leaves the command running to its end', async () => {
    const command = streamNativeCommand({
      executable: process.execPath,
      args: ['-e', `process.stdout.write(Buffer.alloc(${8 * 1024 * 1024}), () => undefined)`],
      timeoutMs: 20_000,
      onLeaderStarted: trackGroupLeader,
    });
    await command.stdout.cancel();
    expect((await command.result).exitCode).toBe(0);
  });

  test('a failed command errors both streams with its error', async () => {
    const command = streamNativeCommand({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      timeoutMs: 200,
      stop: { target: 'group', graceMs: 100 },
      onLeaderStarted: trackGroupLeader,
    });
    const error = await command.result.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NativeCommandError);
    await expect(command.stdout.getReader().read()).rejects.toBe(error);
    await expect(command.stderr.getReader().read()).rejects.toBe(error);
  });

  test('refuses the options its readers own', () => {
    const base = { executable: process.execPath, timeoutMs: 1000 };
    for (const owned of [{ capture: true }, { onOutput: () => undefined }, { stdio: 'pipe' }])
      expect(() => streamNativeCommand({ ...base, ...owned } as never)).toThrow(
        /streamNativeCommand owns/,
      );
  });
});
