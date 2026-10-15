import { z } from 'zod';
import { ProviderJournalContentSchema, ProviderJournalOptions } from './provider-content';

/** Persisted provider records are shared by the writer and the strict branch reader. */
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Message = z
  .object({
    ...ProviderJournalOptions,
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(ProviderJournalContentSchema)]),
  })
  .strict();
export const ProviderJournalMessageSchema = z
  .object({ sha256: Hash, message: Message })
  .strict();
export const ProviderJournalRequestSchema = z
  .object({
    runId: z.string(),
    attempt: z.int().nonnegative(),
    stepNumber: z.int().nonnegative(),
    modelId: z.string(),
    instructionsSha256: Hash,
    messageShas: z.array(Hash),
    bodySha256: Hash,
  })
  .strict();
export const ProviderJournalResponseSchema = z
  .object({
    runId: z.string(),
    attempt: z.int().nonnegative(),
    stepNumber: z.int().nonnegative(),
    response: z.object({ id: z.string(), provider: z.string().optional() }).strict(),
  })
  .strict();
