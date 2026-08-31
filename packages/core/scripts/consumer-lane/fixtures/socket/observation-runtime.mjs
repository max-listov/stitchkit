import assert from 'node:assert/strict';
import { runObservationProof } from './observation.mjs';

const url = process.argv[2];
assert.ok(url, 'peer URL is required');
const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
try {
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  const results = await Promise.all(
    ['client', 'request'].map((scope) => runObservationProof(url, scope)),
  );
  assert.equal(new Set(results.flatMap((result) => result.requestIds)).size, 12);
  console.log('packed insecure-context observation: ok');
} finally {
  if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
  else Reflect.deleteProperty(crypto, 'randomUUID');
}
