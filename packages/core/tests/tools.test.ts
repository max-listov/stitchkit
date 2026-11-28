import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppError, defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { isAsyncIterable } from '../src/internal/typed';
import { mountAgent } from '../src/tools/agent';
import { adaptAiSdkMessages, safeJsonValue } from '../src/tools/agent-messages';
import {
  type AgentTool,
  defineAgentTool,
  finalizeAgentToolOutput,
  mountAgentTools,
} from '../src/tools/agent-tools';
import { buildMcpServer, mountMcp, validateMcpSchemas } from '../src/tools/mcp/mount';
import { collectTools, createToolRunner } from '../src/tools/mount';
import { defineRuntimeTool } from '../src/tools/runtime-tool';
import { createToolkit } from '../src/tools/toolkit';

const notesContract = defineContract(
  { prefix: 'notes' },
  {
    list: { method: 'GET', path: '/', desc: 'List notes', output: z.array(z.string()) },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create a note',
      input: z.object({ title: z.string() }),
      output: z.object({ id: z.string() }),
    },
  },
);
const notesService = implement(notesContract, {
  list: () => ['a'],
  create: () => ({ id: '1' }),
});

const badContract = defineContract(
  { prefix: 'bad' },
  {
    doThing: {
      method: 'POST',
      path: '/',
      desc: 'Has a schema JSON Schema cannot represent',
      input: z.object({ when: z.date() }),
    },
  },
);
const badService = implement(badContract, { doThing: () => undefined });

/** A service whose `send` tool has a non-object (discriminated-union) input. */
const unionContract = defineContract(
  { prefix: 'msg' },
  {
    send: {
      method: 'POST',
      path: '/',
      desc: 'Send a message',
      input: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('text'), text: z.string() }),
        z.object({ kind: z.literal('image'), url: z.string() }),
      ]),
    },
  },
);
const unionService = implement(unionContract, { send: () => undefined });

/** A service whose only endpoint is a multipart upload — HTTP-only, never a tool. */
const multipartContract = defineContract(
  { prefix: 'files' },
  {
    upload: {
      method: 'POST',
      path: '/',
      desc: 'Upload a file',
      multipart: { files: { file: {} } },
      output: z.object({ url: z.string() }),
    },
  },
);
const multipartService = implement(multipartContract, { upload: () => ({ url: 'x' }) });

/** Two services whose `get` methods both resolve to the tool name `get_item`. */
function collidingServices() {
  const make = (prefix: string) =>
    implement(
      defineContract(
        { prefix },
        {
          get: {
            method: 'GET',
            path: '/:id',
            desc: 'Get one',
            params: z.object({ id: z.string() }),
          },
        },
      ),
      { get: () => undefined },
    );
  return [make('item'), make('items')];
}

describe('validateMcpSchemas', () => {
  test('passes a clean service', () => {
    expect(() => validateMcpSchemas({ services: [notesService] })).not.toThrow();
  });

  test('throws on a schema not representable as JSON Schema', () => {
    expect(() => validateMcpSchemas({ services: [badService] })).toThrow('JSON Schema');
  });

  test('throws on a non-object (union) input — MCP needs an object', () => {
    expect(() => validateMcpSchemas({ services: [unionService] })).toThrow(
      'must be an object schema',
    );
  });

  test('warn policy does not throw', () => {
    expect(() => validateMcpSchemas({ services: [badService], policy: 'warn' })).not.toThrow();
  });

  test('skip policy does not throw', () => {
    expect(() => validateMcpSchemas({ services: [badService], policy: 'skip' })).not.toThrow();
  });

  test('throws on a cross-service tool-name collision', () => {
    expect(() => validateMcpSchemas({ services: collidingServices() })).toThrow(
      'Duplicate MCP tool name',
    );
  });

  test('a multipart-only service contributes no tools', () => {
    expect(() => validateMcpSchemas({ services: [multipartService] })).not.toThrow();
  });
});

