import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable } from 'node:stream';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { NativeCommandError, type ParsedNativeCommandOptions } from './contract';
import { spawnInheritedCommand, spawnOwnedCommand } from './owned-child';
import { createCommandTransport, type NativeCommandTransport } from './transport';

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

export interface NativeCommandLaunchedOutput {
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
  const budgets: Array<[string, number | undefined]> = [
    ['cleanup', cleanupTimeoutMs],
    ['execution', timeoutMs],
    ['close', driver?.closeTimeoutMs],
  ];
  for (const [name, value] of budgets)
    assertPositiveSafeInteger(`Command ${name} deadline`, value, RangeError);
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
): { bytes: AsyncIterable<Uint8Array>; destroy(): void } {
  if (source instanceof Readable)
    return {
      bytes: source,
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
export function launchNativeCommand({
  options,
  driver,
  onSpawn,
  onFailure,
  onInputFailure,
  onAcquired,
}: {
  options: ParsedNativeCommandOptions;
  driver: NativeCommandLaunchDriver | undefined;
  /** Called once the real child exists, when the command starts. */
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  /** The process failed to start or reported an error. */
  onFailure: (error: Error) => void;
  /** Writing stdin failed for a reason other than a closed pipe. */
  onInputFailure: (error: Error) => void;
  /** The transport exists; fires before any observation or stdin write. */
  onAcquired: (transport: NativeCommandTransport) => void;
}) {
  let native: ChildProcessWithoutNullStreams | undefined;
  const launch = driver?.launch;
  const spawnInput = {
    executable: options.executable,
    args: options.args,
    cwd: options.cwd,
    env:
      options.envPolicy === 'ambient'
        ? { ...process.env, ...options.env }
        : (options.env ?? {}),
    // A command in the caller's group is never a group leader of its own.
    group: options.group === 'own' && (driver?.group ?? true),
  };
  let inherited: NativeCommandLaunchedProcess | undefined;
  if (!launch) {
    if (options.stdio === 'inherit') inherited = spawnInheritedCommand(spawnInput);
    else native = spawnOwnedCommand(spawnInput);
  }
  const child: NativeCommandLaunchedProcess | undefined = launch
    ? launch()
    : (native ?? inherited);
  if (!child) throw new Error('Native command launcher did not supply a process');
  const transport = createCommandTransport(child);
  onAcquired(transport);
  transport.observe(onFailure);
  const pipes = transport.capture();
  const stdout = outputStream(
    pipes.stdout,
    transport.closed,
    driver?.maxBufferedBytes ?? 1024 * 1024,
  );
  transport.pipeDestructor('stdout', () => stdout.destroy());
  const stderr = outputStream(
    pipes.stderr,
    transport.closed,
    driver?.maxBufferedBytes ?? 1024 * 1024,
  );
  transport.pipeDestructor('stderr', () => stderr.destroy());
  const stdin = transport.stdin;
  stdin?.on('error', (error) => {
    if (!('code' in error && error.code === 'EPIPE')) onInputFailure(error);
  });
  return {
    ...transport,
    stdout: stdout.bytes,
    stderr: stderr.bytes,
    start() {
      if (native) onSpawn?.(native);
      stdin?.end(options.stdin);
    },
  };
}
