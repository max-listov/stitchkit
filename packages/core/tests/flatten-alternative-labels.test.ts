/**
 * A flattened union keeps, as text, which discriminator values select each shape of a field the
 * variants share. The join advertises the discriminator as an enum and the field as an `anyOf`
 * in canonical order (ADR 0205); without a label a model cannot tell which shape goes with which
 * value, and the presentation stays inside the portable profile only if the link is text.
 */
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { buildToolPresentationSchema } from '../src/tools/schema/presentation';

function dataField(input: z.ZodObject): Record<string, unknown> {
  const schema = buildToolPresentationSchema({
    inputSchema: input,
    unrepresentable: 'any',
    flattenUnionInput: true,
  });
  const blocks = schema.properties;
  if (typeof blocks !== 'object' || blocks === null || !('blocks' in blocks))
    throw new Error('expected blocks');
  return JSON.parse(JSON.stringify(blocks.blocks)).items.properties.data;
}

test('each alternative of a shared field names the discriminator values that select it', () => {
  const data = dataField(
    z.object({
      blocks: z.array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), data: z.object({ text: z.string() }) }),
          z.object({ type: z.literal('image'), data: z.object({ artifactId: z.string() }) }),
        ]),
      ),
    }),
  );
  expect(data.anyOf).toEqual([
    {
      type: 'object',
      properties: { artifactId: { type: 'string' } },
      required: ['artifactId'],
      description: 'When type = image.',
    },
    {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      description: 'When type = text.',
    },
  ]);
});

test('one shape shared by several values is one alternative naming all of them', () => {
  const caption = z.object({ caption: z.string() });
  const data = dataField(
    z.object({
      blocks: z.array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('photo'), data: caption }),
          z.object({ type: z.literal('video'), data: caption }),
          z.object({
            type: z.literal('quiz'),
            data: z.object({ options: z.array(z.string()) }),
          }),
        ]),
      ),
    }),
  );
  expect(Array.isArray(data.anyOf) && data.anyOf.map((branch) => branch.description)).toEqual([
    'When type = photo | video.',
    'When type = quiz.',
  ]);
});
