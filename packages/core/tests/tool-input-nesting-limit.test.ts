/**
 * `inputNestingDepth` keeps a tool's input document within a provider's nesting limit, counted as
 * that provider counts: a level per `properties → property` or `items` step, free branches, two
 * levels for a property named `items` or `properties`.
 */
import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { asSchema } from 'ai';
import { z } from 'zod';
import { defineContract, type RuntimeContext } from '../src/entrypoints/contract';
import { createImplement } from '../src/entrypoints/server';
import { buildSurfaceManifest } from '../src/entrypoints/testing';
import { buildToolManifest } from '../src/entrypoints/tools';
import { mountAgent } from '../src/entrypoints/tools/agent';
import { buildMcpServer } from '../src/entrypoints/tools/mcp';
import { serializeCanonicalJson } from '../src/internal/canonical-json';
import { buildToolPresentationSchema } from '../src/tools/schema/presentation';

/** An object chain: each name nests the next object under it; the last holds a string. */
function chain(names: readonly string[]): z.ZodType {
  let inner: z.ZodType = z.string();
  for (const name of [...names].reverse()) inner = z.object({ [name]: inner });
  return inner;
}

function present(schema: z.ZodType, limit?: number, opened: string[] = []) {
  return buildToolPresentationSchema({
    inputSchema: schema,
    ...(limit !== undefined && { inputNestingDepth: limit }),
    onInputNestingOpened: (path) => opened.push(path),
  });
}

const ten = Array.from({ length: 10 }, (_, index) => `f${index}`);

function chainValue(names: readonly string[]): unknown {
  let value: unknown = 'leaf';
  for (const name of [...names].reverse()) value = { [name]: value };
  return value;
}

describe('inputNestingDepth', () => {
  test('a document of exactly the limit is untouched', () => {
    const opened: string[] = [];
    expect(present(chain(ten), 10, opened)).toEqual(present(chain(ten)));
    expect(opened).toEqual([]);
  });

  test('a property named items costs two levels and opens the node whose step crosses the limit', () => {
    const names = ['items', ...ten.slice(1)];
    const opened: string[] = [];
    const document = present(chain(names), 10, opened);
    // items (2), f1 (3) … f8 (10): the object at f8 may stand, its step to f9 (11) may not.
    expect(opened).toEqual(['items.f1.f2.f3.f4.f5.f6.f7.f8']);
    let node: unknown = document;
    for (const name of names.slice(0, -1))
      node = (node as { properties: Record<string, unknown> }).properties[name];
    expect(node).toEqual({});
    // One level less is within the limit again.
    expect(present(chain(['items', ...ten.slice(2)]), 10)).toEqual(
      present(chain(['items', ...ten.slice(2)])),
    );
  });

  test('a value the authored schema accepts passes the limited document', () => {
    const names = ['items', ...ten.slice(1)];
    const document = present(chain(names), 10);
    const value = chainValue(names);
    expect(chain(names).safeParse(value).success).toBe(true);
    expect(z.fromJSONSchema(document).safeParse(value).success).toBe(true);
  });

  test('an array whose items would cross the limit is opened itself, never left without items', () => {
    const schema = z.object({
      a: z.object({ list: z.array(z.object({ deep: z.string() })) }),
    });
    // a (1), list (2): the array's items would be level 3.
    const opened: string[] = [];
    const document = present(schema, 2, opened);
    expect(opened).toEqual(['a.list']);
    const list = (document as { properties: { a: { properties: { list: unknown } } } })
      .properties.a.properties.list;
    expect(list).toEqual({});
  });

  test('free branches cost nothing and keep their own structure under the limit', () => {
    const schema = z.object({
      choice: z.union([
        z.object({ x: z.string() }),
        z.object({ y: z.object({ z: z.string() }) }),
      ]),
    });
    // choice (1), y (2), z (3): only the branch reaching level 3 opens, at y.
    const opened: string[] = [];
    present(schema, 2, opened);
    expect(opened).toEqual(['choice.y']);
  });

  test('refuses a limit that is not a positive integer', () => {
    for (const limit of [0, -1, 1.5])
      expect(() => present(chain(ten), limit)).toThrow(/positive integer/);
  });
});

