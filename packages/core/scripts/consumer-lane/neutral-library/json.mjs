import assert from 'node:assert/strict';
import { canonicalJson } from 'neutral-library-fixture/primitives';

const object = { 2: 2, 10: 10, '': 'bmp', '\u{10000}': 'pair' };
assert.equal(canonicalJson(object), '{"10":10,"2":2,"\u{10000}":"pair","":"bmp"}');
console.log('neutral JSON: ok');
