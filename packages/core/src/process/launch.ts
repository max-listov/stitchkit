import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  NativeCommandError,
  type NativeCommandSettlement,
  type ParsedNativeCommandOptions,
} from './contract';

/** A structural host launcher may supply pipes without importing Node ambient types. */
export interface NativeCommandLaunchedProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout: NativeCommandLaunchedOutput;
  readonly stderr: NativeCommandLaunchedOutput;
  kill(signal: 'SIGKILL'): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
}

interface NativeCommandLaunchedOutput {
  readonly destroyed: boolean;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  destroy(): unknown;
}

/** Internal transport selection; application policy never enters the public command contract. */
export interface NativeCommandLaunchDriver {
  launch?: () => NativeCommandLaunchedProcess;
  maxBufferedBytes?: number;
  group?: boolean;
  force?: boolean;
  cleanupTimeoutMs?: number;
  timeoutMs?: number;
  closeTimeoutMs?: number;
}

/** Driver overrides retain the same finite, safe-integer budget admission. */
export function nativeCommandBudgets(
  options: ParsedNativeCommandOptions,
  driver: NativeCommandLaunchDriver | undefined,
) {
  const cleanupTimeoutMs = driver?.cleanupTimeoutMs ?? options.cleanupTimeoutMs;
  const timeoutMs = driver?.timeoutMs ?? options.timeoutMs;
  for (const [name, value] of [
    ['cleanup', cleanupTimeoutMs],
    ['execution', timeoutMs],
    ['close', driver?.closeTimeoutMs],
  ] as const)
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new RangeError(`Command ${name} deadline must be a positive safe integer`);
  return { cleanupTimeoutMs, timeoutMs };
}

interface NativeCommandOwner {
  result: Promise<unknown>;
  stop(): Promise<void>;
  terminate(): Promise<void>;
}
const owners = new WeakMap<object, NativeCommandOwner>();

/** A launcher and its admission owner share the execution owner's shutdown barrier. */
export function registerNativeCommandOwner(child: object, owner: NativeCommandOwner): void {
  owners.set(child, owner);
}

export function nativeCommandOwner(child: object): NativeCommandOwner | undefined {
  return owners.get(child);
}

/** Node streams retain their native backpressure; structural emitters have a finite queue. */
function outputStream(
  source: NativeCommandLaunchedOutput,
  closed: Promise<unknown>,
  maxBufferedBytes: number,
): { bytes: AsyncIterable<Uint8Array>; released: Promise<void>; destroy(): void } {
  if (source instanceof Readable)
    return {
      bytes: source,
      released: new Promise((resolve) =>
        source.closed ? resolve() : source.once('close', resolve),
      ),
      destroy() {
        source.destroy();
      },
    };
  const queue: Uint8Array[] = [];
  let buffered = 0;
  let ended = false;
  let failure: Error | undefined;
  let wake = Promise.withResolvers<void>();
  const notify = () => {
    wake.resolve();
    wake = Promise.withResolvers<void>();
  };
  source.on('data', (chunk) => {
    if (ended || failure) return;
    if (!(chunk instanceof Uint8Array)) {
      failure = new TypeError('Expected binary command output');
      notify();
      return;
    }
    if (chunk.byteLength === 0) return;
    const available = maxBufferedBytes - buffered;
    if (available > 0) {
      const kept = Uint8Array.from(chunk.subarray(0, available));
      queue.push(kept);
      buffered += kept.byteLength;
    }
    if (chunk.byteLength > available)
      failure = new NativeCommandError('COMMAND_LIMIT', 'Command output budget exceeded', {
        reason: 'output-budget',
      });
    notify();
  });
  void closed.then(() => {
    ended = true;
    notify();
  });
  return {
    bytes: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = queue.shift();
          if (chunk) {
            buffered -= chunk.byteLength;
            yield chunk;
          } else if (failure) throw failure;
          else if (ended) return;
          else await wake.promise;
        }
      },
    },
    released: closed.then(() => undefined),
    destroy() {
      ended = true;
      queue.length = 0;
      buffered = 0;
      notify();
      source.destroy();
    },
  };
}

/** Install every observation before starting stdin or invoking an admission callback. */
export function launchNativeCommand(
  options: ParsedNativeCommandOptions,
  driver: NativeCommandLaunchDriver | undefined,
  onSpawn: ((child: ChildProcessWithoutNullStreams) => void) | undefined,
  onFailure: (error: Error) => void,
  onInputFailure: (error: Error) => void,
) {
  let native: ChildProcessWithoutNullStreams | undefined;
  const launch = driver?.launch;
  if (!launch)
    native = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env:
        options.envPolicy === 'ambient'
          ? { ...process.env, ...options.env }
          : (options.env ?? {}),
      detached: driver?.group ?? true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const child: NativeCommandLaunchedProcess | undefined = launch ? launch() : native;
  if (!child) throw new Error('Native command launcher did not supply a process');
  const pendingHandles = new Set(['leader']);
  const leader = new Promise<NativeCommandSettlement>((resolve) => {
    child.on('exit', (exitCode, signal) => resolve({ kind: 'exit', exitCode, signal }));
    child.on('error', (cause) => resolve({ kind: 'error', cause }));
    if (child.exitCode !== null || child.signalCode !== null)
      resolve({ kind: 'exit', exitCode: child.exitCode, signal: child.signalCode });
  });
  const closed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.on('error', onFailure);
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const stdout = outputStream(child.stdout, closed, driver?.maxBufferedBytes ?? 1024 * 1024);
  const stderr = outputStream(child.stderr, closed, driver?.maxBufferedBytes ?? 1024 * 1024);
  const stdin = 'stdin' in child && child.stdin instanceof Writable ? child.stdin : undefined;
  const handles: (readonly [string, Promise<unknown>])[] = [
    ['stdout', stdout.released],
    ['stderr', stderr.released],
  ];
  if (stdin)
    handles.push([
      'stdin',
      new Promise<void>((resolve) =>
        stdin.closed ? resolve() : stdin.once('close', resolve),
      ),
    ]);
  const released = Promise.all([
    leader.then(() => pendingHandles.delete('leader')),
    ...handles.map(([name, released]) => {
      pendingHandles.add(name);
      return released.then(() => pendingHandles.delete(name));
    }),
    // A structural pipe's destroy method is no proof of remote/native handle closure.
    ...(child.stdout instanceof Readable && child.stderr instanceof Readable
      ? []
      : [closed.then(() => pendingHandles.delete('launcher'))]),
  ]);
  if (!(child.stdout instanceof Readable && child.stderr instanceof Readable))
    pendingHandles.add('launcher');
  stdin?.on('error', (error) => {
    if (!('code' in error && error.code === 'EPIPE')) onInputFailure(error);
  });
  return {
    child,
    stdout: stdout.bytes,
    stderr: stderr.bytes,
    leader,
    closed,
    released,
    pendingHandles,
    start() {
      if (native) onSpawn?.(native);
      stdin?.end(options.stdin);
    },
    destroy() {
      const failures: unknown[] = [];
      for (const handle of [stdin, stdout, stderr]) {
        try {
          handle?.destroy();
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Command pipe teardown failed');
    },
  };
}
