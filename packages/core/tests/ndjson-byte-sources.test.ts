import { heapStats } from 'bun:jsc';
import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import {
  createNDJSONDecoder,
  parseNDJSON,
  parseSSE,
  StreamLineLimitError,
  StreamTruncatedLineError,
} from '../src/entrypoints/index';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? bytes(part) : part;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe('NDJSON from sources that are not a Response', () => {
  test('a web stream and an async byte iterable read the same values', async () => {
    const expected = [{ n: 1 }, { n: 2 }];
    const stream = new Response('{"n":1}\n\n{"n":2}\n').body;
    if (!stream) throw new Error('no body');
    expect(await collect(parseNDJSON(stream))).toEqual(expected);
    // A line split across chunks, with a character split inside its UTF-8 bytes.
    const split = bytes('{"n":1}\n{"n":2,"s":"é"}\n');
    const cut = split.indexOf(0xc3) + 1;
    expect(
      await collect(parseNDJSON(chunks(split.subarray(0, cut), split.subarray(cut)))),
    ).toEqual([{ n: 1 }, { n: 2, s: 'é' }]);
  });

  test('a child process stdout is read as NDJSON', async () => {
    const child = Bun.spawn(
      ['bun', '-e', 'for (const n of [1, 2, 3]) console.log(JSON.stringify({ n }))'],
      { stdout: 'pipe' },
    );
    trackProcess(child.pid);
    expect(
      await collect(
        parseNDJSON<{ n: number }>(child.stdout, { finalLine: 'require-newline' }),
      ),
    ).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(await child.exited).toBe(0);
  });

  test('a line past the limit is a named error with its size, before the rest is read', async () => {
    let produced = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      yield bytes('{"ok":true}\n');
      for (;;) {
        produced++;
        yield new Uint8Array(1024).fill(0x61);
      }
    }
    const values = parseNDJSON(endless(), { maxLineBytes: 4096 });
    expect(await values.next()).toEqual({ done: false, value: { ok: true } });
    const failure = await values.next().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StreamLineLimitError);
    expect(failure).toBeInstanceOf(RangeError);
    expect(failure).toMatchObject({ limitBytes: 4096, lineBytes: 5120 });
    // Reading stopped at the chunk that crossed the limit: memory did not grow with the line.
    expect(produced).toBe(5);
  });

  test('a source cut mid-line is a truncated line, not a value', async () => {
    const failure = await collect(
      parseNDJSON(chunks('{"n":1}\n{"n":'), { finalLine: 'require-newline' }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StreamTruncatedLineError);
    expect(failure).toMatchObject({ lineBytes: 5 });
    // Control: the permissive default still reads a complete final value without a newline.
    expect(await collect(parseNDJSON(chunks('{"n":1}')))).toEqual([{ n: 1 }]);
  });

  test('aborting stops reading and returns the iterable', async () => {
    let returned = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const controller = new AbortController();
    const reading = parseNDJSON(source, { signal: controller.signal }).next();
    controller.abort(new Error('stop'));
    await expect(reading).rejects.toThrow('stop');
    expect(returned).toBe(true);
  });

  test('aborting a pending async generator or Node Readable rejects at once', async () => {
    async function* silent(): AsyncGenerator<Uint8Array> {
      yield* [];
      await new Promise(() => undefined);
    }
    const node = new Readable({ read: () => undefined });
    for (const source of [silent(), node]) {
      const controller = new AbortController();
      const reading = parseNDJSON(source, { signal: controller.signal }).next();
      const reason = new Error('stop');
      controller.abort(reason);
      const outcome = await Promise.race([
        reading.then(
          () => 'resolved',
          (error: unknown) => (error === reason ? 'rejected' : 'other'),
        ),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 500)),
      ]);
      expect(outcome).toBe('rejected');
    }
    node.destroy();
  });

  test('an abort is not malformed input, even with onParseError', async () => {
    const seen: string[] = [];
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
    });
    const reading = parseNDJSON(stream, {
      signal: controller.signal,
      onParseError: (raw) => seen.push(raw),
    }).next();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
    expect(seen).toEqual([]);
  });

  test('aborting cancels a web stream', async () => {
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel: (reason) => {
        cancelled = reason;
      },
    });
    const controller = new AbortController();
    const reading = parseNDJSON(stream, { signal: controller.signal }).next();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
    expect(cancelled).toBe(reason);
  });

  test('SSE reads the same byte sources', async () => {
    expect(await collect(parseSSE(chunks('data: {"a":1}\n\n', 'data: [DONE]\n')))).toEqual([
      { a: 1 },
    ]);
  });
});