describe('mountMcp', () => {
  test('registers a clean service without throwing', () => {
    const server = new McpServer({ name: 't', version: '1' });
    expect(() =>
      mountMcp(server, notesService, { access: { open: 'local-operator' } }),
    ).not.toThrow();
  });

  test('throws (default policy) on an incompatible schema', () => {
    const server = new McpServer({ name: 't', version: '1' });
    expect(() => mountMcp(server, badService, { access: { open: 'local-operator' } })).toThrow(
      'JSON Schema',
    );
  });

  test('throws (default policy) on a non-object input', () => {
    const server = new McpServer({ name: 't', version: '1' });
    expect(() =>
      mountMcp(server, unionService, { access: { open: 'local-operator' } }),
    ).toThrow('must be an object schema');
  });

  test('skip policy drops the tool without throwing', () => {
    const server = new McpServer({ name: 't', version: '1' });
    expect(() =>
      mountMcp(server, badService, {
        access: { open: 'local-operator' },
        schemaValidation: { policy: 'skip' },
      }),
    ).not.toThrow();
  });

  test('throws when an extend field collides with a contract field', () => {
    const server = new McpServer({ name: 't', version: '1' });
    expect(() =>
      mountMcp(server, notesService, {
        access: { open: 'local-operator' },
        extend: { schema: { title: z.string() }, resolve: () => ({}) },
      }),
    ).toThrow('extend conflict');
  });
});

describe('buildMcpServer', () => {
  test('forwards extend to mountMcp (batteries-path reaches ToolExtend)', () => {
    // extend was not threaded into buildMcpServer, so createMcpHandler could not
    // add a tool arg. If it now reaches mountMcp → collectTools, a field that
    // collides with the contract throws — proving the passthrough.
    expect(() =>
      buildMcpServer(
        {
          access: { open: 'local-operator' },
          serverInfo: { name: 't', version: '1' },
          services: [notesService],
          extend: { schema: { title: z.string() }, resolve: () => ({}) },
        },
        undefined,
      ),
    ).toThrow('extend conflict');
  });
});

