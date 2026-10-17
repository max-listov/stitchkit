import { describe, expect, test } from 'bun:test';
import { readBoundedBody } from '../src/entrypoints/http';

const bytes = (length: number, fill = 1) => new Uint8Array(length).fill(fill);

class LimitError extends Error {
  constructor(readonly observed: number) {
    super('limit');
  }
}
class AbortedError extends Error {
  constructor(readonly reason: unknown) {
    super('aborted');
  }
}

/** A stream of the given chunks that counts how often it was cancelled and how far it was pulled. */
function counted(chunks: Uint8Array[]) {
  const state = { pulled: 0, cancelled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.pulled];
      state.pulled++;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      state.cancelled++;
    },
  });
  return { stream, state };
}

const options = (maxBytes: number, signal?: AbortSignal) => ({
  maxBytes,
  ...(signal && { signal }),
  limitError: (observed: number) => new LimitError(observed),
  abortError: (reason: unknown) => new AbortedError(reason),
});

describe('readBoundedBody', () => {
  test('a body of exactly maxBytes is read in full', async () => {
    const { stream } = counted([bytes(4, 1), bytes(4, 2)]);
    const body = await readBoundedBody(stream, options(8));
    expect(body.byteLength).toBe(8);
    expect([...body]).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });

  test('one byte more is refused, reports the bytes seen, and cancels the source', async () => {
    const { stream, state } = counted([bytes(4), bytes(5), bytes(100)]);
    const error = await readBoundedBody(stream, options(8)).catch((e: unknown) => e);
    if (!(error instanceof LimitError)) throw new Error('expected the limit error');
    expect(error.observed).toBe(9);
    expect(state.cancelled).toBe(1);
    // The read stops at the chunk that crossed the limit: the stream is one chunk ahead of its
    // reader, so the fourth (the 100-byte one) is never pulled, a full drain would pull it.
    expect(state.pulled).toBeLessThanOrEqual(3);
  });

  test('a null body is empty', async () => {
    expect((await readBoundedBody(null, options(8))).byteLength).toBe(0);
  });

  test('an abort in the middle of a read cancels the source and rejects with abortError', async () => {
    const controller = new AbortController();
    const state = { cancelled: 0 };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(2));
      },
      cancel() {
        state.cancelled++;
      },
    });
    const pending = readBoundedBody(stream, options(100, controller.signal));
    await Bun.sleep(5);
    const reason = new Error('stop');
    controller.abort(reason);
    const error = await pending.catch((e: unknown) => e);
    if (!(error instanceof AbortedError)) throw new Error('expected the abort error');
    expect(error.reason).toBe(reason);
    expect(state.cancelled).toBe(1);
  });

  test('a read that never settles does not hold the call after an abort', async () => {
    const controller = new AbortController();
    const hung = new ReadableStream<Uint8Array>({
      pull: () => new Promise<never>(() => undefined),
      // A transport that never settles its cancellation.
      cancel: () => new Promise<never>(() => undefined),
    });
    const pending = readBoundedBody(hung, options(100, controller.signal));
    setTimeout(() => controller.abort(new Error('closed')), 5);
    const error = await Promise.race([
      pending.catch((e: unknown) => e),
      Bun.sleep(1000).then(() => 'hung'),
    ]);
    expect(error).toBeInstanceOf(AbortedError);
  });

  test('an abort before the first read answers with abortError, even for a null body', async () => {
    const controller = new AbortController();
    controller.abort(new Error('early'));
    const { stream } = counted([bytes(1)]);
    for (const source of [stream, null]) {
      const error = await readBoundedBody(source, options(8, controller.signal)).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AbortedError);
    }
    // The stream was never touched: no reader took its lock.
    expect(stream.locked).toBe(false);
  });

  test('without abortError the signal reason is thrown as it is', async () => {
    const controller = new AbortController();
    const reason = new Error('plain');
    controller.abort(reason);
    const error = await readBoundedBody(null, {
      maxBytes: 8,
      signal: controller.signal,
      limitError: () => new LimitError(0),
    }).catch((e: unknown) => e);
    expect(error).toBe(reason);
  });

  test('reads an async byte iterable, and refuses a limit that is not a positive integer', async () => {
    async function* source() {
      yield bytes(3);
      yield bytes(3);
    }
    expect((await readBoundedBody(source(), options(6))).byteLength).toBe(6);
    await expect(readBoundedBody(null, options(0))).rejects.toThrow(/positive safe integer/);
  });

  test('a source that yields text instead of bytes is refused, never read past the limit', async () => {
    let yielded = 0;
    async function* text(): AsyncGenerator<never> {
      for (;;) {
        yielded++;
        yield 'x'.repeat(1000) as never;
        if (yielded > 5) return;
      }
    }
    await expect(readBoundedBody(text(), options(10))).rejects.toThrow(/must yield bytes/);
    expect(yielded).toBe(1);
  });
});
