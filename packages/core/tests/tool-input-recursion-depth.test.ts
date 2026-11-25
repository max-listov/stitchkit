/**
 * A model-facing input document can carry no `$ref` at all.
 *
 * Zod writes a recursive schema (`z.lazy`, `z.json()`) as a definition that
 * refers to itself, and some model providers refuse such a document outright —
 * one tool with a reference cycle fails the whole request — while others accept
 * it but never read a definition hidden behind an `allOf: [{ $ref }]` wrapper.
 * `inputRecursionDepth` writes every reference out in place, unrolls each
 * recursive definition the declared number of levels and closes the last level
 * with an open node that accepts everything the definition accepts: the
 * presentation widens, it never refuses a value the contract accepts. Execution
 * still parses the contract's own recursive schema.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { asSchema } from 'ai';
import { z } from 'zod';
import { defineContract, type RuntimeContext } from '../src/entrypoints/contract';
import { createImplement } from '../src/entrypoints/server';
import {
  buildToolManifest,
  defineRuntimeTool,
  findUntypedProperties,
} from '../src/entrypoints/tools';
import { mountAgent } from '../src/entrypoints/tools/agent';
import {
  defineMcpClientConnection,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { createMcpHandler, validateMcpSchemas } from '../src/entrypoints/tools/mcp';
import { isRecord } from '../src/internal/typed';
import { zodObjectFromJsonSchema } from '../src/tools/connections/runtime';

interface Expression {
  field?: string;
  fn?: 'add' | 'sub' | 'div';
  args?: Expression[];
}

/** A union whose recursive branch requires a non-empty array of itself. */
const Expression: z.ZodType<Expression> = z.lazy(() =>
  z.union([
    z.object({ field: z.string().min(1) }),
    z.object({ fn: z.enum(['add', 'sub', 'div']), args: z.array(Expression).min(1) }),
  ]),
);

type Condition =
  | { source: 'tag'; tag: string }
  | { source: 'not'; condition: Condition }
  | { source: 'group'; logic: 'and' | 'or'; conditions: Condition[] };

/** A discriminated union with two back edges: a property and an array element. */
const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('tag'), tag: z.string() }),
    z.strictObject({ source: z.literal('not'), condition: Condition }),
    z.strictObject({
      source: z.literal('group'),
      logic: z.enum(['and', 'or']),
      conditions: z.array(Condition).min(1),
    }),
  ]),
);

const ComputeInput = z.object({ computed: Expression.describe('Formula') });
const SegmentInput = z.object({
  filter: z.strictObject({
    logic: z.enum(['and', 'or']),
    conditions: z.array(Condition).min(1),
  }),
});
/** `z.json()` as a property and inside a record. */
const ContentInput = z.object({
  value: z.json(),
  props: z.record(z.string(), z.json()),
});

const deepExpression = {
  computed: {
    fn: 'div',
    args: [
      { fn: 'sub', args: [{ field: 'a' }, { fn: 'add', args: [{ field: 'b' }] }] },
      { field: 'c' },
    ],
  },
};
const deepCondition = {
  filter: {
    logic: 'and',
    conditions: [
      {
        source: 'not',
        condition: {
          source: 'group',
          logic: 'or',
          conditions: [{ source: 'not', condition: { source: 'tag', tag: 'vip' } }],
        },
      },
    ],
  },
};
const deepContent = {
  value: { a: [1, { b: [{ c: { d: [null, true, 's'] } }] }] },
  props: { x: [[[1]]], y: { z: { w: [{}] } } },
};

const implement = createImplement<RuntimeContext>();

