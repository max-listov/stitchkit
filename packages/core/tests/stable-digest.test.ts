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
import { compareCodeUnits, serializeCanonicalJson } from '../src/internal/canonical-json';
import { argumentsDigest } from '../src/internal/stable-digest';

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
    // The code after the module header, in both files the digest runs through:
    // the header explains `crypto.subtle` at length and must not count.
    for (const [file, from] of [
      ['stable-digest.ts', 'function mix128'],
      ['canonical-json.ts', 'export function compareCodeUnits'],
    ] as const) {
      const source = readFileSync(`${import.meta.dir}/../src/internal/${file}`, 'utf8');
      const start = source.indexOf(from);
      expect(start).toBeGreaterThan(0);
      const body = source.slice(start);
      expect(body).not.toContain('crypto');
      expect(body).not.toContain('await');
    }
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

describe('serializeCanonicalJson', () => {
  test('sorts object keys at every depth and leaves arrays alone', () => {
    expect(serializeCanonicalJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe(
      '{"a":{"c":[3,1],"d":2},"b":1}',
    );
  });

  test('reads own enumerable keys only, so nothing from a prototype leaks in', () => {
    const parent = { inherited: 'no' };
    const child = Object.create(parent) as Record<string, unknown>;
    child.own = 'yes';
    expect(serializeCanonicalJson(child)).toBe('{"own":"yes"}');
  });
});

describe('one order behind every digest', () => {
  // Keys outside the Basic Multilingual Plane are where code-unit and code-point
  // order disagree: U+1F600 is a surrogate pair starting 0xD83D, below U+FF61.
  // Every stored digest — CLI signatures, agent-store hashes, surface snapshots —
  // was taken in code-unit order, so this pins it rather than "fixing" it.
  const value = { '\u{FF61}': 2, '\u{1F600}': 1, a: 0 };

  test('keys are ordered by UTF-16 code unit, not by code point', () => {
    expect(serializeCanonicalJson(value)).toBe('{"a":0,"\u{1F600}":1,"\u{FF61}":2}');
    expect(compareCodeUnits('\u{1F600}', '\u{FF61}')).toBe(-1);
  });

  test('the argument digest and the agent store take the same bytes', async () => {
    const { canonicalAgentJson } = await import('../src/agent-runtime/store-events');
    const { serializeSurfaceValue } = await import('../src/testing/surface-manifest');
    const bytes = serializeCanonicalJson(value);
    expect(canonicalAgentJson(value)).toBe(bytes);
    expect(serializeSurfaceValue(value)).toBe(bytes);
    expect(argumentsDigest(value)).toBe(
      argumentsDigest({ a: 0, '\u{1F600}': 1, '\u{FF61}': 2 }),
    );
  });

  test('integer-like keys are sorted like every other key', async () => {
    // An engine lists integer-like keys first, in numeric order, however they
    // were inserted — so a sorted copy of an object handed to JSON.stringify
    // comes back as {"9":…,"10":…}. The agent store's hashes and archives were
    // always taken in true string order ("10" < "9"); a tool call's arguments
    // with a numeric map in them must keep hashing to what 0.93 stored.
    const { canonicalAgentJson } = await import('../src/agent-runtime/store-events');
    const numeric = { a: 3, '9': 2, '10': 1, nested: [{ '2': 'b', '1': 'a' }] };
    const bytes = '{"10":1,"9":2,"a":3,"nested":[{"1":"a","2":"b"}]}';
    expect(serializeCanonicalJson(numeric)).toBe(bytes);
    expect(canonicalAgentJson(numeric)).toBe(bytes);
  });

  test('what JSON.stringify leaves out is left out, and holes read as null', () => {
    const holed: unknown[] = [1, undefined, () => 1];
    holed[4] = { b: undefined, c: null }; // index 3 stays a hole
    expect(serializeCanonicalJson(holed)).toBe('[1,null,null,null,{"c":null}]');
  });

  test('the agent store still refuses what is not JSON', async () => {
    const { canonicalAgentJson } = await import('../src/agent-runtime/store-events');
    expect(() => canonicalAgentJson({ a: undefined })).toThrow();
    expect(serializeCanonicalJson({ a: undefined })).toBe('{}');
  });
});
