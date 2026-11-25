import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeCommandError } from '../src/entrypoints/process';
import { createDefaultMacosCommandRunner } from '../src/entrypoints/service-host/macos';
import { reapAfterEachTest } from './support/process-reaper';

reapAfterEachTest();

const AMBIENT_SENTINEL_KEY = 'STITCHKIT_MACOS_RUNNER_AMBIENT_SENTINEL';

describe('service-host/macos createDefaultMacosCommandRunner', () => {
  test('createDefaultMacosCommandRunner honours cwd, stdin, and env, and passes only the declared environment', async () => {
    const runner = createDefaultMacosCommandRunner();
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-macos-runner-'));
    const subdir = join(root, 'child-dir');
    await mkdir(subdir, { recursive: true });
    const prevAmbient = process.env[AMBIENT_SENTINEL_KEY];
    const prevDeveloperDir = process.env.DEVELOPER_DIR;
    process.env[AMBIENT_SENTINEL_KEY] = 'ambient-sentinel-value';
    process.env.DEVELOPER_DIR = '/Applications/Example.app/Contents/Developer';

    try {
      // cwd: child runs inside the specified working directory rather than the caller's cwd
      const cwdResultA = await runner.runCommand(
        process.execPath,
        ['-e', 'process.stdout.write(process.cwd())'],
        { cwd: root, timeoutMs: 10_000 },
      );
      const cwdResultB = await runner.runCommand(
        process.execPath,
        ['-e', 'process.stdout.write(process.cwd())'],
        { cwd: subdir, timeoutMs: 10_000 },
      );
      expect(cwdResultA.exitCode).toBe(0);
      expect(cwdResultB.exitCode).toBe(0);
      expect(await realpath(cwdResultA.stdout)).toBe(await realpath(root));
      expect(await realpath(cwdResultB.stdout)).toBe(await realpath(subdir));
      expect(cwdResultA.stdout).not.toBe(cwdResultB.stdout);

      // stdin: child receives exact bytes written to stdin and echoes them on stdout
      const payload = 'macos-runner-stdin-payload-\u00e9-12345';
      const stdinResult = await runner.runCommand(
        process.execPath,
        [
          '-e',
          'const parts = []; for await (const c of Bun.stdin.stream()) parts.push(c); process.stdout.write(Buffer.concat(parts));',
        ],
        {
          stdin: new TextEncoder().encode(payload),
          timeoutMs: 10_000,
        },
      );
      expect(stdinResult.exitCode).toBe(0);
      expect(stdinResult.stdout).toBe(payload);

      // env: the declared environment only — a fixed PATH, the caller's HOME, TMPDIR and xcrun
      // selectors when set, the call's own env on top; any other ambient key stays out.
      const declaredResult = await runner.runCommand(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
        { env: { STITCHKIT_CUSTOM: 'declared-value' }, timeoutMs: 10_000 },
      );
      expect(declaredResult.exitCode).toBe(0);
      const seen: Record<string, string> = JSON.parse(declaredResult.stdout);
      expect(seen[AMBIENT_SENTINEL_KEY]).toBeUndefined();
      expect(seen).toMatchObject({
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        DEVELOPER_DIR: '/Applications/Example.app/Contents/Developer',
        STITCHKIT_CUSTOM: 'declared-value',
      });
      if (process.env.HOME !== undefined) expect(seen.HOME).toBe(process.env.HOME);
      const allowed = new Set([
        'PATH',
        'HOME',
        'TMPDIR',
        'DEVELOPER_DIR',
        'SDKROOT',
        'TOOLCHAINS',
      ]);
      // Bun itself may add its own keys to a child it starts; none of them is the caller's.
      const leaked = Object.keys(seen).filter(
        (key) =>
          !allowed.has(key) && key !== 'STITCHKIT_CUSTOM' && process.env[key] === seen[key],
      );
      expect(leaked).toEqual([]);
    } finally {
      if (prevAmbient === undefined) delete process.env[AMBIENT_SENTINEL_KEY];
      else process.env[AMBIENT_SENTINEL_KEY] = prevAmbient;
      if (prevDeveloperDir === undefined) delete process.env.DEVELOPER_DIR;
      else process.env.DEVELOPER_DIR = prevDeveloperDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('createDefaultMacosCommandRunner enforces maxOutputBytes and timeoutMs via NativeCommandError COMMAND_LIMIT', async () => {
    const runner = createDefaultMacosCommandRunner();

    // Positive control within maxOutputBytes
    const withinBudget = await runner.runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("a".repeat(32))'],
      { maxOutputBytes: 64, timeoutMs: 10_000 },
    );
    expect(withinBudget.exitCode).toBe(0);
    expect(withinBudget.stdout).toBe('a'.repeat(32));

    // Exceeding maxOutputBytes rejects with NativeCommandError COMMAND_LIMIT (output-budget)
    let outputError: unknown;
    try {
      await runner.runCommand(
        process.execPath,
        ['-e', 'process.stdout.write("x".repeat(4096))'],
        { maxOutputBytes: 64, timeoutMs: 10_000 },
      );
    } catch (error) {
      outputError = error;
    }
    expect(outputError).toBeInstanceOf(NativeCommandError);
    expect(outputError).toMatchObject({ code: 'COMMAND_LIMIT', reason: 'output-budget' });

    // Exceeding timeoutMs on a sleeping child rejects with NativeCommandError COMMAND_LIMIT (deadline)
    let timeoutError: unknown;
    try {
      await runner.runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
        timeoutMs: 150,
      });
    } catch (error) {
      timeoutError = error;
    }
    expect(timeoutError).toBeInstanceOf(NativeCommandError);
    expect(timeoutError).toMatchObject({ code: 'COMMAND_LIMIT', reason: 'deadline' });
  });

  test('createDefaultMacosCommandRunner streams stdout and stderr incrementally via onOutput while returning empty stdout and bounded stderr', async () => {
    const runner = createDefaultMacosCommandRunner();
    const decoder = new TextDecoder();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const events: Array<{ channel: 'stdout' | 'stderr'; text: string }> = [];

    const result = await runner.runCommand(
      process.execPath,
      [
        '-e',
        [
          'process.stdout.write("chunk-1\\n");',
          'process.stderr.write("err-1\\n");',
          'setTimeout(() => {',
          '  process.stdout.write("chunk-2\\n");',
          '  process.stderr.write("err-2\\n");',
          '}, 40);',
        ].join(' '),
      ],
      {
        timeoutMs: 10_000,
        onOutput(chunk, channel) {
          const text = decoder.decode(chunk, { stream: true });
          events.push({ channel, text });
          if (channel === 'stdout') stdoutChunks.push(text);
          else stderrChunks.push(text);
        },
      },
    );

    expect(result.exitCode).toBe(0);
    // Streaming mode never buffers stdout in result.stdout while still capturing bounded stderr
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('err-1\nerr-2\n');
    expect(stdoutChunks.join('')).toBe('chunk-1\nchunk-2\n');
    expect(stderrChunks.join('')).toBe('err-1\nerr-2\n');
    expect(stdoutChunks.length).toBeGreaterThanOrEqual(2);
    expect(events.some((entry) => entry.channel === 'stdout')).toBe(true);
    expect(events.some((entry) => entry.channel === 'stderr')).toBe(true);
  });
});
