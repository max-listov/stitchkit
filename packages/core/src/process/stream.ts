import { untilAborted } from '../internal/until-aborted';
import { startNativeCommand } from './command-owner';
import type { NativeCommandOptions, NativeCommandResult } from './contract';

/** Options the stream owns: its readers are the capture, the sink and the pipes. */
export type NativeCommandStreamOptions = Omit<
  NativeCommandOptions,
  'capture' | 'onOutput' | 'stdio'
>;

/** A started command whose output is read as it appears. */
export interface NativeCommandStream {
  /** The leader's stdout; closes once the command finished and every byte was queued. */
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /**
   * Settles like `runNativeCommand` once the command ended and both streams were read to the end
   * or cancelled: a stream nobody reads holds the child back, and with it this result. Its
   * `stdout` and `stderr` are empty, the streams hold the bytes.
   */
  readonly result: Promise<NativeCommandResult>;
  /** Stops the command with its stop policy and resolves once its resources are proven closed. */
  stop(): Promise<void>;
}

/**
 * Starts one command directly (no shell) like `runNativeCommand`, with the same group ownership,
 * stop policy and bounds, and hands its output over as `ReadableStream`s instead of buffering it
 * for the end. A slow reader slows the child (pipe backpressure); a cancelled stream drops what
 * follows without stopping the command. When the command fails or is stopped, both streams error and
 * the bytes still queued are dropped. A stream nobody reads holds the child back
 * once it queued 1 MiB, so read large outputs concurrently or cancel the stream.
 */
export function streamNativeCommand(input: NativeCommandStreamOptions): NativeCommandStream {
  for (const owned of ['capture', 'onOutput', 'stdio'] as const)
    if (owned in input) throw new TypeError(`streamNativeCommand owns ${owned}`);
  const channels = { stdout: channel(), stderr: channel() };
  const owner = startNativeCommand({
    ...input,
    onOutput: async (bytes, name, signal) => {
      await channels[name].push(Uint8Array.from(bytes), signal);
    },
  });
  void owner.result.then(
    () => {
      channels.stdout.close();
      channels.stderr.close();
    },
    (error: unknown) => {
      channels.stdout.fail(error);
      channels.stderr.fail(error);
    },
  );
  return {
    stdout: channels.stdout.stream,
    stderr: channels.stderr.stream,
    result: owner.result,
    stop: () => owner.stop(),
  };
}

/** What one stream queues before it holds the child back; below it, read order does not matter. */
const QUEUED_BYTES = 1024 * 1024;

function channel() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  let settled = false;
  let resume = Promise.withResolvers<void>();
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        resume.resolve();
      },
      cancel() {
        cancelled = true;
        resume.resolve();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: QUEUED_BYTES }),
  );
  return {
    stream,
    async push(bytes: Uint8Array, signal: AbortSignal) {
      if (cancelled || settled) return;
      controller.enqueue(bytes);
      // Full queue: hold the drain, and with it the pipe, until the reader pulls or the command stops.
      while (!cancelled && !signal.aborted && (controller.desiredSize ?? 0) <= 0) {
        resume = Promise.withResolvers<void>();
        await untilAborted(resume.promise, signal).catch(() => undefined);
      }
    },
    close() {
      if (cancelled || settled) return;
      settled = true;
      controller.close();
    },
    fail(error: unknown) {
      if (cancelled || settled) return;
      settled = true;
      controller.error(error);
    },
  };
}
