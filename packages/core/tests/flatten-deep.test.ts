import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';
import { flattenUnionsDeep } from '../src/tools/flatten';
import { collectTools } from '../src/tools/mount';

// broadcast_create shape: a plain object whose `content.parts[]` is an array of a
// discriminated union — the union is NESTED, not the top-level input.
const part = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), url: z.string() }),
]);

const contract = defineContract(
  { prefix: 'broadcast' },
  {
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create a broadcast',
      input: z.object({
        name: z.string(),
        content: z.object({ parts: z.array(part) }),
      }),
      output: z.object({ id: z.string() }),
    },
  },
);
const service = implement(contract, { create: () => ({ id: 'x' }) });

/** True if a JSON Schema node contains `oneOf` / `anyOf` at any depth. */
function hasUnionKeyword(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasUnionKeyword);
  if (typeof node === 'object' && node !== null) {
    if ('oneOf' in node || 'anyOf' in node) return true;
    return Object.values(node).some(hasUnionKeyword);
  }
  return false;
}

describe('deep union flatten — nested discriminated unions', () => {
  test('without flatten, a nested union reaches the schema as oneOf/anyOf (the gap)', () => {
    const [tool] = collectTools(service, 'AGENT', { flattenUnionInput: false });
    if (!tool) throw new Error('expected tool');
    const json = z.toJSONSchema(tool.schema, { io: 'input' });
    expect(hasUnionKeyword(json)).toBe(true);
  });

  test('with flatten, no oneOf/anyOf survives at ANY depth', () => {
    const [tool] = collectTools(service, 'AGENT', { flattenUnionInput: true });
    if (!tool) throw new Error('expected tool');
    const json = z.toJSONSchema(tool.schema, { io: 'input' });
    expect(hasUnionKeyword(json)).toBe(false);
  });

  test('the nested union becomes a flat object carrying the "Required if" hints', () => {
    const flat = flattenUnionsDeep(
      z.object({ name: z.string(), content: z.object({ parts: z.array(part) }) }),
    );
    const json = z.toJSONSchema(flat, { io: 'input' });
    // The discriminator survives as an enum, and the per-variant fields as
    // described optionals — proof the hint text is preserved through the walk.
    const text = JSON.stringify(json);
    expect(text).toContain('Required if type =');
    expect(text).toContain('text');
    expect(text).toContain('image');
  });

  test('a top-level union still flattens (the original shallow behaviour)', () => {
    const flat = flattenUnionsDeep(part);
    expect(flat).toBeInstanceOf(z.ZodObject);
    expect(hasUnionKeyword(z.toJSONSchema(flat, { io: 'input' }))).toBe(false);
  });
});
