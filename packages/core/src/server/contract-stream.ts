import type { EndpointStreamDescriptor } from '../contract/define';
import { AppError } from '../contract/errors';
import { normalizeError } from '../contract/normalize';
import {
  contractStreamLifetimeExceeded,
  DEFAULT_CONTRACT_STREAM_FRAME_BYTES,
  readContractStreamItems,
} from '../contract/stream';
import {
  isStreamCancellation,
  ownHttpStream,
  settleStreamCleanup,
} from './http-stream-lifetime';
import { streamingRoute } from './streaming-route';
import type { RawRouteContext } from './types';

function encodedBytes(value: unknown, format: 'ndjson' | 'sse'): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Streaming item is not JSON serializable');
  const framing = format === 'sse' ? `data: ${json}\n\n` : `${json}\n`;
  return new TextEncoder().encode(framing).byteLength;
}

/** Build the HTTP response for one contract-declared stream. */
export function contractStreamResponse(
  request: Request,
  context: RawRouteContext,
  source: AsyncIterable<unknown>,
  descriptor: EndpointStreamDescriptor,
  operationAbort: AbortController,
): Promise<Response> {
  const format = descriptor.format ?? 'ndjson';
  const maxFrameBytes = descriptor.maxFrameBytes ?? DEFAULT_CONTRACT_STREAM_FRAME_BYTES;
  const iterator = source[Symbol.asyncIterator]();
  let pendingNext: Promise<IteratorResult<unknown>> | undefined;
  const settled = Promise.withResolvers<void>();
  void settled.promise.catch(() => undefined);
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let lifetimeExpired = false;
  let closing = false;
  const closeSource = (cancelled = operationAbort.signal.aborted) => {
    if (closing) return;
    closing = true;
    if (lifetime !== undefined) clearTimeout(lifetime);
    operationAbort.abort();
    // Wire completion and source cleanup have different lifetimes. A source
    // ignoring its deadline must not keep the response open or appear cleaned up.
    void settleStreamCleanup([
      Promise.resolve(pendingNext).catch((error: unknown) => {
        if (cancelled && !isStreamCancellation(error, operationAbort.signal)) throw error;
      }),
      Promise.resolve().then(() => iterator.return?.(undefined)),
    ]).then(
      () => settled.resolve(),
      (error: unknown) => settled.reject(error),
    );
  };
  ownHttpStream(request, { cancel: () => closeSource(true), settled: settled.promise });
  if (descriptor.lifetimeMs !== undefined && !closing) {
    lifetime = setTimeout(() => {
      lifetimeExpired = true;
      operationAbort.abort(new Error('Stream lifetime expired'));
    }, descriptor.lifetimeMs);
    lifetime.unref?.();
  }

  const frames = async function* () {
    if (closing) return;
    try {
      const items = readContractStreamItems(
        iterator,
        descriptor,
        operationAbort.signal,
        (pending) => {
          pendingNext = pending;
        },
      );
      for await (const { item, terminal } of items) {
        const frame = descriptor.framing === 'item' ? item : { type: 'data', data: item };
        if (encodedBytes(frame, format) > maxFrameBytes) {
          console.error(
            `[stitchkit] contract stream frame exceeded its ${maxFrameBytes} byte limit`,
          );
          throw new AppError('STREAM_FRAME_TOO_LARGE', {
            message: 'Stream item exceeded its declared frame limit',
            status: 500,
          });
        }
        yield frame;
        // A terminal that completes the operation is the stream's last frame.
        if (terminal && descriptor.completion === 'terminal') return;
      }
      if (descriptor.framing !== 'item') yield { type: 'end' };
    } catch (error) {
      if (operationAbort.signal.aborted && !lifetimeExpired) return;
      if (lifetimeExpired) {
        if (descriptor.framing === 'item') return;
        yield {
          type: 'error',
          error: contractStreamLifetimeExceeded().toJSON().error,
        };
        return;
      }
      if (descriptor.framing === 'item') {
        console.error(
          '[stitchkit] item-framed contract stream failed:',
          normalizeError(error),
        );
        return;
      }
      yield { type: 'error', error: normalizeError(error).toJSON().error };
    } finally {
      if (lifetime !== undefined) clearTimeout(lifetime);
      closeSource();
    }
  };

  const route = streamingRoute({
    path: '/',
    format,
    heartbeatMs: descriptor.heartbeatMs,
    idleTimeoutSeconds: descriptor.idleTimeoutSeconds,
    source: () => frames(),
    onClose: () => operationAbort.abort(),
  });
  return Promise.resolve(route.handler(request, context));
}