describe('createNDJSONDecoder for callback sources', () => {
  test('values cross chunk boundaries, blank lines and CRLF', () => {
    const decoder = createNDJSONDecoder<{ n: number }>();
    expect(decoder.push(bytes('{"n":'))).toEqual([]);
    expect(decoder.push(bytes('1}\r\n\n{"n":2}\n{"n"'))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(decoder.push(bytes(':3}'))).toEqual([]);
    expect(decoder.end()).toEqual([{ n: 3 }]);
  });

  test('the limit holds across chunks and a required newline refuses a cut line', () => {
    const limited = createNDJSONDecoder({ maxLineBytes: 8 });
    expect(limited.push(bytes('1234'))).toEqual([]);
    expect(() => limited.push(bytes('56789'))).toThrow(StreamLineLimitError);
    const strict = createNDJSONDecoder({ finalLine: 'require-newline' });
    expect(strict.push(bytes('{"n":1}\n{"n"'))).toEqual([{ n: 1 }]);
    expect(() => strict.end()).toThrow(StreamTruncatedLineError);
  });

  test('a decoder keeps its bytes when the caller reuses the chunk buffer', () => {
    for (const buffer of [bytes('{"n":1'), Buffer.from('{"n":1')]) {
      const decoder = createNDJSONDecoder<{ n: number }>();
      decoder.push(buffer);
      buffer.fill(0x20);
      expect(decoder.push(bytes('}\n'))).toEqual([{ n: 1 }]);
    }
  });

  test('an overflow stops the decoder: the rest of the line is never read as a value', () => {
    const decoder = createNDJSONDecoder({ maxLineBytes: 8 });
    expect(() => decoder.push(bytes('{"a":1}\n{"bbbbbbbb":2}\n'))).toThrow(
      StreamLineLimitError,
    );
    expect(() => decoder.push(bytes('x"}\n{"c":3}\n'))).toThrow('stopped at an earlier error');
  });

  test('invalid JSON reaches onParseError or throws', () => {
    const seen: string[] = [];
    const tolerant = createNDJSONDecoder({ onParseError: (raw) => seen.push(raw) });
    expect(tolerant.push(bytes('nope\n{"n":1}\n'))).toEqual([{ n: 1 }]);
    expect(seen).toEqual(['nope']);
    expect(() => createNDJSONDecoder().push(bytes('nope\n'))).toThrow(SyntaxError);
  });
});

describe('reading under a signal', () => {
  test('a long read with a signal retains no chunk it has already handed on', async () => {
    const controller = new AbortController();
    const size = 256 * 1024;
    const total = 400;
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < total; index++) {
        const line = new Uint8Array(size).fill(0x78);
        line[0] = 0x22;
        line[size - 2] = 0x22;
        line[size - 1] = 0x0a;
        yield line;
      }
    }
    // What the process already holds counts for nothing: only the growth of this read does.
    const settledMemory = async () => {
      Bun.gc(true);
      await Bun.sleep(10);
      Bun.gc(true);
      return heapStats().extraMemorySize;
    };
    const before = await settledMemory();
    let seen = 0;
    let growth = 0;
    for await (const _ of parseNDJSON<string>(source(), { signal: controller.signal })) {
      seen++;
      if (seen === total - 1) growth = (await settledMemory()) - before;
    }
    expect(seen).toBe(total);
    // One chunk is a quarter of a MiB; retaining each of 399 would be ~100 MiB.
    expect(growth).toBeLessThan(24 * 1024 * 1024);
  });

  test('lines of a chunk that was already read are not delivered after the abort', async () => {
    const text = '{"a":1}\n{"a":2}\n{"a":3}\n';
    const sources: (() => AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>)[] = [
      () => chunks(text),
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes(text));
            controller.close();
          },
        }),
    ];
    for (const make of sources) {
      const controller = new AbortController();
      const reason = new Error('stop');
      const seen: number[] = [];
      const reading = (async () => {
        for await (const value of parseNDJSON<{ a: number }>(make(), {
          signal: controller.signal,
        })) {
          seen.push(value.a);
          controller.abort(reason);
        }
      })();
      await expect(reading).rejects.toBe(reason);
      expect(seen).toEqual([1]);
    }
  });

  test('onParseError that throws is called once, and its error ends the iteration', async () => {
    for (const read of [parseNDJSON, parseSSE]) {
      const calls: string[] = [];
      const failure = new Error('handler refused');
      const reading = collect(
        read(chunks(read === parseSSE ? 'data: nope\n' : 'nope\n'), {
          onParseError: (raw) => {
            calls.push(raw);
            throw failure;
          },
        }),
      );
      await expect(reading).rejects.toBe(failure);
      expect(calls).toEqual(['nope']);
    }
  });
});

describe('createNDJSONDecoder after a failed line', () => {
  test('a JSON error stops the decoder: the lines cut with it are not skipped silently', () => {
    const decoder = createNDJSONDecoder<{ n: number }>();
    expect(() => decoder.push(bytes('nope\n{"n":1}\n{"n":2}\n'))).toThrow(SyntaxError);
    expect(() => decoder.push(bytes('{"n":3}\n'))).toThrow('stopped at an earlier error');
    expect(() => decoder.end()).toThrow('stopped at an earlier error');
  });

  test('a handled error does not stop it', () => {
    const decoder = createNDJSONDecoder<{ n: number }>({ onParseError: () => undefined });
    expect(decoder.push(bytes('nope\n{"n":1}\n'))).toEqual([{ n: 1 }]);
    expect(decoder.push(bytes('{"n":2}\n'))).toEqual([{ n: 2 }]);
  });
});