describe('inputNestingDepth on every tool surface', () => {
  const deep = chain(['items', ...ten.slice(1)]);
  const shallow = z.object({ note: z.string() });
  const implement = createImplement<RuntimeContext>();
  const service = (toolLimit?: number) =>
    implement(
      defineContract(
        { prefix: 'lesson' },
        {
          put: {
            method: 'POST',
            path: '/put',
            desc: 'Put a lesson',
            input: deep,
            output: z.object({ ok: z.boolean() }),
            tool: {
              name: 'lesson_put',
              ...(toolLimit !== undefined && { inputNestingDepth: toolLimit }),
            },
          },
          note: {
            method: 'POST',
            path: '/note',
            desc: 'Leave a note',
            input: shallow,
            output: z.object({ ok: z.boolean() }),
            tool: { name: 'lesson_note' },
          },
        },
      ),
      { put: () => ({ ok: true }), note: () => ({ ok: true }) },
    );
  const deepest = (document: unknown) => reachOf(document);

  test('a tool declares its own nesting limit over the surface', () => {
    const surface = buildToolManifest({
      services: [service()],
      transport: 'AGENT',
      inputNestingDepth: 10,
    });
    expect(deepest(surface.find((tool) => tool.name === 'lesson_put')?.inputSchema)).toBe(10);
    const own = buildToolManifest({
      services: [service(8)],
      transport: 'AGENT',
      inputNestingDepth: 10,
    });
    expect(deepest(own.find((tool) => tool.name === 'lesson_put')?.inputSchema)).toBe(8);
    // Without either limit the document keeps its eleven levels.
    const none = buildToolManifest({ services: [service()], transport: 'AGENT' });
    expect(deepest(none.find((tool) => tool.name === 'lesson_put')?.inputSchema)).toBe(11);
    expect(() => service(0)).toThrow(/tool\.inputNestingDepth/);
  });

  test('mountAgent and the MCP surface advertise the limited document, typed checks included, and the handler still validates', async () => {
    const tools = mountAgent([service()], {
      access: { open: 'local-operator' },
      inputNestingDepth: 10,
    });
    const lesson = tools.lesson_put;
    if (!lesson || typeof lesson.execute !== 'function') throw new Error('missing lesson_put');
    expect(deepest(await asSchema(lesson.inputSchema).jsonSchema)).toBe(10);
    const names = ['items', ...ten.slice(1)];
    expect(
      await Reflect.apply(lesson.execute, undefined, [
        chainValue(names),
        { toolCallId: 'lesson', messages: [], abortSignal: undefined },
      ]),
    ).toEqual({ ok: true });

    // The open node is no untyped property to a strict surface: the limit declared it.
    const server = buildMcpServer({
      serverInfo: { name: 'nesting', version: '1.0.0' },
      services: [service()],
      access: { open: 'local-operator' },
      inputNestingDepth: 10,
      schemaValidation: { requireTypedProperties: true },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'nesting-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    expect(deepest(listed.tools.find((tool) => tool.name === 'lesson_put')?.inputSchema)).toBe(
      10,
    );
    await client.close();
  });
});

test('the surface manifest snapshots the limited document a surface advertises', () => {
  const implement = createImplement<RuntimeContext>();
  const lesson = (toolLimit?: number) =>
    implement(
      defineContract(
        { prefix: 'lesson' },
        {
          put: {
            method: 'POST',
            path: '/put',
            desc: 'Put a lesson',
            input: chain(['items', ...ten.slice(1)]),
            output: z.object({ ok: z.boolean() }),
            tool: {
              name: 'lesson_put',
              ...(toolLimit !== undefined && { inputNestingDepth: toolLimit }),
            },
          },
        },
      ),
      { put: () => ({ ok: true }) },
    );
  const unlimited = serializeCanonicalJson(
    buildSurfaceManifest({ toolSurfaces: { AGENT: { services: [lesson()] } } }),
  );
  const surface = serializeCanonicalJson(
    buildSurfaceManifest({
      toolSurfaces: { AGENT: { services: [lesson()], inputNestingDepth: 10 } },
    }),
  );
  const own = serializeCanonicalJson(
    buildSurfaceManifest({ toolSurfaces: { AGENT: { services: [lesson(10)] } } }),
  );
  expect(surface).not.toBe(unlimited);
  expect(own).toBe(surface);
});

/** The deepest level a document reaches, counted as the limit counts. */
function reachOf(document: unknown): number {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return 0;
  const node = document as Record<string, unknown>;
  let deepest = 0;
  const properties = node.properties;
  if (typeof properties === 'object' && properties !== null)
    for (const [name, child] of Object.entries(properties))
      deepest = Math.max(
        deepest,
        (name === 'items' || name === 'properties' ? 2 : 1) + reachOf(child),
      );
  if (typeof node.items === 'object' && node.items !== null)
    deepest = Math.max(deepest, 1 + reachOf(node.items));
  for (const key of ['anyOf', 'oneOf', 'allOf'])
    if (Array.isArray(node[key]))
      for (const branch of node[key] as unknown[])
        deepest = Math.max(deepest, reachOf(branch));
  return deepest;
}
