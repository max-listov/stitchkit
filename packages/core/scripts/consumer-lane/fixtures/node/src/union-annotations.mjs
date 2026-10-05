import assert from 'node:assert/strict';
import { defineContract } from 'stitchkit/contract';
import { implement } from 'stitchkit/server';
import { buildToolManifest, collectTools } from 'stitchkit/tools';
import { z } from 'zod';

const one = 'ONE_FILE: one reference belongs to single.value.';
const many = 'TWO_TO_TEN: multiple references belong to group.value.';
const ref = z.object({ id: z.string().min(1) });
const part = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), value: ref.optional().describe(one) }),
  z.object({ kind: z.literal('group'), value: z.array(ref).min(2).max(10).describe(many) }),
  z.object({ kind: z.literal('marker'), note: z.string() }),
]);
const input = z.object({ content: z.object({ parts: z.array(part) }) });
const service = implement(
  defineContract(
    { prefix: 'annotation_probe' },
    {
      create: { method: 'POST', path: '/', desc: 'Annotation probe', input },
    },
  ),
  { create: () => undefined },
);
const [agent] = collectTools(service, 'AGENT', { flattenUnionInput: true });
const [mcp] = collectTools(service, 'MCP', { flattenUnionInput: true });
const [manifest] = buildToolManifest({
  services: [service],
  transport: 'AGENT',
  flattenUnionInput: true,
});
assert.ok(agent && mcp && manifest);
for (const schema of [
  agent.presentationSchema,
  mcp.presentationSchema,
  manifest.inputSchema,
]) {
  const field = schema.properties.content.properties.parts.items.properties.value;
  assert.ok(field.description.includes(`When kind = single: ${one}`));
  assert.ok(field.description.includes(`When kind = group: ${many}`));
  assert.ok(field.description.includes('Available if kind = single | group'));
  assert.ok(field.description.includes('Required if kind = group'));
  assert.ok(!field.description.includes('marker'));
  assert.equal(field.anyOf.length, 2);
  const array = field.anyOf.find((branch) => branch.type === 'array');
  const object = field.anyOf.find((branch) => branch.type === 'object');
  assert.ok(array && object);
  assert.equal(array.minItems, 2);
  assert.equal(array.maxItems, 10);
  assert.equal(array.items.properties.id.type, 'string');
  assert.equal(object.properties.id.type, 'string');
  assert.equal(object.minItems, undefined);
  assert.ok(Object.isFrozen(field));
}
assert.deepEqual(agent.presentationSchema, mcp.presentationSchema);
assert.deepEqual(agent.presentationSchema, manifest.inputSchema);
for (const value of [
  { kind: 'single' },
  { kind: 'single', value: { id: 'a' } },
  { kind: 'group', value: [{ id: 'a' }, { id: 'b' }] },
]) {
  assert.ok(input.safeParse({ content: { parts: [value] } }).success);
}
assert.ok(
  !input.safeParse({ content: { parts: [{ kind: 'group', value: [{ id: 'a' }] }] } }).success,
);
const nullableContract = defineContract(
  { prefix: 'nullable_probe' },
  {
    create: {
      method: 'POST',
      path: '/',
      desc: 'Nullable annotation probe',
      input: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('a'),
          value: z.string().describe('INNER').nullable().describe('OUTER_A'),
        }),
        z.object({
          kind: z.literal('b'),
          value: z.string().describe('INNER').nullable().describe('OUTER_B'),
        }),
      ]),
    },
  },
);
const [nullable] = collectTools(
  implement(nullableContract, { create: () => undefined }),
  'AGENT',
  { flattenUnionInput: true },
);
assert.ok(nullable);
assert.equal(
  nullable.presentationSchema.properties.value.description,
  'When kind = a: OUTER_A When kind = b: OUTER_B',
);
console.log('packed union annotations: ok');
