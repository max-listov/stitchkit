/**
 * The advertised tool schema must never **remove** what the contract schema
 * would have kept or rejected. → ADR 0034.
 *
 * The advertised schema is not advertised-only: both transport SDKs parse the
 * caller's arguments with it and hand the handler the parsed result (MCP
 * `validateToolInput` → `parseResult.data`; the AI SDK's `zodSchema().validate`
 * → `result.value`). So an object rebuilt while deriving that schema must carry
 * its source's key policy — otherwise a `.strict()` violation is silently
 * deleted and the caller gets a success it should never have got.
 *
 * These tests deliberately go through a **real** `McpServer` ↔ `Client` pair and
 * through `ai`'s own `zodSchema`, not through `executeToolMethod`: the whole
 * defect lived in the SDK's parse step, which a direct-execute test (as in
 * `parity.test.ts`) cannot see.
 */

import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { asSchema } from 'ai';

import { z } from 'zod';
import { defineContract } from '../src/contract';
import { isRecord } from '../src/internal/typed';
import { implement } from '../src/server';
import { mountAgent } from '../src/tools/agent';
import { flattenUnionsDeep } from '../src/tools/flatten';
import { mountMcp } from '../src/tools/mcp';
import { collectTools } from '../src/tools/mount';

/** A strict object reused across the matrix — rejects any key but `ok`. */
const Strict = () => z.object({ ok: z.string() }).strict();
const DIRTY = { ok: 'x', payment_paid: 'DIRT' };

/** The node union from the reported case: a strict object inside a DU variant. */
const NodeUnion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('send'), outputs: Strict() }),
  z.object({ kind: z.literal('remove'), name: z.string() }),
]);

interface Captured {
  args: unknown;
}

/** Build a one-tool service; `captured.args` records what reached the handler. */
function serviceFor(input: z.ZodType, captured: Captured) {
  const contract = defineContract(
    { prefix: 'flow' },
    { patch: { method: 'POST', path: '/patch', desc: 'Patch a flow', input } },
  );
  return implement(contract, {
    patch: (ctx) => {
      captured.args = ctx.input;
      return undefined;
    },
  });
}

/** Call a tool through a real in-memory MCP round-trip. */
async function mcpCall(
  input: z.ZodType,
  args: Record<string, unknown>,
  flattenUnionInput = true,
): Promise<{ captured: Captured; result: Record<string, unknown> }> {
  const captured: Captured = { args: undefined };
  const server = new McpServer({ name: 't', version: '1' });
  mountMcp(server, serviceFor(input, captured), { flattenUnionInput });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  let result: Record<string, unknown>;
  try {
    const raw = await client.callTool({ name: 'patch_flow', arguments: args });
    result = isRecord(raw) ? raw : {};
  } catch (err) {
    // The SDK rejects a schema violation as a protocol error, before the tool
    // callback runs — the second of the two legitimate rejection channels.
    result = { protocolError: err instanceof Error ? err.message : String(err) };
  }
  await client.close();
  return { captured, result };
}

/** True when the call failed — either channel (tool result or protocol error). */
function rejected(result: Record<string, unknown>): boolean {
  return result.isError === true || typeof result.protocolError === 'string';
}

