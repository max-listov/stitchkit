import { raceAbort } from '../internal/abort-race';
import { NativeCommandError, type ParsedNativeCommandOptions } from './contract';

/**
 * The reader of a command's two output channels: one combined `maxOutputBytes` budget, the
 * captured bytes per channel and the `onOutput` sink, all under the command's lifetime signal.
 */
export function createOutputDrain(options: ParsedNativeCommandOptions, signal: AbortSignal) {
  const captured = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
  let total = 0;
  const drain = async (stream: AsyncIterable<Uint8Array>, channel: 'stdout' | 'stderr') => {
    for await (const chunk of stream) {
      // A stopping command's output is read and dropped until cleanup closes the pipe: the
      // leader keeps a reader through its grace instead of meeting a broken pipe, and no
      // sink starts after the abort.
      if (signal.aborted) continue;
      // Node's binary Readable boundary; reject an unexpected text-mode adapter.
      if (!(chunk instanceof Uint8Array))
        throw new TypeError('Expected binary command output');
      total += chunk.byteLength;
      if (options.maxOutputBytes !== undefined && total > options.maxOutputBytes)
        throw new NativeCommandError('COMMAND_LIMIT', 'Command output budget exceeded', {
          reason: 'output-budget',
        });
      if (options.capture) captured[channel].push(Uint8Array.from(chunk));
      if (options.onOutput)
        try {
          await raceAbort(
            Promise.resolve().then(() => {
              signal.throwIfAborted();
              return options.onOutput?.(chunk, channel, signal);
            }),
            signal,
          );
        } catch (error) {
          if (!signal.aborted || error !== signal.reason) throw error;
        }
    }
  };
  return {
    drain,
    /** The captured bytes of each channel; empty unless `capture` was set. */
    captured: () => ({
      stdout: Buffer.concat(captured.stdout),
      stderr: Buffer.concat(captured.stderr),
    }),
  };
}
