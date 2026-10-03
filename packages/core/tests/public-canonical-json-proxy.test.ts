import { expect, test } from 'bun:test';
import { canonicalJson } from '../src/entrypoints/primitives';

test('canonical JSON snapshots changing own keys once before historical serialization', () => {
  let enumerations = 0;
  const value = new Proxy(
    { a: 1, huge: 'x'.repeat(8192) },
    {
      ownKeys() {
        return ++enumerations === 1 ? ['a'] : ['a', 'huge'];
      },
    },
  );
  const text = canonicalJson(value, { maxBytes: 7, maxNodes: 2, maxDepth: 1 });
  expect(text).toBe('{"a":1}');
  expect(new TextEncoder().encode(text).byteLength).toBe(7);
  expect(enumerations).toBe(1);
});

test('canonical JSON snapshots changing descriptors without caller property reads', () => {
  let descriptors = 0;
  let reads = 0;
  const value = new Proxy(
    { a: 'small' },
    {
      getOwnPropertyDescriptor(target, key) {
        descriptors++;
        return {
          ...Reflect.getOwnPropertyDescriptor(target, key),
          value: descriptors === 1 ? 'small' : 'x'.repeat(8192),
        };
      },
      get() {
        reads++;
        return 'x'.repeat(8192);
      },
    },
  );
  expect(canonicalJson(value, { maxBytes: 13 })).toBe('{"a":"small"}');
  expect(descriptors).toBe(1);
  expect(reads).toBe(0);
});

test('canonical JSON snapshots array length and elements without get traps', () => {
  let lengthDescriptors = 0;
  let elementDescriptors = 0;
  let reads = 0;
  const value = new Proxy([1], {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === 'length')
        return { ...descriptor, value: ++lengthDescriptors === 1 ? 1 : 1000 };
      return { ...descriptor, value: ++elementDescriptors === 1 ? 1 : 'x'.repeat(8192) };
    },
    get(target, key, receiver) {
      reads++;
      if (key === '0') return 'x'.repeat(8192);
      return Reflect.get(target, key, receiver);
    },
  });
  expect(canonicalJson(value, { maxBytes: 3, maxNodes: 2, maxDepth: 1 })).toBe('[1]');
  expect(lengthDescriptors).toBe(1);
  expect(elementDescriptors).toBe(1);
  expect(reads).toBe(0);
});

test('canonical JSON rejects enormous captured array length before enumeration', () => {
  let enumerations = 0;
  const value = new Proxy([], {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'length' ? { ...descriptor, value: 2 ** 32 - 1 } : descriptor;
    },
    ownKeys() {
      enumerations++;
      return ['length'];
    },
  });
  expect(() => canonicalJson(value, { maxNodes: 5, maxBytes: 16 })).toThrow(TypeError);
  expect(enumerations).toBe(0);
});

test('canonical JSON refuses revoked and throwing nested proxies as bounded JSON', () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const throwing = new Proxy(
    {},
    {
      ownKeys() {
        throw new RangeError('hostile trap');
      },
    },
  );
  for (const value of [revoked.proxy, { value: revoked.proxy }, { value: throwing }]) {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  }
});

test('canonical JSON budgets captured nested values instead of rereading caller values', () => {
  let reads = 0;
  const nested = new Proxy(
    { value: 'ok' },
    {
      get() {
        reads++;
        return { deeper: { too: { deep: 'x'.repeat(8192) } } };
      },
    },
  );
  expect(canonicalJson({ nested }, { maxDepth: 2, maxNodes: 3, maxBytes: 25 })).toBe(
    '{"nested":{"value":"ok"}}',
  );
  expect(reads).toBe(0);
  expect(() => canonicalJson({ nested }, { maxDepth: 1 })).toThrow(TypeError);
  expect(() => canonicalJson({ nested }, { maxNodes: 2 })).toThrow(TypeError);
  expect(() => canonicalJson({ nested }, { maxBytes: 24 })).toThrow(TypeError);
});

test('canonical JSON admits array members only from captured keys and length', () => {
  let enumerations = 0;
  const value = new Proxy([1, 'x'.repeat(8192)], {
    ownKeys() {
      return ++enumerations === 1 ? ['0', 'length'] : ['0', '1', 'length'];
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'length' ? { ...descriptor, value: 1 } : descriptor;
    },
  });
  expect(canonicalJson(value, { maxBytes: 3, maxNodes: 2 })).toBe('[1]');
  expect(enumerations).toBe(1);
});

test('canonical JSON rejects huge captured array length on byte budget alone', () => {
  let enumerations = 0;
  const value = new Proxy([], {
    ownKeys() {
      enumerations++;
      return ['length'];
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'length' ? { ...descriptor, value: 2 ** 32 - 1 } : descriptor;
    },
  });
  expect(() =>
    canonicalJson(value, { maxNodes: Number.MAX_SAFE_INTEGER, maxBytes: 16 }),
  ).toThrow(TypeError);
  expect(enumerations).toBe(0);
});
