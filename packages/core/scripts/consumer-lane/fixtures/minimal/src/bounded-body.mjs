import assert from 'node:assert/strict';
import { readBoundedBody } from 'stitchkit/http';

class TooLarge extends Error {
  constructor(observedBytes) {
    super('too large');
    this.observedBytes = observedBytes;
  }
}
class Closed extends Error {}

const options = (maxBytes, signal) => ({
  maxBytes,
  signal,
  limitError: (observedBytes) => new TooLarge(observedBytes),
  abortError: () => new Closed('closed'),
});

function source(chunks) {
  const state = { cancelled: 0 };
  let next = 0;
  const stream = new ReadableStream({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      state.cancelled++;
    },
  });
  return { stream, state };
}

const exact = source([new Uint8Array(4).fill(1), new Uint8Array(4).fill(2)]);
const body = await readBoundedBody(exact.stream, options(8));
assert.equal(body.byteLength, 8);

const over = source([new Uint8Array(5), new Uint8Array(5), new Uint8Array(50)]);
const refused = await readBoundedBody(over.stream, options(8)).catch((error) => error);
assert.ok(refused instanceof TooLarge);
assert.equal(refused.observedBytes, 10);
assert.equal(over.state.cancelled, 1);

assert.equal((await readBoundedBody(null, options(8))).byteLength, 0);

const controller = new AbortController();
const hung = new ReadableStream({ pull: () => new Promise(() => undefined) });
const pending = readBoundedBody(hung, options(8, controller.signal));
setTimeout(() => controller.abort(new Error('stop')), 10);
const aborted = await Promise.race([
  pending.catch((error) => error),
  new Promise((resolve) => setTimeout(() => resolve('held'), 2000)),
]);
assert.ok(aborted instanceof Closed, 'an abort releases a read that never settles');

console.log('packed bounded body: ok');
