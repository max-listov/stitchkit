import { z } from 'zod';

/** Default maximum encoded line/frame for a contract stream: 256 KiB. */
export const DEFAULT_CONTRACT_STREAM_FRAME_BYTES = 256 * 1024;

export const ContractStreamFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), data: z.unknown() }).strict(),
  z
    .object({
      type: z.literal('error'),
      error: z
        .object({
          code: z.string(),
          message: z.string().optional(),
          details: z.unknown().optional(),
          hint: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('end') }).strict(),
]);
export type ContractStreamFrame = z.infer<typeof ContractStreamFrameSchema>;
