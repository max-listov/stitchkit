/**
 * The identity of a call's arguments.
 *
 * This file exists because of one report: every watched read failed on a page
 * served over plain HTTP from a LAN name, and nothing here had ever noticed.
 * The digest used `crypto.subtle`, which exists only in a **secure context** —
 * and `localhost` is secure by definition, so a laptop, a test runner and CI all
 * agreed the code was fine right up until a browser opened the app by its name.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { argumentsDigest, stableValue } from '../src/internal/stable-digest';

describe('an identity that needs nothing from its surroundings', () => {
  test('a digest is computed where there is no crypto.subtle at all', () => {
    // The reported environment, reproduced: a `crypto` with no `subtle` on it.
    // Not a mock of the digest — the real function, on a global shaped like the
    // one that broke.
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: original.getRandomValues.bind(original) },
      configurable: true,
    });
    try {
      expect(argumentsDigest({ folder: 'inbox' })).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });

  test('the module reaches for no ambient capability, in its source', () => {
    // The second witness, and the one that survives a runtime that happens to
    // provide `subtle` anyway: a digest that consults its surroundings can be
    // right on every machine that runs the tests and wrong on the one that
    // matters. Read as text on purpose — a call this test cannot execute is
    // exactly the call it has to see.
    const source = readFileSync(`${import.meta.dir}/../src/internal/stable-digest.ts`, 'utf8');
    const body = source.slice(source.indexOf('export function stableValue'));
    expect(body).not.toContain('crypto');
    expect(body).not.toContain('await');
  });

  test('it is synchronous, so a key is available in the turn it is asked for', () => {
    const digest = argumentsDigest({ a: 1 });
    expect(typeof digest).toBe('string');
    expect(digest).not.toBeInstanceOf(Promise);
  });
});

describe('what the digest has to get right', () => {
  test('the same question in a different key order is the same digest', () => {
    expect(argumentsDigest({ a: 1, b: 2 })).toBe(argumentsDigest({ b: 2, a: 1 }));
    expect(argumentsDigest({ outer: { x: 1, y: 2 } })).toBe(
      argumentsDigest({ outer: { y: 2, x: 1 } }),
    );
  });

  test('an array keeps its order, because in an array order is the value', () => {
    expect(argumentsDigest({ ids: [1, 2] })).not.toBe(argumentsDigest({ ids: [2, 1] }));
  });

  test('different questions are different digests, including near misses', () => {
    const digests = [
      argumentsDigest({ folder: 'inbox' }),
      argumentsDigest({ folder: 'inbo' }),
      argumentsDigest({ folder: 'inboy' }),
      argumentsDigest({ folder: 'xinbox' }),
      argumentsDigest({ folderr: 'inbox' }),
      argumentsDigest({ folder: 'inbox', page: 1 }),
      argumentsDigest({}),
    ];
    expect(new Set(digests).size).toBe(digests.length);
  });

  test('a thousand neighbouring questions produce a thousand distinct keys', () => {
    // A collision here is not a slow path, it is two different questions sharing
    // one answer. Asserted over inputs that differ by one character, because
    // those are the ones a weak mixer collapses.
    const digests = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      digests.add(argumentsDigest({ address: `session-${index}` }));
    }
    expect(digests.size).toBe(1000);
  });

  test('the digest is the declared width, and stable across calls', () => {
    const first = argumentsDigest({ folder: 'inbox', page: 2 });
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(argumentsDigest({ page: 2, folder: 'inbox' })).toBe(first);
  });
});

describe('stableValue', () => {
  test('sorts object keys at every depth and leaves arrays alone', () => {
    expect(JSON.stringify(stableValue({ b: 1, a: { d: 2, c: [3, 1] } }))).toBe(
      '{"a":{"c":[3,1],"d":2},"b":1}',
    );
  });

  test('reads own enumerable keys only, so nothing from a prototype leaks in', () => {
    const parent = { inherited: 'no' };
    const child = Object.create(parent) as Record<string, unknown>;
    child.own = 'yes';
    expect(JSON.stringify(stableValue(child))).toBe('{"own":"yes"}');
  });
});
