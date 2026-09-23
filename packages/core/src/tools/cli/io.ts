import { writeSync } from 'node:fs';
import { isRecord } from '../../internal/typed';
import type { CliConfig } from './config';

/** Default stdin reader — `null` on an interactive TTY (nothing piped). */
async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text.length > 0 ? text : null;
}

/** Where one invocation writes, reads and exits — injected sinks or the real process. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
  readStdin: () => Promise<string | null>;
}

export function createCliIo(
  config: Pick<CliConfig, 'stdout' | 'stderr' | 'exit' | 'stdin'>,
): CliIo {
  /**
   * Write every byte, synchronously, before the process is allowed to exit.
   *
   * Two distinct truncations live here, and the second was mistaken for the
   * first for a long time. The async `process.stdout.write` buffers, so a
   * `process.exit` right after a print drops whatever the runtime had not
   * flushed — a 70 KB JSON cut at exactly 65536 bytes. `writeSync` answers
   * that one.
   *
   * It does NOT answer the other. Once anything in the process has touched
   * `process.stdout`, the runtime has made that descriptor non-blocking; a
   * `writeSync` into a pipe whose reader is slow then writes as much as the
   * 64 KB pipe buffer will take, RETURNS THAT COUNT and throws nothing. The
   * old code ignored the count, so the tail was lost in silence with exit code
   * 0 — the same 65536 bytes as the bug it was written to fix, which is why it
   * read as fixed. Measured on Bun 1.3.14: `bun -e 'process.stdout;
   * writeSync(1, "x".repeat(200000))' | (sleep 1; wc -c)` → 65536.
   *
   * So the count is the loop condition, and a completely full buffer (`EAGAIN`)
   * is a wait, not a failure: a blocking write into a pipe nobody is draining
   * is supposed to block. Bytes, not characters — `writeSync` counts bytes and
   * a resumed multi-byte character would otherwise split.
   */
  let pendingWrite: Promise<void> | undefined;
  let writeFailed = false;
  const writeFd = (fd: 1 | 2, text: string): void => {
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      try {
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      } catch (error) {
        if (isRecord(error) && error.code === 'EAGAIN') {
          // A synchronous pause: the descriptor is full and there is nothing
          // else this invocation may do until the reader drains it.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
          continue;
        }
        // An exotic descriptor that refuses a sync write at all. The async
        // stream is the last resort, and `exit` below waits for it rather than
        // cutting it off — otherwise this branch would reintroduce the very
        // truncation the sync path exists to prevent.
        const stream = fd === 1 ? process.stdout : process.stderr;
        const rest = bytes.subarray(offset);
        pendingWrite = new Promise<void>((resolve) => {
          stream.write(rest, (failure) => {
            if (failure) writeFailed = true;
            resolve();
          });
        });
        return;
      }
    }
  };
  const stdout = config.stdout ?? ((text: string) => writeFd(1, text));
  const stderr = config.stderr ?? ((text: string) => writeFd(2, text));
  const exit =
    config.exit ??
    ((code: number) => {
      // Nothing is pending on the normal path — the loop above already put
      // every byte in the descriptor. When the fallback ran, exiting now would
      // cut it, and output that could not be delivered at all is a failure,
      // not a success with a short result.
      if (pendingWrite === undefined) process.exit(code);
      else void pendingWrite.then(() => process.exit(writeFailed ? 1 : code));
    });
  const readStdin = config.stdin ?? readPipedStdin;
  return { stdout, stderr, exit, readStdin };
}