function recursiveService(computeTool: { inputRecursionDepth?: number } = {}) {
  const contract = defineContract(
    { prefix: 'recursive', scope: 'public' },
    {
      compute: {
        method: 'POST',
        path: '/compute',
        desc: 'Compute a formula',
        input: ComputeInput,
        output: z.object({ ok: z.boolean() }),
        tool: { name: 'compute_formula', ...computeTool },
      },
      segment: {
        method: 'POST',
        path: '/segment',
        desc: 'Create a segment',
        input: SegmentInput,
        output: z.object({ ok: z.boolean() }),
        tool: { name: 'segment_create' },
      },
      content: {
        method: 'POST',
        path: '/content',
        desc: 'Patch content',
        input: ContentInput,
        output: z.object({ ok: z.boolean() }),
        tool: { name: 'content_patch' },
      },
    },
  );
  return implement(contract, {
    compute: () => ({ ok: true }),
    segment: () => ({ ok: true }),
    content: () => ({ ok: true }),
  });
}

const cases = [
  { name: 'compute_formula', zod: ComputeInput, deep: deepExpression },
  { name: 'segment_create', zod: SegmentInput, deep: deepCondition },
  { name: 'content_patch', zod: ContentInput, deep: deepContent },
] as const;

/** Every key of every object in a JSON value, at any depth. */
function keysOf(value: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
    } else if (isRecord(node)) {
      for (const [key, child] of Object.entries(node)) {
        keys.add(key);
        walk(child);
      }
    }
  };
  walk(value);
  return keys;
}

