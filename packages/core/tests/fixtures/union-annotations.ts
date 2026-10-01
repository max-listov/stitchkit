import { z } from 'zod';

export const oneDescription = 'ONE_FILE: one reference belongs to single.value.';
export const manyDescription = 'TWO_TO_TEN: multiple references belong to group.value.';
const ref = z.object({ id: z.string().min(1) });
export const annotatedParts = [
  z.object({ kind: z.literal('single'), value: ref.optional().describe(oneDescription) }),
  z.object({
    kind: z.literal('group'),
    value: z.array(ref).min(2).max(10).describe(manyDescription),
  }),
  z.object({ kind: z.literal('marker'), note: z.string() }),
] satisfies [z.ZodType, z.ZodType, z.ZodType];
export const annotatedPart = z.discriminatedUnion('kind', annotatedParts);
export const annotatedInput = z.object({
  content: z.object({ parts: z.array(annotatedPart) }),
});
