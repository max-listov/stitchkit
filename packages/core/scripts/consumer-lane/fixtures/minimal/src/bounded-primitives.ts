import {
  BoundedAdmissionRefusalError,
  createBoundedAdmission,
  createBoundedChannel,
  createCreditWindow,
} from 'stitchkit/application';
import { canonicalJson } from 'stitchkit/primitives';

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`bounded primitive conformance: ${message}`);
}

// Independent local worker: caller timeout settles, physical work keeps its permit.
let finishWorker: () => void = () => undefined;
const workerDone = new Promise<void>((resolve) => {
  finishWorker = resolve;
});
const workerAdmission = createBoundedAdmission({
  policy: { global: { maxConcurrent: 1 } },
});
const timedWorker = workerAdmission.run(undefined, () => workerDone, { timeoutMs: 1 });
await timedWorker.catch(() => undefined);
check(workerAdmission.getSnapshot().active === 1, 'caller timeout released live worker');
finishWorker();
await new Promise((resolve) => setTimeout(resolve, 0));
check(workerAdmission.getSnapshot().active === 0, 'worker completion did not release');

// Handler-shaped keyed work: one active operation, a concurrent peer is refused.
const handlerAdmission = createBoundedAdmission({
  policy: {
    global: { maxConcurrent: 2 },
    perKey: { maxConcurrent: 1, maxKeys: 10 },
  },
});
const held = handlerAdmission.acquire('account-a');
check(held.outcome === 'leased', 'first keyed handler was not leased');
try {
  await handlerAdmission.run('account-a', async () => undefined);
  throw new Error('second keyed handler unexpectedly ran');
} catch (error) {
  check(
    error instanceof BoundedAdmissionRefusalError && error.reason === 'key-concurrency',
    'keyed handler refusal lost its reason',
  );
}
if (held.outcome === 'leased') held.lease.release();

// Replaceable progress and ordered output are deliberately different channels.
const progress = createBoundedChannel<{ revision: number }>({
  policy: 'latest',
  maxItems: 1,
  maxBytes: 1,
  sizeOf: () => 1,
});
progress.offer({ revision: 1 });
progress.offer({ revision: 2 });
check((await progress.next()).value?.revision === 2, 'latest progress did not coalesce');

const output = createBoundedChannel<string>({
  policy: 'ordered',
  maxItems: 2,
  maxBytes: 8,
  sizeOf: (value) => value.length,
});
output.offer('one');
output.offer('two');
output.close();
const delivered: string[] = [];
for await (const value of output) delivered.push(value);
check(delivered.join(',') === 'one,two', 'ordered output changed order');

const credit = createCreditWindow({ capacityBytes: 4 });
const lease = credit.acquire(4);
check(lease.outcome === 'leased', 'credit was not leased');
check(credit.acquire(1).outcome === 'refused', 'credit window overdrew');
if (lease.outcome === 'leased') lease.lease.release();
check(credit.getSnapshot().availableBytes === 4, 'credit was not replenished exactly');

console.log('bounded transport primitives: ok');

// JSON admission and bytes are checked through the packed public entrypoint.
check(
  canonicalJson({
    '2': 2,
    '10': 10,
    '\uE000': 'bmp',
    '\u{10000}': 'pair',
    optional: undefined,
  }) === '{"10":10,"2":2,"𐀀":"pair","":"bmp"}',
  'canonical JSON lost historical UTF-16 key order or undefined omission',
);
check(
  canonicalJson('\ud800', { maxBytes: 8 }) === '"\\ud800"',
  'lone surrogate bytes changed',
);
for (const value of ['😀', '\u0000']) {
  let refused = false;
  try {
    canonicalJson(value, { maxBytes: 5 });
  } catch (error) {
    refused = error instanceof TypeError;
  }
  check(refused, 'canonical JSON admitted oversized UTF-8 or escaped output');
}
let keyReads = 0;
const mutableKeys = new Proxy(
  { a: 1, oversized: 'x'.repeat(8192) },
  {
    ownKeys: () => (++keyReads === 1 ? ['a'] : ['a', 'oversized']),
  },
);
check(canonicalJson(mutableKeys, { maxBytes: 7 }) === '{"a":1}', 'caller keys were reread');
check(keyReads === 1, 'canonical JSON enumerated caller keys more than once');
console.log('bounded canonical JSON: ok');
