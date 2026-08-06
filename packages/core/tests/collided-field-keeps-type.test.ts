/**
 * A collided field keeps its type.
 *
 * The incident: a field declared `.int().min(0)` in 8 of 14 operations was
 * advertised with a `description` and nothing else, so a model retried the same
 * string sixteen times against a live broadcast while its own reasoning said "I
 * need to pass numbers". Widening to `z.unknown()` threw away the one thing every
 * colliding variant provably agrees on. → ADR 0044.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { flattenDiscriminatedUnion } from '../src/tools/flatten';
import { toJsonSchema } from '../src/tools/json-schema';

type Flattenable = Parameters<typeof flattenDiscriminatedUnion>[0];

function advertised(union: Flattenable): Record<string, Record<string, unknown>> {
  const json: unknown = toJsonSchema(flattenDiscriminatedUnion(union), 'input', 'any');
  const props = (json as { properties?: Record<string, Record<string, unknown>> }).properties;
  return props ?? {};
}

describe('the incident', () => {
  const broadcast = z.discriminatedUnion('op', [
    z.object({
      op: z.literal('setText'),
      partIndex: z.number().int().min(0),
      text: z.string(),
    }),
    z.object({
      op: z.literal('setButton'),
      partIndex: z.number().int().min(0),
      buttonIndex: z.number().int().min(0),
    }),
    z.object({ op: z.literal('setMedia'), mediaIndex: z.number().int().min(0) }),
  ]);

  test('a field in several operations is advertised as a number, not as prose', () => {
    const props = advertised(broadcast);
    expect(props.partIndex?.type).toBe('integer');
    expect(props.partIndex?.minimum).toBe(0);
    // The one in a single operation always worked — it is the contrast that made
    // the defect look like model weakness rather than a schema bug.
    expect(props.mediaIndex?.type).toBe('integer');
  });

  test('the flat schema still accepts what the union accepts', () => {
    const flat = flattenDiscriminatedUnion(broadcast);
    expect(flat.safeParse({ op: 'setText', partIndex: 0, text: 'x' }).success).toBe(true);
    expect(flat.safeParse({ op: 'setMedia', mediaIndex: 3 }).success).toBe(true);
  });
});

describe('a hidden constraint costs the constraint, never the type', () => {
  test('a `.refine()` on one variant — type kept, refinement dropped', () => {
    const union = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), v: z.number().refine((n) => n > 100) }),
      z.object({ k: z.literal('b'), v: z.number() }),
    ]);
    expect(advertised(union).v?.type).toBe('number');
    // The invariant: one variant's hidden rule cannot reject another's value.
    expect(flattenDiscriminatedUnion(union).safeParse({ k: 'b', v: 1 }).success).toBe(true);
  });

  test('mutually exclusive refinements still leave a usable type', () => {
    const union = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), v: z.number().refine((n) => n > 100) }),
      z.object({ k: z.literal('b'), v: z.number().refine((n) => n < 10) }),
    ]);
    expect(advertised(union).v?.type).toBe('number');
    const flat = flattenDiscriminatedUnion(union);
    expect(flat.safeParse({ k: 'a', v: 500 }).success).toBe(true);
    expect(flat.safeParse({ k: 'b', v: 1 }).success).toBe(true);
  });

  test('`.trim()` is hidden AND mutating — it cannot reach a sibling value', () => {
    const union = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), s: z.string().trim() }),
      z.object({ k: z.literal('b'), s: z.string() }),
    ]);
    expect(advertised(union).s?.type).toBe('string');
    const parsed = flattenDiscriminatedUnion(union).safeParse({ k: 'b', s: '  keep  ' });
    expect(parsed.success).toBe(true);
    // Advertising variant a's schema verbatim would hand variant b's handler
    // a trimmed value it never asked for.
    if (parsed.success) expect((parsed.data as { s: string }).s).toBe('  keep  ');
  });

  test('a pipe advertises its input side — the output constraint is invisible', () => {
    const union = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), v: z.string().pipe(z.string().min(3)) }),
      z.object({ k: z.literal('b'), v: z.string() }),
    ]);
    expect(advertised(union).v?.type).toBe('string');
    expect(flattenDiscriminatedUnion(union).safeParse({ k: 'b', v: 'x' }).success).toBe(true);
  });

  test('a nested hidden check still costs only the constraint', () => {
    const union = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), o: z.object({ p: z.string().refine((v) => v === 'x') }) }),
      z.object({ k: z.literal('b'), o: z.object({ p: z.string() }) }),
    ]);
    expect(advertised(union).o?.type).toBe('object');
    expect(
      flattenDiscriminatedUnion(union).safeParse({ k: 'b', o: { p: 'anything' } }).success,
    ).toBe(true);
  });

  test('a `.catch()` on ONE side stays unknown — the variants disagree', () => {
    const union = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), n: z.number().catch(0) }),
      z.object({ k: z.literal('b'), n: z.number() }),
    ]);
    // One variant accepts junk (and substitutes 0); a `number` keyword would
    // advertise a rejection that variant does not make.
    expect(advertised(union).n?.type).toBeUndefined();
  });

  test('coercion on ONE side stays unknown', () => {
    const union = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), n: z.coerce.number() }),
      z.object({ k: z.literal('b'), n: z.number() }),
    ]);
    expect(advertised(union).n?.type).toBeUndefined();
    expect(flattenDiscriminatedUnion(union).safeParse({ k: 'a', n: '1' }).success).toBe(true);
  });

  test('coercion on BOTH sides keeps its type — that is the shape they share', () => {
    // Blanking this would trade a useful type for none and fix nothing: it is
    // what the field advertised before the collision rule existed.
    const union = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), n: z.coerce.number() }),
      z.object({ k: z.literal('b'), n: z.coerce.number() }),
    ]);
    expect(advertised(union).n?.type).toBe('number');
    // …and it still accepts what a coercing variant accepts.
    expect(flattenDiscriminatedUnion(union).safeParse({ k: 'a', n: '1' }).success).toBe(true);
  });

  test('a node JSON Schema cannot represent still fails the mount loudly', () => {
    // `z.date()` collided used to throw in `probeSchema`. Projecting it would
    // convert cleanly and ship a blank property — a silent version of a caught
    // error, which is worse than the error.
    const union = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), d: z.date().min(new Date(0)) }),
      z.object({ k: z.literal('b'), d: z.date() }),
    ]);
    expect(() => toJsonSchema(flattenDiscriminatedUnion(union), 'input')).toThrow();
  });
});

describe('variants that disagree can still agree on the kind', () => {
  const union = z.discriminatedUnion('op', [
    z.object({
      op: z.literal('a'),
      n: z.number().min(0),
      mode: z.enum(['x', 'y']),
      target: z.string(),
    }),
    z.object({
      op: z.literal('b'),
      n: z.number().min(5),
      mode: z.string(),
      target: z.number(),
    }),
  ]);

  test('two numbers bounded differently are still a number', () => {
    // The case that survived the first draft of the fix: a field that is a
    // number in every variant, reaching the model blank.
    expect(advertised(union).n?.type).toBe('number');
    expect(advertised(union).n?.minimum).toBeUndefined();
  });

  test('an enum against a free string is still a string', () => {
    expect(advertised(union).mode?.type).toBe('string');
  });

  test('genuinely different kinds stay unknown', () => {
    expect(advertised(union).target?.type).toBeUndefined();
  });

  test('the widened field still accepts every variant', () => {
    const flat = flattenDiscriminatedUnion(union);
    expect(flat.safeParse({ op: 'a', n: 0, mode: 'x', target: 's' }).success).toBe(true);
    expect(flat.safeParse({ op: 'b', n: 9, mode: 'free', target: 7 }).success).toBe(true);
  });
});

describe('the invariant does not depend on the order the variants were written', () => {
  /** Both orderings of the same pair must advertise the same thing. */
  function bothWays(
    hazard: z.ZodType,
    plain: z.ZodType,
  ): Array<{
    advertised: Record<string, unknown> | undefined;
    accepts: boolean;
    probe: unknown;
  }> {
    const probe = { k: 'b', n: '1' };
    const first = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), n: hazard }),
      z.object({ k: z.literal('b'), n: plain }),
    ]);
    const second = z.discriminatedUnion('k', [
      z.object({ k: z.literal('b'), n: plain }),
      z.object({ k: z.literal('a'), n: hazard }),
    ]);
    return [first, second].map((union) => ({
      advertised: advertised(union).n,
      accepts: flattenDiscriminatedUnion(union).safeParse(probe).success,
      probe,
    }));
  }

  test('a coercing sibling is seen whichever side it is declared on', () => {
    // `z.coerce.number()` accepts `"1"`; advertising `number` would reject it.
    const [a, b] = bothWays(
      z.number().refine((n) => n > 100),
      z.coerce.number(),
    );
    expect(a?.advertised?.type).toBeUndefined();
    expect(b?.advertised?.type).toBeUndefined();
    expect(a?.accepts).toBe(true);
    expect(b?.accepts).toBe(true);
  });

  test('a `.catch()` sibling is seen whichever side it is declared on', () => {
    const [a, b] = bothWays(
      z.number().refine((n) => n > 100),
      z.number().catch(0),
    );
    expect(a?.advertised?.type).toBeUndefined();
    expect(b?.advertised?.type).toBeUndefined();
  });

  test('a `.trim()` against a coercing sibling stays unknown both ways', () => {
    const [a, b] = bothWays(z.string().trim(), z.coerce.string());
    expect(a?.advertised?.type).toBeUndefined();
    expect(b?.advertised?.type).toBeUndefined();
  });
});

describe('nullability is part of the accepted set, not a constraint', () => {
  test('a nullable field stays nullable through the projection', () => {
    const union = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), n: z.number().min(0).nullable() }),
      z.object({ k: z.literal('b'), n: z.number().min(5).nullable() }),
    ]);
    // Dropping `null` here would advertise a rejection no variant makes.
    expect(flattenDiscriminatedUnion(union).safeParse({ k: 'a', n: null }).success).toBe(true);
    expect(flattenDiscriminatedUnion(union).safeParse({ k: 'b', n: 7 }).success).toBe(true);
  });

  test('nullability survives a hidden constraint too', () => {
    const union = z.discriminatedUnion('k', [
      z.object({
        k: z.literal('a'),
        n: z
          .number()
          .refine((n) => n > 100)
          .nullable(),
      }),
      z.object({ k: z.literal('b'), n: z.number().nullable() }),
    ]);
    const flat = flattenDiscriminatedUnion(union);
    expect(flat.safeParse({ k: 'b', n: null }).success).toBe(true);
    expect(flat.safeParse({ k: 'b', n: 1 }).success).toBe(true);
  });
});
