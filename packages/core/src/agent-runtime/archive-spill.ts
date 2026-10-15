import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentCodingToolAuthorizationSchema } from './coding-tool-contract';

export const ArchiveSpillSchema = z
  .object({
    reference: z.string().min(1),
    runId: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    mediaType: z.string().min(1),
    bytes: z.int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    authorization: AgentCodingToolAuthorizationSchema.optional(),
    base64: z.string(),
  })
  .strict()
  .superRefine((spill, ctx) => {
    const bytes = Buffer.from(spill.base64, 'base64');
    if (
      bytes.toString('base64') !== spill.base64 ||
      bytes.byteLength !== spill.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== spill.sha256
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Conversation archive spill bytes or digest are inconsistent',
      });
    }
  });

export type ArchiveSpill = z.infer<typeof ArchiveSpillSchema>;
