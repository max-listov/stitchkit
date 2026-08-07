import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import { validateMcpSchemas } from '../src/tools/mcp';
import { createMcpHandler } from '../src/tools/mcp-handler';
import {
  findNonPortableFormats,
  PORTABLE_JSON_SCHEMA_FORMATS,
} from '../src/tools/portable-formats';

describe('findNonPortableFormats', () => {
  test('the baseline accepts standard JSON Schema formats implemented by ajv-formats', () => {
    for (const format of PORTABLE_JSON_SCHEMA_FORMATS) {
      expect(findNonPortableFormats({ type: 'string', format })).toEqual([]);
    }
  });

  test('reports custom formats with their exact nested paths', () => {
    const schema = {
      properties: {
        id: { type: 'string', format: 'cuid2' },
        rows: {
          type: 'array',
          items: { properties: { owner: { type: 'string', format: 'cuid' } } },
        },
      },
      anyOf: [{ properties: { token: { type: 'string', format: 'ulid' } } }],
    };

    expect(findNonPortableFormats(schema)).toEqual([
      { path: 'anyOf[0].token', format: 'ulid' },
      { path: 'id', format: 'cuid2' },
      { path: 'rows[].owner', format: 'cuid' },
    ]);
  });

  test('walks definition maps, tuples and conditional/composition branches', () => {
    const schema = {
      $defs: { Entity: { format: 'entity-id' } },
      prefixItems: [{ format: 'first-id' }],
      allOf: [{ then: { properties: { id: { format: 'conditional-id' } } } }],
      additionalProperties: { format: 'map-value' },
    };

    expect(findNonPortableFormats(schema)).toEqual([
      { path: '*', format: 'map-value' },
      { path: '$defs.Entity', format: 'entity-id' },
      { path: 'allOf[0].then.id', format: 'conditional-id' },
      { path: 'prefixItems[0]', format: 'first-id' },
    ]);
  });

  test('an explicit allowlist preserves and accepts a custom format', () => {
    const schema = { type: 'string', format: 'cuid2', pattern: '^[0-9a-z]+$' };
    expect(findNonPortableFormats(schema, ['cuid2'])).toEqual([]);
    expect(schema.format).toBe('cuid2');
    expect(schema.pattern).toBe('^[0-9a-z]+$');
  });
});

const portableContract = (
  input: z.ZodType,
  output: z.ZodType = z.object({ ok: z.boolean() }),
) =>
  defineContract(
    { prefix: 'entities' },
    {
      create: {
        method: 'POST',
        path: '/',
        desc: 'Create an entity',
        input: z.object({ payload: input }),
        output,
        expose: ['MCP'],
        toolName: 'entity_create',
      },
    },
  );

const portableService = (
  input: z.ZodType,
  output: z.ZodType = z.object({ ok: z.boolean() }),
) => implement(portableContract(input, output), { create: () => ({ ok: true }) });

describe('MCP portable-format policy', () => {
  test('z.cuid2 is rejected with tool, side, path and format', () => {
    expect(() =>
      validateMcpSchemas({
        services: [portableService(z.cuid2())],
        requirePortableFormats: true,
      }),
    ).toThrow(/entity_create.*input property "payload".*format "cuid2"/s);
  });

  test('the handler applies the same profile to its exact static surface', () => {
    const services = [portableService(z.object({ owners: z.array(z.cuid2()) }))];
    expect(() =>
      createMcpHandler({
        serverInfo: { name: 'test', version: '1' },
        auth: () => ({ id: 'u1' }),
        services,
        schemaValidation: { requirePortableFormats: true },
      }),
    ).toThrow(/entity_create.*payload\.owners\[\].*cuid2/s);
  });

  test('the handler validates fields added by ToolExtend', () => {
    expect(() =>
      createMcpHandler({
        serverInfo: { name: 'test', version: '1' },
        auth: () => ({ id: 'u1' }),
        services: [portableService(z.string())],
        extend: { schema: { tenantId: z.cuid2() }, resolve: () => ({ tenantId: 'x' }) },
        schemaValidation: { requirePortableFormats: true },
      }),
    ).toThrow(/entity_create.*input property "tenantId".*cuid2/s);
  });

  test('output formats are checked too', () => {
    const output = z.object({ id: z.ulid() });
    expect(() =>
      validateMcpSchemas({
        services: [portableService(z.string(), output)],
        requirePortableFormats: true,
      }),
    ).toThrow(/entity_create.*output property "id".*format "ulid"/s);
  });

  test('an explicit allowlist keeps the original advertised format', () => {
    expect(() =>
      validateMcpSchemas({
        services: [portableService(z.cuid2())],
        requirePortableFormats: true,
        allowFormats: ['cuid2'],
      }),
    ).not.toThrow();
  });
});