describe('mountAgent', () => {
  test('accepts a single service', () => {
    const tools = mountAgent(notesService, { access: { open: 'local-operator' } });
    expect(Object.keys(tools).sort()).toEqual(['create_note', 'list_notes']);
  });

  test('accepts an array of services', () => {
    const tools = mountAgent([notesService], { access: { open: 'local-operator' } });
    expect(Object.keys(tools).length).toBe(2);
  });

  test('accepts a non-object (union) input — the agent surface supports unions', () => {
    expect(() =>
      mountAgent(unionService, { access: { open: 'local-operator' } }),
    ).not.toThrow();
    expect(
      Object.keys(mountAgent(unionService, { access: { open: 'local-operator' } })),
    ).toEqual(['send_msg']);
  });

  test('a multipart endpoint never becomes a tool', () => {
    expect(
      Object.keys(mountAgent(multipartService, { access: { open: 'local-operator' } })),
    ).toEqual([]);
  });

  test('throws on a cross-service tool-name collision', () => {
    expect(() =>
      mountAgent(collidingServices(), { access: { open: 'local-operator' } }),
    ).toThrow('Duplicate agent tool name');
  });

  test('adaptAiSdkMessages preserves AI SDK image parts, untagged file data, and legacy/content tool outputs', () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71]);
    const adapted = adaptAiSdkMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect these' },
          { type: 'image', image: pngBytes, mediaType: 'image/png' },
          { type: 'image', image: 'data:image/webp;base64,UklGRg==' },
          {
            type: 'file',
            data: new URL('https://example.com/spec.pdf'),
            mediaType: 'application/pdf',
            filename: 'spec.pdf',
          },
          { type: 'file', data: 'aGVsbG8=', mediaType: 'text/plain' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Calling tool' },
          { type: 'file', data: pngBytes, mediaType: 'image/png' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'view', input: { id: 1 } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'view',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'caption' },
                { type: 'image-data', data: 'AQID', mediaType: 'image/png' },
                {
                  type: 'file-url',
                  url: 'https://example.com/doc.pdf',
                  mediaType: 'application/pdf',
                },
              ],
            },
          },
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'legacy',
            result: { ok: true },
          },
        ],
      },
    ]);

    expect(adapted).toHaveLength(3);
    expect(adapted[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect these' },
        { type: 'file', data: { type: 'data', data: pngBytes }, mediaType: 'image/png' },
        { type: 'file', data: { type: 'data', data: 'UklGRg==' }, mediaType: 'image/webp' },
        {
          type: 'file',
          data: { type: 'url', url: new URL('https://example.com/spec.pdf') },
          mediaType: 'application/pdf',
          filename: 'spec.pdf',
        },
        { type: 'file', data: { type: 'data', data: 'aGVsbG8=' }, mediaType: 'text/plain' },
      ],
    });
    expect(adapted[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Calling tool' },
        { type: 'file', data: { type: 'data', data: pngBytes }, mediaType: 'image/png' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'view', input: { id: 1 } },
      ],
    });
    expect(adapted[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'view',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'caption' },
              { type: 'file', data: { type: 'data', data: 'AQID' }, mediaType: 'image/png' },
              {
                type: 'file',
                data: {
                  type: 'url',
                  url: new URL('https://example.com/doc.pdf'),
                  originalUrl: 'https://example.com/doc.pdf',
                },
                mediaType: 'application/pdf',
              },
            ],
          },
        },
        {
          type: 'tool-result',
          toolCallId: 'c2',
          toolName: 'legacy',
          output: { type: 'json', value: { ok: true } },
        },
      ],
    });
  });

  test('safeJsonValue guards cyclic structures, preserves shared DAG objects, and maps non-finite numbers to null', () => {
    const cyclicObj: Record<string, unknown> = { label: 'root' };
    cyclicObj.self = cyclicObj;
    expect(safeJsonValue(cyclicObj)).toEqual({ label: 'root', self: '[Circular]' });

    const nodeA: Record<string, unknown> = { name: 'a' };
    const nodeB: Record<string, unknown> = { name: 'b', a: nodeA };
    nodeA.b = nodeB;
    expect(safeJsonValue(nodeA)).toEqual({
      name: 'a',
      b: { name: 'b', a: '[Circular]' },
    });

    const cyclicArr: unknown[] = [1];
    cyclicArr.push(cyclicArr);
    expect(safeJsonValue(cyclicArr)).toEqual([1, '[Circular]']);

    // Negative control: shared non-cyclic DAG references are NOT marked circular.
    const shared = { id: 7, tag: 'ok' };
    expect(safeJsonValue({ first: shared, second: shared, list: [shared, shared] })).toEqual({
      first: { id: 7, tag: 'ok' },
      second: { id: 7, tag: 'ok' },
      list: [
        { id: 7, tag: 'ok' },
        { id: 7, tag: 'ok' },
      ],
    });

    // Non-finite numbers map to null (JSON-standard), while finite numbers remain numbers.
    expect(safeJsonValue(Number.NaN)).toBeNull();
    expect(safeJsonValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(safeJsonValue(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(
      safeJsonValue({
        finite: 42.5,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        negInf: Number.NEGATIVE_INFINITY,
        arr: [Number.NaN, Number.POSITIVE_INFINITY, 0, -1],
      }),
    ).toEqual({
      finite: 42.5,
      nan: null,
      inf: null,
      negInf: null,
      arr: [null, null, 0, -1],
    });

    // End-to-end through adaptAiSdkMessages with cyclic + NaN legacy tool result.
    const adapted = adaptAiSdkMessages([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c-cyc',
            toolName: 'inspect',
            result: { cycle: cyclicObj, score: Number.NaN },
          },
        ],
      },
    ]);
    expect(adapted).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c-cyc',
            toolName: 'inspect',
            output: {
              type: 'json',
              value: { cycle: { label: 'root', self: '[Circular]' }, score: null },
            },
          },
        ],
      },
    ]);
  });

  test('defineAgentTool uses input JSON Schema (supports .transform()/.default()) and enforces output schema (I9)', async () => {
    const transformed = defineAgentTool({
      description: 'Double numeric string',
      input: z.object({
        raw: z.string().transform((v) => Number(v)),
        mode: z.string().default('fast'),
      }),
      output: z.object({ doubled: z.number() }),
      execute: ({ raw }) =>
        // Extra property should be stripped by output schema validation.
        Object.assign({ doubled: raw * 2 }, { secret: 'strip-me' }),
    });

    expect(transformed.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        raw: { type: 'string' },
        mode: { type: 'string', default: 'fast' },
      },
    });
    const parsedInput = await transformed.parseInput?.({ raw: '21' });
    expect(parsedInput).toEqual({ ok: true, value: { raw: 21, mode: 'fast' } });
    const out = await transformed.execute?.(
      { raw: 21, mode: 'fast' },
      {
        toolCallId: 'c1',
        messages: [],
      },
    );
    expect(out).toEqual({ doubled: 42 });

    // Negative control: invalid output fails loudly.
    const broken = defineAgentTool({
      input: z.object({}),
      output: z.object({ count: z.number() }),
      execute: () => JSON.parse('{"count":"not-a-number"}'),
    });
    expect(() => broken.execute?.({}, { toolCallId: 'c2', messages: [] })).toThrow(
      'Tool output failed schema validation',
    );

    // Output schema with .transform() and .default(): execute returns z.input, validated output is z.output.
    const parsedOutputTool = defineAgentTool({
      input: z.object({ raw: z.string() }),
      output: z.object({
        n: z.string().transform(Number),
        d: z.boolean().default(true),
      }),
      execute: async ({ raw }) => ({ n: raw }),
    });
    const parsedOut = await parsedOutputTool.execute?.(
      { raw: '42' },
      { toolCallId: 'c-tr', messages: [] },
    );
    expect(parsedOut).toEqual({ n: 42, d: true });
    // Non-iterable defineAgentTool outputs are already validated once and never double-parsed on finalize.
    expect(finalizeAgentToolOutput(parsedOutputTool, parsedOut, false)).toEqual({
      n: 42,
      d: true,
    });
    // Spreading a defined tool (e.g. adding needsApproval) preserves the wrapped executor and must not double-parse .transform().
    const spreadOutputTool: AgentTool = { ...parsedOutputTool, needsApproval: true };
    const spreadOut = await spreadOutputTool.execute?.(
      { raw: '42' },
      { toolCallId: 'c-tr-spread', messages: [] },
    );
    expect(spreadOut).toEqual({ n: 42, d: true });
    expect(finalizeAgentToolOutput(spreadOutputTool, spreadOut, false)).toEqual({
      n: 42,
      d: true,
    });
    // Negative control: replacing execute with an unvalidated function re-enables finalization validation.
    const replacedExecuteTool: AgentTool = {
      ...parsedOutputTool,
      execute: () => ({ n: '99' }),
    };
    expect(finalizeAgentToolOutput(replacedExecuteTool, { n: '99' }, false)).toEqual({
      n: 99,
      d: true,
    });
    expect(() => finalizeAgentToolOutput(replacedExecuteTool, { n: 99 }, false)).toThrow(
      'Tool output failed schema validation',
    );
    // Spreading a mountAgentTools runtime tool with .transform() output also avoids double-parsing on finalize.
    let mountedOutputParses = 0;
    const mountedTransform = mountAgentTools({
      runtimeTools: [
        defineRuntimeTool({
          name: 'transform_mounted',
          description: 'Runtime tool with transformed output',
          identity: { serviceName: 'demo', action: 'transform', method: 'POST' },
          input: z.object({ value: z.number() }),
          output: z.object({
            n: z.number().transform((v) => {
              mountedOutputParses += 1;
              return v * 10;
            }),
          }),
          handler: ({ input }) => ({ n: input.value }),
        }),
      ],
      access: { open: 'local-operator' },
    });
    const mountedTool = mountedTransform.transform_mounted;
    expect(mountedTool).toBeDefined();
    if (mountedTool) {
      const spreadMounted: AgentTool = { ...mountedTool, needsApproval: true };
      const mountedOut = await spreadMounted.execute?.(
        { value: 17 },
        { toolCallId: 'c-mounted-spread', messages: [] },
      );
      expect(mountedOut).toEqual({ n: 170 });
      expect(finalizeAgentToolOutput(spreadMounted, mountedOut, false)).toEqual({ n: 170 });
      expect(mountedOutputParses).toBe(1);
    }

    // AsyncIterable: streams chunk 1 immediately BEFORE chunk 2 is produced (zero 1-chunk buffering lag),
    // and finalizeAgentToolOutput validates/strips the final value (including empty iterables and hand-built tools).
    const releaseSecond = Promise.withResolvers<void>();
    let producedSecond = false;
    const streaming = defineAgentTool({
      input: z.object({ valid: z.boolean() }),
      output: z.discriminatedUnion('done', [
        z.object({ done: z.literal(false), progress: z.number() }),
        z.object({ done: z.literal(true), value: z.number() }),
      ]),
      async *execute({ valid }) {
        yield { done: false, progress: 50 };
        await releaseSecond.promise;
        producedSecond = true;
        if (valid) {
          const finalChunk: { done: true; value: number } = { done: true, value: 7 };
          yield Object.assign(finalChunk, { extra: 'stripped' });
        } else {
          yield JSON.parse('{"done":true,"value":"bad"}');
        }
      },
    });
    const okStream = streaming.execute?.({ valid: true }, { toolCallId: 'c3', messages: [] });
    expect(isAsyncIterable(okStream)).toBe(true);
    if (isAsyncIterable(okStream)) {
      const iter = okStream[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first).toEqual({ done: false, value: { done: false, progress: 50 } });
      expect(producedSecond).toBe(false);
      releaseSecond.resolve();
      const second = await iter.next();
      expect(second.done).toBe(false);
      expect(producedSecond).toBe(true);
      expect(await iter.next()).toEqual({ done: true, value: undefined });
      expect(finalizeAgentToolOutput(streaming, second.value, true)).toEqual({
        done: true,
        value: 7,
      });
    }

    const badStream = streaming.execute?.(
      { valid: false },
      { toolCallId: 'c4', messages: [] },
    );
    expect(isAsyncIterable(badStream)).toBe(true);
    let lastBad: unknown;
    if (isAsyncIterable(badStream)) {
      for await (const chunk of badStream) {
        lastBad = chunk;
      }
    }
    expect(() => finalizeAgentToolOutput(streaming, lastBad, true)).toThrow(
      'Tool output failed schema validation',
    );

    // Hand-built AgentTool literal with outputSchema is validated on finalization too.
    const handBuilt: AgentTool = {
      inputSchema: { type: 'object', properties: {} },
      outputSchema: z.object({ count: z.string().transform(Number) }),
      execute: () => ({ count: '9' }),
    };
    expect(finalizeAgentToolOutput(handBuilt, { count: '9' }, false)).toEqual({ count: 9 });
    expect(() => finalizeAgentToolOutput(handBuilt, { count: 9 }, false)).toThrow(
      'Tool output failed schema validation',
    );
  });

  test('createToolkit().mountAgentTools supports single-argument config overload alongside services overload', async () => {
    const pingRuntime = defineRuntimeTool({
      name: 'ping_runtime',
      description: 'Ping runtime tool',
      identity: { serviceName: 'sys', action: 'ping', method: 'POST' },
      input: z.object({ msg: z.string() }),
      output: z.object({ echo: z.string(), role: z.string() }),
      handler: (ctx) => ({ echo: ctx.input.msg, role: String(ctx.role) }),
    });
    const toolkit = createToolkit<{ role: string }>();
    const singleArg = toolkit.mountAgentTools({
      context: { role: 'admin' },
      runtimeTools: [pingRuntime],
      access: { open: 'local-operator' },
    });
    expect(Object.keys(singleArg)).toEqual(['ping_runtime']);
    const result = await singleArg.ping_runtime?.execute?.(
      { msg: 'hi' },
      { toolCallId: 'tk-1', messages: [] },
    );
    expect(result).toEqual({ echo: 'hi', role: 'admin' });

    const withServices = toolkit.mountAgentTools(notesService, {
      context: { role: 'admin' },
      runtimeTools: [pingRuntime],
      access: { open: 'local-operator' },
    });
    expect(Object.keys(withServices).sort()).toEqual([
      'create_note',
      'list_notes',
      'ping_runtime',
    ]);
  });

  test('mountAgentTools honours extend, errorHint, coerceJsonArgs, flattenUnionInput, inputRecursionDepth, and inputNestingDepth', async () => {
    const tagTool = defineRuntimeTool({
      name: 'tag_items',
      description: 'Tag items',
      identity: { serviceName: 'tags', action: 'tag', method: 'POST' },
      input: z.object({ tags: z.array(z.string()) }),
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw new AppError('NOT_FOUND', { message: 'missing item', status: 404 });
      },
    });
    interface TreeNode {
      label: string;
      child?: TreeNode;
    }
    const TreeSchema: z.ZodType<TreeNode> = z.lazy(() =>
      z.object({ label: z.string(), child: TreeSchema.optional() }),
    );
    const deepTool = defineRuntimeTool({
      name: 'inspect_tree',
      description: 'Inspect recursive tree',
      identity: { serviceName: 'tree', action: 'inspect', method: 'POST' },
      input: z.object({
        root: TreeSchema,
        nested: z.object({ a: z.object({ b: z.object({ c: z.string() }) }) }),
      }),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });

    const mountedFlat = mountAgentTools([notesService, unionService], {
      access: { open: 'local-operator' },
      runtimeTools: [tagTool, deepTool],
      extend: {
        schema: { traceNote: z.string().optional() },
        resolve: () => ({}),
      },
      flattenUnionInput: true,
      coerceJsonArgs: false,
      inputRecursionDepth: 1,
      inputNestingDepth: 2,
      errorHint: (toolName, code) => `Try fixing ${toolName} (${code})`,
    });

    // flattenUnionInput flattens unionService's send_msg into an object schema; extend adds traceNote to contract tools.
    expect(mountedFlat.send_msg?.inputSchema.type).toBe('object');
    expect(
      Object.keys(
        (mountedFlat.create_note?.inputSchema.properties ?? {}) as Record<string, unknown>,
      ),
    ).toContain('traceNote');

    // inputRecursionDepth strips $ref/defs and inputNestingDepth caps deep nesting.
    const deepJson = JSON.stringify(mountedFlat.inspect_tree?.inputSchema);
    expect(deepJson).not.toContain('"$ref"');
    const nestedProp = (
      mountedFlat.inspect_tree?.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >
    )?.nested;
    const levelA = (nestedProp?.properties as Record<string, Record<string, unknown>>)?.a;
    expect(levelA?.properties).toBeUndefined();

    // coerceJsonArgs: false refuses JSON-encoded array strings with VALIDATION_ERROR + errorHint.
    await expect(
      mountedFlat.tag_items?.execute?.(
        { tags: '["a","b"]' },
        { toolCallId: 'c-nc', messages: [] },
      ),
    ).rejects.toThrow('Try fixing tag_items (VALIDATION_ERROR)');

    // errorHint attaches to handler failures as well.
    await expect(
      mountedFlat.tag_items?.execute?.({ tags: ['x'] }, { toolCallId: 'c-err', messages: [] }),
    ).rejects.toThrow('Try fixing tag_items (NOT_FOUND)');

    // Default coerceJsonArgs: true coerces JSON-encoded array strings before handler execution.
    const mountedCoerce = mountAgentTools({
      access: { open: 'local-operator' },
      runtimeTools: [tagTool],
      errorHint: (toolName, code) => `Hint:${toolName}:${code}`,
    });
    await expect(
      mountedCoerce.tag_items?.execute?.(
        { tags: '["a","b"]' },
        { toolCallId: 'c-co', messages: [] },
      ),
    ).rejects.toThrow('Hint:tag_items:NOT_FOUND');
  });
});

