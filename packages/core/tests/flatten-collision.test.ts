import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';
import { flattenUnionsDeep } from '../src/tools/flatten';
import { collectTools } from '../src/tools/mount';

/** True if a JSON Schema node contains `oneOf` / `anyOf` at any depth. */
function hasUnionKeyword(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasUnionKeyword);
  if (typeof node === 'object' && node !== null) {
    if ('oneOf' in node || 'anyOf' in node) return true;
    return Object.values(node).some(hasUnionKeyword);
  }
  return false;
}

const ref = z.object({ id: z.string() });

// The reported shape: parts[] is a DU where `media` is object in one variant,
// array in another (same key, different type).
const part = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), media: ref.optional() }),
  z.object({ kind: z.literal('mediaGroup'), media: z.array(ref) }),
]);

describe('flatten — same-key collisions stay satisfiable, zero anyOf', () => {
  test('K1 object-vs-array collision → unconstrained, no anyOf, accepts BOTH variants', () => {
    const flat = flattenUnionsDeep(part);
    const json = z.toJSONSchema(flat, { io: 'input' });
    expect(hasUnionKeyword(json)).toBe(false);
    // The advertised flat object must accept every original-valid value.
    expect(flat.safeParse({ kind: 'message', media: { id: 'a' } }).success).toBe(true);
    expect(flat.safeParse({ kind: 'mediaGroup', media: [{ id: 'a' }] }).success).toBe(true);
    // The original union still validates per-variant (the real check).
    expect(part.safeParse({ kind: 'message', media: { id: 'a' } }).success).toBe(true);
    expect(part.safeParse({ kind: 'mediaGroup', media: [{ id: 'a' }] }).success).toBe(true);
  });

  test('K2 enum/literal collision → widened enum (no anyOf), accepts both values', () => {
    const u = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), mode: z.enum(['fast']) }),
      z.object({ k: z.literal('b'), mode: z.enum(['slow']) }),
    ]);
    const flat = flattenUnionsDeep(u);
    expect(hasUnionKeyword(z.toJSONSchema(flat, { io: 'input' }))).toBe(false);
    expect(flat.safeParse({ k: 'a', mode: 'fast' }).success).toBe(true);
    expect(flat.safeParse({ k: 'b', mode: 'slow' }).success).toBe(true);
  });

  test('K3 different object shape → unconstrained, accepts both shapes', () => {
    const u = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), cfg: z.object({ x: z.string() }) }),
      z.object({ k: z.literal('b'), cfg: z.object({ y: z.number() }) }),
    ]);
    const flat = flattenUnionsDeep(u);
    expect(hasUnionKeyword(z.toJSONSchema(flat, { io: 'input' }))).toBe(false);
    expect(flat.safeParse({ k: 'a', cfg: { x: 's' } }).success).toBe(true);
    expect(flat.safeParse({ k: 'b', cfg: { y: 1 } }).success).toBe(true);
  });

  test('same-type key across variants stays a plain typed field (no redundant anyOf)', () => {
    const u = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), note: z.string() }),
      z.object({ k: z.literal('b'), note: z.string() }),
    ]);
    const flat = flattenUnionsDeep(u);
    const json = z.toJSONSchema(flat, { io: 'input' });
    expect(hasUnionKeyword(json)).toBe(false);
  });

  test('refine collision: a variant refinement never rejects another variant (JSON-invisible check)', () => {
    const u = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), v: z.string().refine((s) => s.length > 2) }),
      z.object({ k: z.literal('b'), v: z.string() }),
    ]);
    const flat = flattenUnionsDeep(u);
    expect(u.safeParse({ k: 'b', v: 'x' }).success).toBe(true); // original accepts
    expect(flat.safeParse({ k: 'b', v: 'x' }).success).toBe(true); // advertised must too

    // Two mutually-exclusive refines — both variants must stay producible.
    const u2 = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), n: z.number().refine((x) => x > 0) }),
      z.object({ k: z.literal('b'), n: z.number().refine((x) => x < 0) }),
    ]);
    const flat2 = flattenUnionsDeep(u2);
    expect(flat2.safeParse({ k: 'a', n: 5 }).success).toBe(true);
    expect(flat2.safeParse({ k: 'b', n: -5 }).success).toBe(true);
  });
});

describe('flatten — discriminator handling', () => {
  test('D1 multi-value literal discriminator keeps ALL values', () => {
    const u = z.discriminatedUnion('k', [
      z.object({ k: z.literal(['a', 'b']), x: z.string() }),
      z.object({ k: z.literal('c'), y: z.number() }),
    ]);
    const flat = flattenUnionsDeep(u);
    expect(flat.safeParse({ k: 'a', x: 's' }).success).toBe(true);
    expect(flat.safeParse({ k: 'b', x: 's' }).success).toBe(true);
    expect(flat.safeParse({ k: 'c', y: 1 }).success).toBe(true);
  });

  test('D2 non-string discriminator → left un-flattened (no crash, keeps union)', () => {
    const u = z.discriminatedUnion('k', [
      z.object({ k: z.literal(1), x: z.string() }),
      z.object({ k: z.literal(2), y: z.number() }),
    ]);
    // Must not throw; returns a usable schema (the union, unchanged).
    const flat = flattenUnionsDeep(u);
    expect(flat.safeParse({ k: 1, x: 's' }).success).toBe(true);
  });
});

describe('flatten — params + union input → single ZodObject (P2)', () => {
  const contract = defineContract(
    { prefix: 'broadcast' },
    {
      create: {
        method: 'POST',
        path: '/:botId',
        desc: 'Create broadcast',
        params: z.object({ botId: z.string() }),
        input: part,
        output: z.object({ id: z.string() }),
        expose: ['MCP', 'AGENT'],
      },
    },
  );
  const service = implement(contract, { create: () => ({ id: 'x' }) });

  test('a params + discriminated-union-input tool flattens to a ZodObject', () => {
    const [tool] = collectTools(service, 'AGENT', { flattenUnionInput: true });
    if (!tool) throw new Error('expected tool');
    expect(tool.schema).toBeInstanceOf(z.ZodObject);
    const json = z.toJSONSchema(tool.schema, { io: 'input' });
    expect(hasUnionKeyword(json)).toBe(false);
    // params key + union keys all present, all satisfiable.
    expect(
      tool.schema.safeParse({ botId: 'b1', kind: 'message', media: { id: 'a' } }).success,
    ).toBe(true);
  });
});

describe('flatten — deep coverage (P5)', () => {
  test('a discriminated union nested in a plain union flattens (DU member → object)', () => {
    const u = z.union([z.string(), part]);
    const flat = flattenUnionsDeep(u);
    // The plain union itself stays a union (no discriminator to flatten on), but
    // the DU member is replaced by a flat object — no nested discriminated union.
    expect(flat).toBeInstanceOf(z.ZodUnion);
    const opts = flat instanceof z.ZodUnion ? flat.def.options : [];
    expect(opts.some((o) => o instanceof z.ZodDiscriminatedUnion)).toBe(false);
    expect(opts.some((o) => o instanceof z.ZodObject)).toBe(true);
  });

  test('a discriminated union in a record value flattens', () => {
    const r = z.record(z.string(), part);
    const flat = flattenUnionsDeep(r);
    expect(hasUnionKeyword(z.toJSONSchema(flat, { io: 'input' }))).toBe(false);
  });
});
