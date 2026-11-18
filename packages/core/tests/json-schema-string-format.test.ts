/**
 * A format keeps its name through the one Zod → JSON Schema conversion.
 *
 * Zod writes a format followed by `.regex()` as patterns alone, and reads a
 * format it has no check for as nothing. A string restored from a served document
 * is both cases at once, so without the name written back every surface built
 * from a discovered tool — CLI help, a re-served MCP catalogue, an agent's tool
 * list — loses the format its server declared.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { toJsonSchema } from '../src/json-schema/json-schema';
import { zodObjectFromJsonSchema } from '../src/tools/connections/runtime';

const UUID_EXPRESSION = String(toJsonSchema(z.uuid(), 'input').pattern);

function field(schema: z.ZodType): Record<string, unknown> {
  return toJsonSchema(schema, 'input');
}

function reread(properties: Record<string, unknown>): unknown {
  return toJsonSchema(zodObjectFromJsonSchema({ type: 'object', properties }), 'input')
    .properties;
}

describe('a format keeps its name beside a pattern', () => {
  test('a served document reads back as it was served', () => {
    const served = toJsonSchema(
      z.object({
        key: z.uuid(),
        strict: z.uuidv4(),
        mail: z.email(),
        at: z.iso.datetime(),
        day: z.iso.date(),
        host: z.hostname(),
        address: z.ipv4(),
        link: z.url(),
        maybe: z.uuid().nullable(),
        list: z.array(z.email()),
      }),
      'input',
    );
    const once = toJsonSchema(zodObjectFromJsonSchema(served), 'input');
    expect(once.properties).toEqual(served.properties);
    expect(toJsonSchema(zodObjectFromJsonSchema(once), 'input').properties).toEqual(
      served.properties,
    );
  });

  test('a foreign document keeps the format and the pattern its author wrote', () => {
    const restored = reread({
      own: { type: 'string', format: 'uuid', pattern: '^[0-9a-f-]{36}$' },
      linked: { type: 'string', format: 'uri', pattern: '^https:' },
      bounded: { type: 'string', format: 'email', pattern: '@example\\.com$', maxLength: 64 },
    });
    expect(restored).toEqual({
      own: { type: 'string', format: 'uuid', pattern: '^[0-9a-f-]{36}$' },
      linked: { type: 'string', format: 'uri', pattern: '^https:' },
      bounded: { type: 'string', format: 'email', pattern: '@example\\.com$', maxLength: 64 },
    });
  });

  test('a format Zod has no check for is written back as the server spelled it', () => {
    expect(
      reread({
        clock: { type: 'string', format: 'time' },
        relative: { type: 'string', format: 'uri-reference' },
        mailbox: { type: ['string', 'null'], format: 'idn-email' },
        pointer: { type: 'string', format: 'json-pointer', pattern: '^/' },
        word: { type: 'string', format: 'ticket', description: 'A ticket' },
        wide: { type: 'integer', format: 'int64' },
        items: { type: 'array', items: { type: 'string', format: 'iri' } },
      }),
    ).toMatchObject({
      clock: { type: 'string', format: 'time' },
      relative: { type: 'string', format: 'uri-reference' },
      mailbox: { anyOf: [{ type: 'string', format: 'idn-email' }, { type: 'null' }] },
      pointer: { type: 'string', format: 'json-pointer', pattern: '^\\/' },
      word: { type: 'string', format: 'ticket', description: 'A ticket' },
      wide: { type: 'integer', format: 'int64' },
      items: { type: 'array', items: { type: 'string', format: 'iri' } },
    });
  });

  test('a value that only looks like a schema is left as written', () => {
    const properties = {
      options: {
        type: 'object',
        default: { format: 'csv' },
        properties: { format: { type: 'string', enum: ['csv', 'json'] } },
      },
    };
    const restored = toJsonSchema(
      zodObjectFromJsonSchema({ type: 'object', properties }),
      'input',
    );
    expect(JSON.stringify(restored)).not.toContain('x-stitchkit');
    expect(restored.properties).toMatchObject({
      options: {
        default: { format: 'csv' },
        properties: { format: { enum: ['csv', 'json'] } },
      },
    });
  });

  test('the carrying annotation never reaches a written document', () => {
    const restored = toJsonSchema(
      zodObjectFromJsonSchema({
        type: 'object',
        properties: {
          a: { type: 'string', format: 'uuid', default: 'x' },
          b: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
          c: { $ref: '#/$defs/Id' },
          d: { $ref: '#/$defs/Id' },
        },
        $defs: { Id: { type: 'string', format: 'uuid', pattern: '^a' } },
      }),
      'input',
    );
    expect(JSON.stringify(restored)).not.toContain('x-stitchkit');
    expect(JSON.stringify(restored).match(/"format":"uuid"/g)?.length).toBe(3);
  });

  test('an authored format followed by a pattern is named when the name says it all', () => {
    expect(field(z.uuid().regex(/^a/))).toMatchObject({ format: 'uuid', pattern: '^a' });
    expect(field(z.string().check(z.email()).regex(/x$/))).toMatchObject({
      format: 'email',
      pattern: 'x$',
    });
    const several = field(z.uuid().regex(/^a/).regex(/b$/));
    expect(several.format).toBe('uuid');
    expect(several.allOf).toEqual([{ pattern: '^a' }, { pattern: 'b$' }]);
    expect(JSON.stringify(several)).not.toContain(UUID_EXPRESSION);
  });

  test('a check narrower or wider than its name keeps the document Zod wrote', () => {
    // The expression is the check: v4 only, where the name says any UUID.
    for (const schema of [
      z.uuidv4().regex(/^a/),
      z.guid().regex(/^a/),
      z.iso.datetime().regex(/^2/),
      z.email({ pattern: z.regexes.html5Email }).regex(/^a/),
    ]) {
      const written = field(schema);
      expect(written).toEqual(z.toJSONSchema(schema, { io: 'input' }));
      expect(written.format).toBeUndefined();
    }
  });

  test('strings Zod already writes whole are left alone', () => {
    expect(field(z.uuid())).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string',
      format: 'uuid',
      pattern: UUID_EXPRESSION,
    });
    expect(field(z.string().regex(/^a/))).toMatchObject({ type: 'string', pattern: '^a' });
    expect(field(z.string().regex(/^a/)).format).toBeUndefined();
    const two = field(z.string().regex(/^a/).regex(/b$/));
    expect(two.format).toBeUndefined();
    expect(two.allOf).toEqual([{ pattern: '^a' }, { pattern: 'b$' }]);
    expect(field(z.iso.time()).format).toBeUndefined();
  });

  test("a producer's own format word stays unwritten beside a pattern", () => {
    const json = field(z.string().startsWith('sk-').regex(/x$/));
    expect(json.format).toBeUndefined();
    expect(json.allOf).toEqual([{ pattern: '^sk-.*' }, { pattern: 'x$' }]);
    expect(field(z.nanoid().regex(/^a/)).format).toBeUndefined();
  });

  test('converting twice writes the same document and leaves the schema as it was', () => {
    const schema = z.object({ key: z.uuid().regex(/^a/), at: z.iso.datetime().optional() });
    const first = toJsonSchema(schema, 'input', 'throw', 'draft-07');
    expect(toJsonSchema(schema, 'input', 'throw', 'draft-07')).toEqual(first);
    expect(z.toJSONSchema(schema.shape.key).format).toBeUndefined();
  });
});
