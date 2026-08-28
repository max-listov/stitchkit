import type { ZodType } from 'zod';
import {
  ContractStreamFrameSchema,
  DEFAULT_CONTRACT_STREAM_FRAME_BYTES,
  type EndpointStreamDescriptor,
} from '../contract';
import { parseSSE } from '../server/stream';
import { ApiError } from './http';
import { parseNDJSON } from './stream';

function sourceFor(
  response: Response,
  descriptor: EndpointStreamDescriptor,
): AsyncGenerator<unknown> {
  const options = {
    maxLineBytes: descriptor.maxFrameBytes ?? DEFAULT_CONTRACT_STREAM_FRAME_BYTES,
  };
  return descriptor.format === 'sse'
    ? parseSSE<unknown>(response, options)
    : parseNDJSON<unknown>(response, options);
}

/** Read protocol frames into schema-derived items. */
async function* readContractStream<T>(
  response: Response,
  descriptor: EndpointStreamDescriptor<ZodType<T>>,
  abort: () => void,
): AsyncGenerator<T> {
  let ended = false;
  let terminalSeen = descriptor.terminal === undefined;
  try {
    for await (const raw of sourceFor(response, descriptor)) {
      const parsedFrame = ContractStreamFrameSchema.safeParse(raw);
      if (!parsedFrame.success) {
        throw new ApiError(
          'STREAM_PROTOCOL_ERROR',
          0,
          undefined,
          'Stream frame did not match the protocol envelope',
        );
      }
      const frame = parsedFrame.data;
      if (frame.type === 'error') {
        throw new ApiError(
          frame.error.code,
          0,
          frame.error.details,
          frame.error.message,
          frame.error.hint,
        );
      }
      if (frame.type === 'end') {
        if (!terminalSeen) {
          throw new ApiError(
            'STREAM_TERMINAL_MISSING',
            0,
            undefined,
            'Stream completed before its declared terminal item',
          );
        }
        ended = true;
        return;
      }
      const parsedItem = descriptor.item.safeParse(frame.data);
      if (!parsedItem.success) {
        throw new ApiError(
          'STREAM_ITEM_INVALID',
          0,
          undefined,
          'Stream item did not match its contract',
        );
      }
      const item = parsedItem.data;
      if (descriptor.terminal?.safeParse(item).success) terminalSeen = true;
      yield item;
    }
    if (!ended) {
      throw new ApiError(
        'STREAM_TRUNCATED',
        0,
        undefined,
        'Stream ended without its protocol terminal frame',
      );
    }
  } finally {
    abort();
  }
}

class OwnedContractStream<T> implements AsyncIterableIterator<T> {
  readonly #inner: AsyncGenerator<T>;
  readonly #abort: () => void;

  constructor(inner: AsyncGenerator<T>, abort: () => void) {
    this.#inner = inner;
    this.#abort = abort;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    return this.#inner.next();
  }

  return(): Promise<IteratorResult<T>> {
    // An async generator's body has not started before its first `next()`, so
    // its own `finally` cannot own this path. Abort synchronously here as well.
    this.#abort();
    return this.#inner.return(undefined);
  }

  throw(error?: unknown): Promise<IteratorResult<T>> {
    this.#abort();
    return this.#inner.throw(error);
  }
}

/** Convert protocol frames into an immediately-owned schema-derived iterator. */
export function parseContractStream<T>(
  response: Response,
  descriptor: EndpointStreamDescriptor<ZodType<T>>,
  abort: () => void,
): AsyncIterableIterator<T> {
  return new OwnedContractStream(readContractStream(response, descriptor, abort), abort);
}