function expectNoReferences(document: unknown): void {
  const keys = keysOf(document);
  expect(keys.has('$ref')).toBe(false);
  expect(keys.has('definitions')).toBe(false);
  expect(keys.has('$defs')).toBe(false);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`);
  return value;
}

/** How many levels of `Expression` the document writes out before its open node. */
function expressionLevels(document: Record<string, unknown>): number {
  let node = record(record(document.properties).computed);
  let levels = 0;
  while (Array.isArray(node.anyOf)) {
    levels += 1;
    const recursive = node.anyOf.map(record).find((branch) => {
      return isRecord(branch.properties) && 'args' in branch.properties;
    });
    if (!recursive) throw new Error('the recursive branch is missing');
    node = record(record(record(recursive.properties).args).items);
  }
  expect(node).toEqual({ type: 'object' });
  return levels;
}

function manifest(options: { inputRecursionDepth?: number; computeDepth?: number } = {}) {
  return buildToolManifest({
    services: [
      recursiveService(
        options.computeDepth === undefined
          ? {}
          : { inputRecursionDepth: options.computeDepth },
      ),
    ],
    transport: 'AGENT',
    flattenUnionInput: true,
    ...(options.inputRecursionDepth !== undefined && {
      inputRecursionDepth: options.inputRecursionDepth,
    }),
  });
}

function entry(entries: ReturnType<typeof manifest>, name: string): Record<string, unknown> {
  const found = entries.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found.inputSchema;
}

describe('inputRecursionDepth projects an input document without references', () => {
  test('without the option the recursive input keeps its reference cycle', () => {
    const entries = manifest();
    for (const { name } of cases) {
      const document = entry(entries, name);
      const keys = keysOf(document);
      expect(keys.has('$ref')).toBe(true);
      expect(keys.has('definitions')).toBe(true);
    }
  });

  test.each([1, 2])(
    'depth %i writes every reference out and still accepts every deeper value',
    (depth) => {
      const baseline = manifest();
      const entries = manifest({ inputRecursionDepth: depth });
      for (const { name, zod, deep } of cases) {
        const document = entry(entries, name);
        expectNoReferences(document);
        expect(findUntypedProperties(document)).toEqual(
          findUntypedProperties(entry(baseline, name)),
        );
        expect(findUntypedProperties(document)).toEqual([]);
        // The contract accepts the value, and so does every reader of the document.
        expect(zod.safeParse(deep).success).toBe(true);
        expect(z.fromJSONSchema(document).safeParse(deep).success).toBe(true);
        expect(zodObjectFromJsonSchema(document).safeParse(deep)).toMatchObject({
          success: true,
          data: deep,
        });
      }
      expect(expressionLevels(entry(entries, 'compute_formula'))).toBe(depth);
    },
  );

  test('the allOf wrapper around a described reference is written out too', () => {
    const document = entry(manifest({ inputRecursionDepth: 1 }), 'compute_formula');
    const computed = record(record(document.properties).computed);
    expect(computed.allOf).toBeUndefined();
    expect(computed.description).toBe('Formula');
    expect(Array.isArray(computed.anyOf)).toBe(true);
  });

  test('a tool declares its own depth over the surface depth', () => {
    const entries = manifest({ inputRecursionDepth: 1, computeDepth: 3 });
    expect(expressionLevels(entry(entries, 'compute_formula'))).toBe(3);
    const alone = manifest({ computeDepth: 2 });
    expect(expressionLevels(entry(alone, 'compute_formula'))).toBe(2);
    // Its neighbours keep the surface's answer.
    expect(keysOf(entry(alone, 'segment_create')).has('$ref')).toBe(true);
  });

  test('a depth that is not a positive integer is refused where it is declared', () => {
    for (const depth of [0, -1, 1.5, Number.NaN]) {
      expect(() => manifest({ inputRecursionDepth: depth })).toThrow(/inputRecursionDepth/);
      expect(() => recursiveService({ inputRecursionDepth: depth })).toThrow(
        /tool\.inputRecursionDepth/,
      );
    }
  });

  test('mountAgent advertises the projected document and executes the full schema', async () => {
    const tools = mountAgent([recursiveService()], {
      access: { open: 'local-operator' },
      flattenUnionInput: true,
      inputRecursionDepth: 1,
    });
    for (const { name, deep } of cases) {
      const tool = tools[name];
      if (!tool || typeof tool.execute !== 'function') throw new Error(`missing ${name}`);
      expectNoReferences(await asSchema(tool.inputSchema).jsonSchema);
      const result = await Reflect.apply(tool.execute, undefined, [
        deep,
        { toolCallId: name, messages: [], abortSignal: undefined },
      ]);
      expect(result).toEqual({ ok: true });
    }
  });
});

const Block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), url: z.string() }),
]);

function runtimeTools() {
  return [
    defineRuntimeTool({
      name: 'runtime_formula',
      description: 'Evaluate a formula',
      identity: { serviceName: 'runtime', action: 'formula', method: 'POST' },
      input: z.object({ computed: Expression, block: Block }),
      handler: () => undefined,
    }),
  ];
}

function listRequest(): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

async function listedSchemas(response: Response): Promise<Map<string, unknown>> {
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  const body = record(JSON.parse(data ?? text));
  const tools = record(body.result).tools;
  if (!Array.isArray(tools)) throw new Error('tools/list returned no tools');
  return new Map(tools.map((tool) => [String(record(tool).name), record(tool).inputSchema]));
}

describe('runtime tools take the same input projection as contract tools', () => {
  test('mountAgent projects a recursive runtime tool input', async () => {
    const tools = mountAgent([], {
      access: { open: 'local-operator' },
      runtimeTools: runtimeTools(),
      inputRecursionDepth: 1,
    });
    const tool = tools.runtime_formula;
    if (!tool) throw new Error('missing runtime tool');
    expectNoReferences(await asSchema(tool.inputSchema).jsonSchema);
  });

  test('the MCP handler lists runtime and contract inputs flattened and without references', async () => {
    const handler = createMcpHandler({
      access: { open: 'local-operator' },
      serverInfo: { name: 'recursive', version: '1' },
      auth: () => ({}),
      context: () => ({}),
      services: [recursiveService()],
      runtimeTools: runtimeTools(),
      flattenUnionInput: true,
      inputRecursionDepth: 1,
    });
    const schemas = await listedSchemas(await handler.fetch(listRequest()));
    await handler.close();
    for (const name of [
      'compute_formula',
      'segment_create',
      'content_patch',
      'runtime_formula',
    ]) {
      expectNoReferences(schemas.get(name));
    }
    const block = record(record(record(schemas.get('runtime_formula')).properties).block);
    expect(block.oneOf).toBeUndefined();
    expect(block.type).toBe('object');
  });

  test('the MCP handler lists a tool at its own depth on a surface that sets none', async () => {
    const handler = createMcpHandler({
      access: { open: 'local-operator' },
      serverInfo: { name: 'recursive', version: '1' },
      auth: () => ({}),
      context: () => ({}),
      services: [recursiveService({ inputRecursionDepth: 3 })],
    });
    const schemas = await listedSchemas(await handler.fetch(listRequest()));
    await handler.close();
    const compute = record(schemas.get('compute_formula'));
    expectNoReferences(compute);
    expect(expressionLevels(compute)).toBe(3);
    expect(keysOf(schemas.get('segment_create')).has('$ref')).toBe(true);
  });
});

describe('a tool discovered from a server', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  async function discovered(serverDepth?: number) {
    const received: unknown[] = [];
    const contract = defineContract(
      { prefix: 'remote', scope: 'public' },
      {
        compute: {
          method: 'POST',
          path: '/compute',
          desc: 'Compute a formula',
          input: ComputeInput,
          output: z.object({ ok: z.boolean() }),
          tool: { name: 'compute_formula' },
        },
      },
    );
    const service = implement(contract, {
      compute: ({ input }) => {
        received.push(input);
        return { ok: true };
      },
    });
    const handler = createMcpHandler({
      access: { open: 'local-operator' },
      serverInfo: { name: 'remote', version: '1' },
      auth: () => ({}),
      context: () => ({}),
      services: [service],
      ...(serverDepth !== undefined && { inputRecursionDepth: serverDepth }),
    });
    const server = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request) });
    stops.push(async () => {
      await server.stop(true);
      await handler.close();
    });
    const tools = await mountConnections([
      defineMcpClientConnection({
        name: 'remote',
        transport: { url: `http://127.0.0.1:${server.port}/mcp` },
        expose: ['AGENT'],
      }),
    ]);
    return { tools, received };
  }

  test('a served reference cycle is projected without references on the agent surface', async () => {
    const { tools, received } = await discovered();
    const mounted = mountAgent([], {
      access: { open: 'local-operator' },
      runtimeTools: tools,
      inputRecursionDepth: 1,
    });
    const [name, tool] = Object.entries(mounted)[0] ?? [];
    if (!name || !tool || typeof tool.execute !== 'function') throw new Error('no tool');
    expectNoReferences(await asSchema(tool.inputSchema).jsonSchema);
    await Reflect.apply(tool.execute, undefined, [
      deepExpression,
      { toolCallId: 'call', messages: [], abortSignal: undefined },
    ]);
    expect(received).toEqual([deepExpression]);
  });

  test('a served projected document lets a deeper value through to the server', async () => {
    const { tools, received } = await discovered(1);
    const mounted = mountAgent([], {
      access: { open: 'local-operator' },
      runtimeTools: tools,
    });
    const [, tool] = Object.entries(mounted)[0] ?? [];
    if (!tool || typeof tool.execute !== 'function') throw new Error('no tool');
    expectNoReferences(await asSchema(tool.inputSchema).jsonSchema);
    await Reflect.apply(tool.execute, undefined, [
      deepExpression,
      { toolCallId: 'call', messages: [], abortSignal: undefined },
    ]);
    expect(received).toEqual([deepExpression]);
  });
});

test('the typed-property refusal says when z.json() needs the projection', () => {
  const contract = defineContract(
    { prefix: 'loose', scope: 'public' },
    {
      put: {
        method: 'POST',
        path: '/',
        desc: 'Store',
        input: z.object({ value: z.any().describe('Anything') }),
        output: z.object({ ok: z.boolean() }),
      },
    },
  );
  const service = implement(contract, { put: () => ({ ok: true }) });
  expect(() =>
    validateMcpSchemas({ services: [service], requireTypedProperties: true }),
  ).toThrow(/z\.json\(\)[\s\S]*inputRecursionDepth/);
});
