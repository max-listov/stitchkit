import { expect, spyOn, test } from 'bun:test';
import { DurableJsonSchema } from '../src/durability/json';
import { isJsonData } from '../src/internal/json-data';

test('unlimited durable JSON validates without string encoding, serialization or snapshot copies', () => {
  const payload = {
    text: 'a'.repeat(1024 * 1024),
    rows: Array.from({ length: 1000 }, (_, index) => ({ index, value: `value-${index}` })),
  };
  // Zod lazily initializes its parse method; measure the data traversal itself.
  DurableJsonSchema.parse(null);
  const encoding = spyOn(TextEncoder.prototype, 'encode');
  const serialization = spyOn(JSON, 'stringify');
  const copying = spyOn(Object, 'defineProperty');
  try {
    const parsed = DurableJsonSchema.parse(payload);
    expect(parsed).toBe(payload);
    expect(encoding).not.toHaveBeenCalled();
    expect(serialization).not.toHaveBeenCalled();
    expect(copying).not.toHaveBeenCalled();
  } finally {
    encoding.mockRestore();
    serialization.mockRestore();
    copying.mockRestore();
  }
});

test('predicate-only mode preserves node and depth bounds without byte accounting', () => {
  const value = { x: ['😀'.repeat(1000)] };
  const limits = { maxDepth: 2, maxNodes: 3, omitObjectUndefined: false };
  expect(isJsonData(value, limits)).toBe(true);
  expect(isJsonData(value, { ...limits, maxDepth: 1 })).toBe(false);
  expect(isJsonData(value, { ...limits, maxNodes: 2 })).toBe(false);
  expect(isJsonData(value, { ...limits, maxBytes: 20 })).toBe(false);
});

test('durable predicate accepts lossless JSON and rejects every lossy structure without getters', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const arrayExtra = Object.assign([1], { extra: 1 });
  const arraySymbol = Object.assign([1], { [Symbol('extra')]: 1 });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const invalid: unknown[] = [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    -0,
    1n,
    Symbol('value'),
    () => 1,
    new Date(),
    new Map(),
    new Set(),
    Object.create({ inherited: 1 }),
    { value: undefined },
    [undefined],
    Array(1),
    arrayExtra,
    arraySymbol,
    Object.defineProperty({}, 'value', { value: 1 }),
    accessor,
    cycle,
    {
      toJSON() {
        calls++;
        return 1;
      },
    },
    { [Symbol('value')]: 1 },
    revoked.proxy,
  ];
  for (const value of invalid) expect(DurableJsonSchema.safeParse(value).success).toBe(false);
  for (const value of [
    null,
    false,
    true,
    0,
    1.5,
    '😀\ud800\n',
    [],
    {},
    [1, null],
    { a: [true] },
    Object.create(null),
  ])
    expect(DurableJsonSchema.parse(value)).toBe(value);
  expect(calls).toBe(0);
});
