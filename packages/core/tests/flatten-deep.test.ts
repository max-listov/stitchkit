import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';
import { flattenToolJsonSchema } from '../src/tools/flatten';
import { buildToolManifest } from '../src/tools/manifest';
import { collectTools } from '../src/tools/mount';
import { buildToolPresentationSchema } from '../src/tools/presentation';

function hasUnionKeyword(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasUnionKeyword);
  if (typeof node !== 'object' || node === null) return false;
  if ('oneOf' in node || 'anyOf' in node) return true;
  return Object.values(node).some(hasUnionKeyword);
}

const part = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), url: z.url() }),
]);
const contract = defineContract(
  { prefix: 'broadcast' },
  {
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create',
      input: z.object({ content: z.object({ parts: z.array(part) }) }),
    },
  },
);
const service = implement(contract, { create: () => undefined });

const divergentContract = defineContract(
  { prefix: 'divergent' },
  {
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create a divergent value',
      input: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('one'), value: z.string() }),
        z.object({ kind: z.literal('many'), value: z.array(z.string()) }),
      ]),
    },
  },
);
const divergentService = implement(divergentContract, { create: () => undefined });

describe('presentation flattening walks the JSON Schema graph', () => {
  test('nested discriminated unions stay intact by default', () => {
    const [tool] = collectTools(service, 'AGENT');
    if (!tool) throw new Error('expected tool');
    expect(hasUnionKeyword(tool.presentationSchema)).toBe(true);
  });

  test('nested discriminated unions become conservative object joins', () => {
    const [tool] = collectTools(service, 'AGENT', { flattenUnionInput: true });
    if (!tool) throw new Error('expected tool');
    expect(hasUnionKeyword(tool.presentationSchema)).toBe(false);
    const text = JSON.stringify(tool.presentationSchema);
    expect(text).toContain('Required if type = text');
    expect(text).toContain('Required if type = image');
  });

  test('the source Zod schema and generated document are immutable', () => {
    const before = JSON.stringify(z.toJSONSchema(part, { io: 'input' }));
    const [tool] = collectTools(service, 'AGENT', { flattenUnionInput: true });
    if (!tool) throw new Error('expected tool');
    expect(JSON.stringify(z.toJSONSchema(part, { io: 'input' }))).toBe(before);
    expect(Object.isFrozen(tool.presentationSchema)).toBe(true);
  });

  test('MCP and AGENT receive the same flattened presentation document', () => {
    const [mcp] = collectTools(divergentService, 'MCP', { flattenUnionInput: true });
    const [agent] = collectTools(divergentService, 'AGENT', { flattenUnionInput: true });
    if (!mcp || !agent) throw new Error('expected both tool transports');
    expect(mcp.presentationSchema).toEqual(agent.presentationSchema);
    expect(JSON.stringify(mcp.presentationSchema)).not.toContain('oneOf');
    expect(JSON.stringify(mcp.presentationSchema)).not.toContain('anyOf');
  });

  test('the manifest reuses the same flattened presentation document', () => {
    const [agent] = collectTools(divergentService, 'AGENT', { flattenUnionInput: true });
    const [manifest] = buildToolManifest({
      services: [divergentService],
      transport: 'AGENT',
      flattenUnionInput: true,
    });
    if (!agent || !manifest) throw new Error('expected tool and manifest entry');
    expect(manifest.inputSchema).toEqual(agent.presentationSchema);
  });

  test('tuple items and definition nodes are traversed without resolving references', () => {
    const source = {
      type: 'object',
      properties: {
        tuple: { type: 'array', prefixItems: [{ $ref: '#/$defs/operation' }] },
      },
      $defs: {
        operation: {
          oneOf: [
            {
              type: 'object',
              properties: { kind: { const: 'a' }, value: { type: 'string' } },
              required: ['kind', 'value'],
            },
            {
              type: 'object',
              properties: { kind: { const: 'b' }, count: { type: 'number' } },
              required: ['kind', 'count'],
            },
          ],
        },
      },
    };
    const snapshot = JSON.stringify(source);
    const flattened = flattenToolJsonSchema(source);
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(hasUnionKeyword(flattened)).toBe(false);
    expect(JSON.stringify(flattened)).toContain('#/$defs/operation');
  });

  test('params/input merging namespaces recursive root references', () => {
    const RecursiveInput: z.ZodType = z.lazy(() =>
      z.object({ name: z.string(), child: RecursiveInput.optional() }),
    );
    const presentation = buildToolPresentationSchema({
      paramsSchema: z.object({ tenantId: z.string() }),
      inputSchema: RecursiveInput,
      unrepresentable: 'throw',
    });
    const text = JSON.stringify(presentation);
    expect(presentation.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(text).toContain('"$ref":"#/definitions/input"');
    expect(text).toContain('"definitions":{"input"');
    expect(text).not.toContain('"$defs"');
    expect(text).not.toContain('"$ref":"#"');
  });
});