describe('MCP round-trip — a dirty key is never silently dropped', () => {
  test('strict object inside a flattened union variant rejects the unknown key', async () => {
    const input = z.object({ node: NodeUnion });
    const { captured, result } = await mcpCall(input, {
      kind: 'send',
      outputs: DIRTY,
      node: { kind: 'send', outputs: DIRTY },
    });
    expect(rejected(result)).toBe(true);
    // The regression this locks: previously the call SUCCEEDED with the key gone.
    expect(captured.args).toBeUndefined();
    expect(JSON.stringify(result)).toContain('payment_paid');
  });

  test('the same call with a clean payload still succeeds', async () => {
    const input = z.object({ node: NodeUnion });
    const { captured, result } = await mcpCall(input, {
      node: { kind: 'send', outputs: { ok: 'x' } },
    });
    expect(rejected(result)).toBe(false);
    expect(captured.args).toEqual({ node: { kind: 'send', outputs: { ok: 'x' } } });
  });

  test('top-level strict input rejects an undeclared top-level key', async () => {
    for (const flatten of [false, true]) {
      const { captured, result } = await mcpCall(
        z.object({ a: z.string() }).strict(),
        { a: 'x', dirt: 1 },
        flatten,
      );
      expect(rejected(result)).toBe(true);
      expect(captured.args).toBeUndefined();
    }
  });

  test('a loose object still delivers its extra keys to the handler', async () => {
    // Asserted on handler-received data, not on the advertised JSON Schema: the
    // agent path advertises `additionalProperties: false` regardless of policy.
    const { captured, result } = await mcpCall(
      z.object({ bag: z.object({ ok: z.string() }).loose() }),
      { bag: { ok: 'x', extra: 7 } },
    );
    expect(rejected(result)).toBe(false);
    expect(captured.args).toEqual({ bag: { ok: 'x', extra: 7 } });
  });

  test('a mixed strict/plain union forwards the dirty key so the contract can reject it', async () => {
    // One ordinary variant beside a strict one used to put the whole bug back:
    // the flat object went plain and deleted the key. Now it forwards, and the
    // rejection comes from the contract union — via stitchkit's own envelope.
    const mixed = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), a: z.string() }).strict(),
      z.object({ kind: z.literal('b'), b: z.string() }),
    ]);
    const { captured, result } = await mcpCall(z.object({ node: mixed }), {
      node: { kind: 'a', a: 'x', payment_paid: 'DIRT' },
    });
    expect(rejected(result)).toBe(true);
    expect(captured.args).toBeUndefined();
    expect(JSON.stringify(result)).toContain('payment_paid');
  });

  test('a strict violation fires no tool-call hook — the documented audit hole', async () => {
    // Breaking consequence promised by ADR 0034 / the CHANGELOG: the SDK rejects
    // before the callback runs, so the call is not logged at all. Pinned so the
    // promise cannot silently drift.
    const fired: string[] = [];
    const captured: Captured = { args: undefined };
    const server = new McpServer({ name: 't', version: '1' });
    mountMcp(server, serviceFor(z.object({ a: z.string() }).strict(), captured), {
      hooks: {
        beforeToolCall: (name) => {
          fired.push(`before:${name}`);
        },
        afterToolCall: (name) => {
          fired.push(`after:${name}`);
        },
      },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const raw = await client.callTool({ name: 'patch_flow', arguments: { a: 'x', dirt: 1 } });
    expect(isRecord(raw) && raw.isError).toBe(true);
    expect(JSON.stringify(raw)).toContain('-32602');
    expect(fired).toEqual([]);
    // A clean call still fires both hooks — the silence is specific to the reject.
    await client.callTool({ name: 'patch_flow', arguments: { a: 'x' } });
    expect(fired).toEqual(['before:patch_flow', 'after:patch_flow']);
    await client.close();
  });

  test('a prototype-polluting key inside a loose object never lands on the prototype', async () => {
    // `executeToolMethod`'s `isUnsafeKey` guard is top-level only, so this safety
    // now rests on Zod dropping `__proto__` when it applies a catchall.
    const { captured } = await mcpCall(
      z.object({ bag: z.object({ ok: z.string() }).loose() }),
      { bag: JSON.parse('{"ok":"x","__proto__":{"polluted":true}}') },
    );
    expect(captured.args).toEqual({ bag: { ok: 'x' } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('flattenUnionsDeep — key policy survives every position it walks', () => {
  const positions: Array<[string, z.ZodType, unknown]> = [
    ['plain nested', z.object({ f: Strict() }), { f: DIRTY }],
    ['optional', z.object({ f: Strict().optional() }), { f: DIRTY }],
    ['nullable', z.object({ f: Strict().nullable() }), { f: DIRTY }],
    ['default', z.object({ f: Strict().default({ ok: 'a' }) }), { f: DIRTY }],
    ['array item', z.object({ f: z.array(Strict()) }), { f: [DIRTY] }],
    ['record value', z.object({ f: z.record(z.string(), Strict()) }), { f: { k: DIRTY } }],
    ['union member', z.object({ f: z.union([Strict(), z.string()]) }), { f: DIRTY }],
    // Carries `kind` on purpose: without it the rejection would be the
    // discriminator's `invalid_value`, which says nothing about key policy.
    [
      'discriminated-union variant',
      z.object({ f: NodeUnion }),
      { f: { kind: 'send', outputs: DIRTY } },
    ],
    // `z.intersection` is deliberately absent: Zod drops both sides' key policy
    // when it intersects objects, so that row cannot pass and no catchall copy can
    // fix it. → ADR 0034 "Not covered" + its own inbox task.
  ];

  for (const [name, schema, value] of positions) {
    test(`${name} — rejects rather than strips`, () => {
      expect(flattenUnionsDeep(schema).safeParse(value).success).toBe(false);
    });
  }

  test('a loose object in the same positions keeps its extra keys', () => {
    const loose = z.object({ f: z.object({ ok: z.string() }).loose() });
    const parsed = flattenUnionsDeep(loose).safeParse({ f: { ok: 'x', extra: 1 } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ f: { ok: 'x', extra: 1 } });
  });
});

describe('flattenDiscriminatedUnion — the flat object merges variant policies', () => {
  /** Parse `value` through the flattened form of a discriminated union. */
  const flatParse = (union: z.ZodDiscriminatedUnion, value: unknown) =>
    flattenUnionsDeep(union).safeParse(value);

  const strictA = z.object({ kind: z.literal('a'), a: z.string() }).strict();
  const strictB = z.object({ kind: z.literal('b'), b: z.string() }).strict();
  const plainB = z.object({ kind: z.literal('b'), b: z.string() });
  const looseB = z.object({ kind: z.literal('b'), b: z.string() }).loose();
  const typedB = z.object({ kind: z.literal('b'), b: z.string() }).catchall(z.string());

  test('every variant strict → the flat object rejects a key no variant declares', () => {
    const union = z.discriminatedUnion('kind', [strictA, strictB]);
    expect(flatParse(union, { kind: 'a', a: 'x', dirt: 1 }).success).toBe(false);
    // …but still accepts the union of ALL variant keys, so no variant becomes
    // unsatisfiable (the ADR 0033 superset invariant).
    expect(flatParse(union, { kind: 'a', a: 'x', b: 'y' }).success).toBe(true);
  });

  test('no variant strict → the flat object strips, exactly as every variant would', () => {
    const plainA = z.object({ kind: z.literal('a'), a: z.string() });
    const union = z.discriminatedUnion('kind', [plainA, plainB]);
    const parsed = flatParse(union, { kind: 'b', b: 'x', dirt: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ kind: 'b', b: 'x' });
  });

  test('MIXED strict + plain → loose, because plain would destroy the evidence', () => {
    // The flat object cannot tell which variant the caller meant. Stripping here
    // deletes the very key the strict sibling exists to reject — the original bug,
    // one ordinary variant away. It must forward and let the real union judge.
    const union = z.discriminatedUnion('kind', [strictA, plainB]);
    const dirtyOnStrictVariant = { kind: 'a', a: 'x', payment_paid: 'DIRT' };
    expect(union.safeParse(dirtyOnStrictVariant).success).toBe(false);
    const parsed = flatParse(union, dirtyOnStrictVariant);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(dirtyOnStrictVariant);
  });

  test("a sibling variant's default is never injected into the payload", () => {
    // Every flat field is advertised optional, so a surviving `.default()` would
    // materialise on EVERY call — adding variant B's field to a variant-A payload,
    // which the real union then rejects as an unrecognized key. A legal call must
    // survive the round trip through the advertised schema untouched.
    const union = z.discriminatedUnion('kind', [
      strictA,
      z.object({ kind: z.literal('b'), b: z.string().default('D') }).strict(),
    ]);
    const legal = { kind: 'a', a: 'x' };
    expect(union.safeParse(legal).success).toBe(true);
    const parsed = flatParse(union, legal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(legal);
      expect(union.safeParse(parsed.data).success).toBe(true);
    }
  });

  test('a loose variant makes the flat object loose — extras are never deleted', () => {
    const union = z.discriminatedUnion('kind', [strictA, looseB]);
    const parsed = flatParse(union, { kind: 'b', b: 'x', extra: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ kind: 'b', b: 'x', extra: 1 });
  });

  test('a typed catchall variant widens to loose rather than being copied', () => {
    // Copying `.catchall(z.string())` onto the flat object would reject a sibling
    // variant's differently-typed extra key; widening keeps every variant valid.
    const union = z.discriminatedUnion('kind', [strictA, typedB]);
    const parsed = flatParse(union, { kind: 'b', b: 'x', extra: 42 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ kind: 'b', b: 'x', extra: 42 });
  });
});

describe('the derived schema across mounts', () => {
  const captured: Captured = { args: undefined };

  test('agent transport — mountAgent advertises the policy the AI SDK validates with', async () => {
    // Goes through the real mount, then through the SDK's own validator: the AI
    // SDK calls `.validate` and hands the handler `parseResult.value`, so what
    // this rejects is what never reaches a handler.
    const tools = mountAgent(serviceFor(z.object({ node: NodeUnion }), captured), {
      flattenUnionInput: true,
    });
    const advertised = tools.patch_flow?.inputSchema;
    if (!advertised) throw new Error('expected the patch_flow tool');
    // `asSchema` is the exact normalization `doParseToolCall` applies before it
    // validates and hands the handler `parseResult.value`.
    const validator = asSchema(advertised);
    const dirty = await validator.validate?.({ node: { kind: 'send', outputs: DIRTY } });
    expect(dirty?.success).toBe(false);
    const clean = await validator.validate?.({
      node: { kind: 'send', outputs: { ok: 'x' } },
    });
    expect(clean?.success).toBe(true);
  });

  test('a strict input still admits the arguments a ToolExtend injects', () => {
    const [mountable] = collectTools(
      serviceFor(z.object({ a: z.string() }).strict(), captured),
      'MCP',
      { extend: { schema: { tenantId: z.string() }, resolve: () => ({}) } },
    );
    if (!mountable) throw new Error('expected a tool');
    expect(mountable.schema.safeParse({ tenantId: 't', a: 'x' }).success).toBe(true);
    expect(mountable.schema.safeParse({ tenantId: 't', a: 'x', dirt: 1 }).success).toBe(false);
  });

  test('a params-only strict schema keeps its policy (no rebuild at all)', () => {
    const contract = defineContract(
      { prefix: 'p' },
      {
        get: {
          method: 'GET',
          path: '/:id',
          desc: 'Get',
          params: z.object({ id: z.string() }).strict(),
        },
      },
    );
    const [mountable] = collectTools(implement(contract, { get: () => undefined }), 'MCP');
    if (!mountable) throw new Error('expected a tool');
    expect(mountable.schema.safeParse({ id: 'x', dirt: 1 }).success).toBe(false);
  });

  test('a catchall JSON Schema cannot represent degrades instead of failing the mount', () => {
    // `.catchall(z.date())` copied verbatim would throw in the JSON Schema probe
    // and, with the default `onIncompatibleSchema: 'throw'`, take the whole mount
    // down. It degrades to loose: representable, and still never deletes a key.
    const service = serviceFor(z.object({ a: z.string() }).catchall(z.date()), captured);
    const server = new McpServer({ name: 't', version: '1' });
    expect(() => mountMcp(server, service, { flattenUnionInput: true })).not.toThrow();
    const [mountable] = collectTools(service, 'MCP', { flattenUnionInput: true });
    if (!mountable) throw new Error('expected a tool');
    const parsed = mountable.schema.safeParse({ a: 'x', extra: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ a: 'x', extra: 1 });
  });

  test('a strict object is advertised as additionalProperties: false', async () => {
    const server = new McpServer({ name: 't', version: '1' });
    mountMcp(server, serviceFor(z.object({ node: NodeUnion }), captured), {
      flattenUnionInput: true,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    const schema = JSON.stringify(tools[0]?.inputSchema);
    expect(schema).toContain('"additionalProperties":false');
    await client.close();
  });
});
