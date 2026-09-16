/**
 * The framework's MCP output, read back by the framework's MCP client.
 *
 * Both halves are ours and nothing asserted that they agree, which is how a
 * stitchkit server became unusable by a stitchkit client: the mount emitted
 * draft-07 `definitions`, the SDK stamped 2020-12 on it, and the client obeyed
 * the stamp and could not resolve a single `#/definitions/...` pointer.
 */
import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { isRecord } from '../src/internal/typed';
import { implement } from '../src/server';
import { zodObjectFromJsonSchema } from '../src/tools/connections/runtime';
import { mountMcp } from '../src/tools/mcp';
import { buildToolPresentationSchema } from '../src/tools/presentation';

/** A recursive field — the shape that makes the emitter reach for `$ref`. */
const TreeNode: z.ZodType = z.lazy(() =>
  z.object({ name: z.string(), children: z.array(TreeNode) }),
);

async function serveInputSchema(input: z.ZodType): Promise<Record<string, unknown>> {
  const contract = defineContract(
    { prefix: 'tree' },
    { walk: { method: 'POST', path: '/', desc: 'Walk a tree', input } },
  );
  const server = new McpServer({ name: 'test', version: '1' });
  mountMcp(server, implement(contract, { walk: () => undefined }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'client', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  await client.close();
  const served = listed.tools[0]?.inputSchema;
  if (!isRecord(served)) throw new Error('no input schema was served');
  return served;
}

describe('a stitchkit MCP surface is readable by the stitchkit MCP client', () => {
  test('a recursive input schema converts back to Zod', async () => {
    const served = await serveInputSchema(z.object({ root: TreeNode }));
    const rebuilt = zodObjectFromJsonSchema(served);
    expect(Object.keys(rebuilt.shape)).toEqual(['root']);
  });

  test('the served document uses the definition keyword its own dialect declares', async () => {
    const served = await serveInputSchema(z.object({ root: TreeNode }));
    // The pin: either half may change layout, but not without the other.
    expect(String(served.$schema)).toContain('2020-12');
    expect(served.$defs).toBeDefined();
    expect(served.definitions).toBeUndefined();
    expect(JSON.stringify(served)).not.toContain('#/definitions/');
  });

  test('definitions are hoisted to the document root, not nested one level deeper', () => {
    const presentation = buildToolPresentationSchema({
      inputSchema: z.object({ root: TreeNode }),
    });
    const definitions = presentation.definitions;
    if (!isRecord(definitions)) throw new Error('expected a definitions block');
    // Every pointer resolves against the root in one step; a reader that only
    // registers top-level definitions finds all of them.
    for (const value of Object.values(definitions)) {
      expect(isRecord(value) && value.definitions).toBeUndefined();
    }
    expect(JSON.stringify(presentation)).not.toContain('/definitions/input/definitions/');
  });

  test('params and input keep their own definitions apart after the merge', () => {
    const presentation = buildToolPresentationSchema({
      paramsSchema: z.object({ left: TreeNode }),
      inputSchema: z.object({ right: TreeNode }),
    });
    const definitions = presentation.definitions;
    if (!isRecord(definitions)) throw new Error('expected a definitions block');
    const names = Object.keys(definitions).sort();
    expect(names.some((name) => name.startsWith('params'))).toBe(true);
    expect(names.some((name) => name.startsWith('input'))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(zodObjectFromJsonSchema(presentation).shape).sort()).toEqual([
      'left',
      'right',
    ]);
  });

  test('a document served by an older stitchkit mount still converts', () => {
    // Byte-for-byte the shape every mount emitted before this release: a
    // 2020-12 stamp over a nested draft-07 definitions block.
    const previouslyServed = {
      type: 'object',
      properties: { root: { $ref: '#/definitions/input/definitions/__schema0' } },
      required: ['root'],
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      definitions: {
        input: {
          type: 'object',
          properties: { root: { $ref: '#/definitions/input/definitions/__schema0' } },
          definitions: {
            __schema0: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                children: {
                  type: 'array',
                  items: { $ref: '#/definitions/input/definitions/__schema0' },
                },
              },
              required: ['name', 'children'],
            },
          },
        },
      },
    };
    const rebuilt = zodObjectFromJsonSchema(previouslyServed);
    expect(Object.keys(rebuilt.shape)).toEqual(['root']);
  });

  test('a document that declares draft-07 is left in its own dialect', () => {
    const draft07 = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { a: { $ref: '#/definitions/N' } },
      definitions: { N: { type: 'string' } },
    };
    const rebuilt = zodObjectFromJsonSchema(draft07);
    expect(Object.keys(rebuilt.shape)).toEqual(['a']);
  });
});
