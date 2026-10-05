import { expect, test } from 'bun:test';
import {
  NativeCommandError,
  type NativeCommandOptions,
  runNativeCommand,
} from '../src/entrypoints/process';

async function failure(input: NativeCommandOptions): Promise<NativeCommandError> {
  try {
    await runNativeCommand(input);
  } catch (error) {
    if (!(error instanceof NativeCommandError)) throw error;
    return error;
  }
  throw new Error('Expected a native command failure');
}

const command = (script: string) => ({ executable: process.execPath, args: ['-e', script] });

test('native deadline and combined binary overflow classify independently of identical messages', async () => {
  const deadline = await failure({
    ...command('setInterval(()=>{},1000)'),
    timeoutMs: 20,
    stop: { target: 'group', graceMs: 0 },
  });
  const budget = await failure({
    ...command(
      'process.stdout.write(Buffer.from([255,0,97]));process.stderr.write(Buffer.from([98]));',
    ),
    timeoutMs: 2000,
    capture: true,
    maxOutputBytes: 3,
    stop: { target: 'group', graceMs: 0 },
  });
  deadline.message = budget.message = 'same wording';
  expect(deadline).toMatchObject({ code: 'COMMAND_LIMIT', reason: 'deadline' });
  expect(budget).toMatchObject({ code: 'COMMAND_LIMIT', reason: 'output-budget' });
  expect(deadline.message).toBe(budget.message);
  const exact = await runNativeCommand({
    ...command(
      'process.stdout.write(Buffer.from([255,0,97]));process.stderr.write(Buffer.from([98]));',
    ),
    timeoutMs: 2000,
    capture: true,
    maxOutputBytes: 4,
  });
  expect([...exact.stdout]).toEqual([255, 0, 97]);
  expect([...exact.stderr]).toEqual([98]);
});

test('caller abort and output sink errors retain identity even with deadline wording', async () => {
  const caller = new Error('Command deadline exceeded');
  const controller = new AbortController();
  const pending = runNativeCommand({
    ...command("process.stdout.write('ready');setInterval(()=>{},1000)"),
    signal: controller.signal,
    stop: { target: 'group', graceMs: 0 },
    onOutput: () => controller.abort(caller),
  });
  await expect(pending).rejects.toBe(caller);
  const sink = new Error('Command output budget exceeded');
  await expect(
    runNativeCommand({
      ...command("process.stdout.write('ready');setInterval(()=>{},1000)"),
      timeoutMs: 2000,
      stop: { target: 'group', graceMs: 0 },
      onOutput: () => {
        throw sink;
      },
    }),
  ).rejects.toBe(sink);
});

test('native unavailability has its syscall cause and no limit reason', async () => {
  const error = await failure({
    executable: '/nonexistent-stitchkit-command',
    timeoutMs: 2000,
  });
  expect(error.code).toBe('COMMAND_UNAVAILABLE');
  expect(error.reason).toBeUndefined();
  expect(error.cause).toMatchObject({ code: 'ENOENT' });
});

test('command error constructor preserves existing calls and validates supplied limit evidence', () => {
  const cause = new Error('observed cause');
  for (const code of [
    'COMMAND_LIMIT',
    'COMMAND_UNAVAILABLE',
    'COMMAND_CLEANUP',
  ] satisfies NativeCommandError['code'][]) {
    const error = new NativeCommandError(code, 'caller wording', { cause });
    expect(error.code).toBe(code);
    expect(error.cause).toBe(cause);
    expect(error.reason).toBeUndefined();
  }
  const limit = new NativeCommandError('COMMAND_LIMIT', 'caller wording', {
    cause,
    reason: 'deadline',
  });
  expect(limit.cause).toBe(cause);
  expect(limit.reason).toBe('deadline');
  expect(() =>
    Reflect.construct(NativeCommandError, [
      'COMMAND_LIMIT',
      'bad evidence',
      { reason: 'unknown' },
    ]),
  ).toThrow();
  expect(() =>
    Reflect.construct(NativeCommandError, [
      'COMMAND_CLEANUP',
      'bad evidence',
      { reason: 'deadline' },
    ]),
  ).toThrow('Only COMMAND_LIMIT');
});

test('cleanup aggregate and exactly-once settlement preserve the initial structured deadline', async () => {
  const cleanupCause = new Error('external cleanup failed');
  let calls = 0;
  let eventCause: unknown;
  const error = await failure({
    ...command('setInterval(()=>{},1000)'),
    timeoutMs: 20,
    stop: { target: 'group', graceMs: 0 },
    onLeaderSettled: (event) => {
      calls++;
      expect(event.kind).toBe('error');
      if (event.kind === 'error') eventCause = event.cause;
      throw cleanupCause;
    },
  });
  expect(error.code).toBe('COMMAND_CLEANUP');
  expect(error.reason).toBeUndefined();
  expect(error.cause).toBeInstanceOf(AggregateError);
  if (!(error.cause instanceof AggregateError)) throw error;
  const initial = error.cause.errors[0];
  expect(initial).toBe(eventCause);
  expect(initial).toMatchObject({ code: 'COMMAND_LIMIT', reason: 'deadline' });
  expect(error.cause.errors[1]).toMatchObject({
    code: 'COMMAND_CLEANUP',
    cause: { errors: [{ kind: 'error', cause: initial }, cleanupCause] },
  });
  expect(calls).toBe(1);
});
