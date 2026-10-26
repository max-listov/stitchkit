/**
 * A tuple in a tool's input reaches an MCP client as a 2020-12 schema.
 *
 * The presentation is built in draft-07, where a tuple is an `items` list. The
 * MCP SDK stamps 2020-12 on what it is handed, and a client that validates tool
 * schemas in that dialect (Claude's MCP loader does) refuses an `items` list —
 * "must be object,boolean" — and drops the tool without a word to the server.
 */
import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import Ajv2020 from 'ajv/dist/2020';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { isRecord } from '../src/internal/typed';
import { withDraft2020Keywords } from '../src/json-schema/dialect';
import { zodObjectFromJsonSchema } from '../src/tools/connections/runtime';
import { mountMcp } from '../src/tools/mcp/mount';
import { buildToolPresentationSchema } from '../src/tools/schema/presentation';

const Channel = z.number().int().min(0).max(255);
const LightInput = z.object({
  rgb: z.tuple([Channel, Channel, Channel]),
  points: z.array(z.tuple([z.number(), z.number()])).optional(),
  tagged: z.tuple([z.string()], z.boolean()).optional(),
});

async function serveInputSchema(input: z.ZodType): Promise<Record<string, unknown>> {
  const contract = defineContract(
    { prefix: 'lights' },
    { set: { method: 'POST', path: '/', desc: 'Set a light', input } },
  );
  const server = new McpServer({ name: 'test', version: '1' });
  mountMcp(server, implement(contract, { set: () => undefined }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'client', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  await client.close();
  const served = listed.tools[0]?.inputSchema;
  if (!isRecord(served)) throw new Error('no input schema was served');
  return served;
}

/** Every `items` value in schema position, wherever it sits. */
function itemsLists(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(itemsLists);
  if (!isRecord(value)) return [];
  const own = Array.isArray(value.items) ? [value.items] : [];
  return [...own, ...Object.values(value).flatMap(itemsLists)];
}

const metaValidator = new Ajv2020({ strict: false });

describe('a tuple-typed MCP tool is a valid 2020-12 schema', () => {
  test('the served document passes 2020-12 schema validation and has no items list', async () => {
    const served = await serveInputSchema(LightInput);
    expect(String(served.$schema)).toContain('2020-12');
    expect(metaValidator.validateSchema(served)).toBe(true);
    expect(itemsLists(served)).toEqual([]);
  });

  test('control: the draft-07 presentation under a 2020-12 stamp is refused as Claude refuses it', () => {
    const presentation = buildToolPresentationSchema({ inputSchema: LightInput });
    const stamped = {
      ...presentation,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    };
    expect(metaValidator.validateSchema(stamped)).toBe(false);
    expect(metaValidator.errorsText()).toContain(
      '/properties/rgb/items must be object,boolean',
    );
  });

  test('positional meaning survives: arity, order and rest are enforced on the served schema', async () => {
    const served = await serveInputSchema(LightInput);
    const validate = metaValidator.compile(served);
    expect(validate({ rgb: [1, 2, 3], points: [[0, 1]], tagged: ['a', true, false] })).toBe(
      true,
    );
    expect(validate({ rgb: [1, 2] })).toBe(false);
    expect(validate({ rgb: [1, 2, 3, 4] })).toBe(false);
    expect(validate({ rgb: [1, 2, 300] })).toBe(false);
    expect(validate({ rgb: [1, 2, 3], tagged: ['a', 'not-a-boolean'] })).toBe(false);
  });

  test('the stitchkit client reads the served tuple back with the same meaning', async () => {
    const rebuilt = zodObjectFromJsonSchema(await serveInputSchema(LightInput));
    expect(rebuilt.safeParse({ rgb: [1, 2, 3] }).success).toBe(true);
    expect(rebuilt.safeParse({ rgb: [1, 2] }).success).toBe(false);
    expect(rebuilt.safeParse({ rgb: [1, 2, 3, 4] }).success).toBe(false);
  });

  test('the client reconciles an older server that served a draft-07 tuple under 2020-12', () => {
    const presentation = buildToolPresentationSchema({ inputSchema: LightInput });
    const rebuilt = zodObjectFromJsonSchema({
      ...presentation,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    });
    expect(rebuilt.safeParse({ rgb: [1, 2, 3] }).success).toBe(true);
    expect(rebuilt.safeParse({ rgb: [1, 2, 3, 4] }).success).toBe(false);
  });
});

describe('the 2020-12 rewrite follows schema keywords only', () => {
  test('values and property names called "items" are left as written', () => {
    const schema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: [{ type: 'string' }], additionalItems: false },
        list: { type: 'array', items: { type: 'string' }, default: { items: [1, 2] } },
      },
      examples: [{ items: ['x'] }],
    };
    expect(withDraft2020Keywords(schema)).toEqual({
      type: 'object',
      properties: {
        items: { type: 'array', prefixItems: [{ type: 'string' }], items: false },
        list: { type: 'array', items: { type: 'string' }, default: { items: [1, 2] } },
      },
      examples: [{ items: ['x'] }],
    });
  });

  test('a tuple without a rest keyword keeps an open tail, as draft-07 meant', () => {
    expect(withDraft2020Keywords({ type: 'array', items: [{ type: 'string' }] })).toEqual({
      type: 'array',
      prefixItems: [{ type: 'string' }],
    });
  });
});