describe('createToolRunner — the shared mount machinery', () => {
  test('threads lifecycle.beforeHandle — a rejection blocks the call', async () => {
    const [mountable] = collectTools(notesService, 'AGENT', undefined);
    if (!mountable) throw new Error('expected a tool');
    const runner = createToolRunner({
      source: 'agent',
      lifecycle: {
        beforeHandle: () => {
          throw new AppError('FORBIDDEN', { message: 'denied', status: 403 });
        },
      },
    });
    const result = await runner(mountable, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FORBIDDEN');
  });

  test('static context cannot spoof source', async () => {
    let captured: unknown;
    const svc = implement(
      defineContract({ prefix: 'ping' }, { ping: { method: 'GET', path: '/', desc: 'Ping' } }),
      {
        ping: (ctx) => {
          captured = ctx.source;
        },
      },
    );
    const [mountable] = collectTools(svc, 'AGENT', undefined);
    if (!mountable) throw new Error('expected a tool');
    const runner = createToolRunner({
      lifecycle: {},
      source: 'agent',
      context: { source: 'mcp' },
    });
    await runner(mountable, {});
    expect(captured).toBe('agent');
  });
});

describe('MCP round-trip (in-memory transport)', () => {
  async function connect(server: McpServer): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  test('the official legacy codec adapts a non-object output to { result }', async () => {
    const server = new McpServer({ name: 't', version: '1' });
    mountMcp(server, notesService, { access: { open: 'local-operator' } });
    const client = await connect(server);
    const res = await client.callTool({ name: 'list_notes', arguments: {} });
    expect(res.structuredContent).toEqual({ result: ['a'] });
    await client.close();
  });

  test('lifecycle.beforeHandle blocks a tool call end-to-end through mountMcp', async () => {
    const server = new McpServer({ name: 't', version: '1' });
    mountMcp(server, notesService, {
      access: {
        gate: {
          beforeHandle: () => {
            throw new AppError('FORBIDDEN', { message: 'denied', status: 403 });
          },
        },
      },
    });
    const client = await connect(server);
    const res = await client.callTool({ name: 'list_notes', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('FORBIDDEN');
    await client.close();
  });
});
