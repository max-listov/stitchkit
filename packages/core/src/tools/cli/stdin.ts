import type { Readable } from 'node:stream';

/** Probe automatic stdin routing briefly; once data starts, only EOF completes it. */
export function readPipedStdin(
  input: Readable & { isTTY?: boolean } = process.stdin,
): Promise<string | null> {
  if (input.isTTY || input.readableEnded) return Promise.resolve(null);
  if (input.destroyed) return Promise.reject(new Error('stdin closed before EOF'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      input.pause();
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.off('close', onClose);
    };
    const onData = (chunk: Buffer | string) => {
      if (chunk.length === 0) return;
      clearTimeout(timer);
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    };
    const onEnd = () => {
      cleanup();
      const text = Buffer.concat(chunks).toString('utf8').trim();
      resolve(text.length > 0 ? text : null);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error('stdin closed before EOF'));
    // This is an availability probe, never a deadline on an active producer.
    // A producer that starts later can use an explicitly supplied CliConfig.stdin.
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 250);
    input.on('end', onEnd);
    input.on('error', onError);
    input.on('close', onClose);
    input.on('data', onData);
    input.resume();
  });
}
