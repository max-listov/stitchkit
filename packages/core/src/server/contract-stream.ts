import {
  AppError,
  DEFAULT_CONTRACT_STREAM_FRAME_BYTES,
  type EndpointStreamDescriptor,
} from '../contract';
import { normalizeError } from '../internal/errors';
import { streamingRoute } from './streaming-route';
import type { RawRouteContext } from './types';

function encodedBytes(value: unknown, format: 'ndjson' | 'sse'): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Streaming item is not JSON serializable');
  const framing = format === 'sse' ? `data: ${json}\n\n` : `${json}\n`;
  return new TextEncoder().encode(framing).byteLength;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAborted = (): void => reject(signal.reason ?? new Error('Stream aborted'));
    if (signal.aborted) rejectAborted();
    else signal.addEventListener('abort', rejectAborted, { once: true });
  });
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
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let lifetimeExpired = false;
  if (descriptor.lifetimeMs !== undefined) {
    lifetime = setTimeout(() => {
      lifetimeExpired = true;
      operationAbort.abort(new Error('Stream lifetime expired'));
    }, descriptor.lifetimeMs);
    lifetime.unref?.();
  }

  const frames = async function* () {
    const iterator = source[Symbol.asyncIterator]();
    const aborted = waitForAbort(operationAbort.signal);
    let terminalSeen = descriptor.terminal === undefined;
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) break;
        const parsed = descriptor.item.safeParse(next.value);
        if (!parsed.success) {
          console.error('[stitchkit] contract stream item failed validation:', parsed.error);
          throw new AppError(
            'STREAM_ITEM_INVALID',
            'Stream item did not match its contract',
            500,
          );
        }
        const item = parsed.data;
        if (descriptor.terminal?.safeParse(item).success) terminalSeen = true;
        const frame = { type: 'data', data: item };
        if (encodedBytes(frame, format) > maxFrameBytes) {
          console.error(
            `[stitchkit] contract stream frame exceeded its ${maxFrameBytes} byte limit`,
          );
          throw new AppError(
            'STREAM_FRAME_TOO_LARGE',
            'Stream item exceeded its declared frame limit',
            500,
          );
        }
        yield frame;
      }
      if (!terminalSeen) {
        throw new AppError(
          'STREAM_TERMINAL_MISSING',
          'Stream completed before its declared terminal item',
          500,
        );
      }
      yield { type: 'end' };
    } catch (error) {
      if (operationAbort.signal.aborted && !lifetimeExpired) return;
      if (lifetimeExpired) {
        yield {
          type: 'error',
          error: new AppError(
            'STREAM_LIFETIME_EXCEEDED',
            'Stream exceeded its declared lifetime',
            408,
          ).toJSON().error,
        };
        return;
      }
      yield { type: 'error', error: normalizeError(error).toJSON().error };
    } finally {
      if (lifetime !== undefined) clearTimeout(lifetime);
      operationAbort.abort();
      void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
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
