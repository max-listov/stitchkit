import assert from 'node:assert/strict';
import { ApiError, createClient, defineContract } from 'stitchkit';
import { z } from 'zod';

const contract = defineContract(
  { prefix: 'cancellation-proof' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Cancellation proof',
      timeout: 5,
      output: z.object({ ok: z.boolean() }),
    },
  },
);

class TransportEvidence extends Error {
  delivery = 'not-dispatched';
  traceId = 'private-trace';
}

const chainIncludes = (error, expected) => {
  const visited = new Set();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    if (current === expected) return true;
    visited.add(current);
    current = current.cause;
  }
  return false;
};

const rejectOnAbort = (evidence) => (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    if (signal.aborted) reject(evidence);
    else signal.addEventListener('abort', () => reject(evidence), { once: true });
  });

for (const [kind, expectedCode] of [
  ['caller', 'REQUEST_ABORTED'],
  ['timeout', 'REQUEST_TIMEOUT'],
]) {
  const evidence = new TransportEvidence('credential=must-not-be-public');
  const api = createClient(contract, {
    baseUrl: 'http://127.0.0.1:1',
    fetch: rejectOnAbort(evidence),
  });
  const controller = new AbortController();
  const pending =
    kind === 'caller' ? api.ping.withOptions({ signal: controller.signal }) : api.ping();
  if (kind === 'caller') controller.abort('consumer stopped');
  const failure = await pending.catch((error) => error);
  assert.equal(ApiError.is(failure), true);
  assert.equal(failure.code, expectedCode);
  assert.equal(chainIncludes(failure, evidence), true);
  assert.equal(JSON.stringify(failure).includes('must-not-be-public'), false);
  assert.equal(failure.message.includes('must-not-be-public'), false);
}

const successful = createClient(contract, {
  baseUrl: 'http://127.0.0.1:1',
  fetch: async () => Response.json({ ok: true }),
});
assert.deepEqual(await successful.ping(), { ok: true });

console.log('packed typed-client cancellation cause: ok');
