import { z } from 'zod';

/** JSON form after the ledger replaces binary content and URLs with durable evidence. */
export const ProviderJournalOptions = {
  providerOptions: z.record(z.string(), z.record(z.string(), z.json())).optional(),
};
const Options = ProviderJournalOptions;
// Tagged file shapes must never fall through to a provider-name mapping.
const Reference = z
  .record(z.string(), z.string())
  .refine(
    (value) => !('type' in value),
    'Provider reference cannot contain a file discriminator',
  );
const Binary = z
  .object({
    binary: z.literal(true),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.int().nonnegative(),
  })
  .strict();
const Inline = z.union([z.string(), Binary]);
const TaggedBinary = z.object({ type: z.literal('data'), data: Inline }).strict();
const TaggedUrl = z.object({ type: z.literal('url'), url: z.string() }).strict();
const FileData = z.union([
  TaggedBinary,
  TaggedUrl,
  z.object({ type: z.literal('reference'), reference: Reference }).strict(),
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
]);
const File = z
  .object({
    type: z.literal('file'),
    data: z.union([FileData, Inline, Reference]),
    mediaType: z.string(),
    filename: z.string().optional(),
    ...Options,
  })
  .strict();
const Text = z.object({ type: z.literal('text'), text: z.string(), ...Options }).strict();
const Output = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['text', 'error-text']), value: z.string(), ...Options }).strict(),
  z.object({ type: z.enum(['json', 'error-json']), value: z.json(), ...Options }).strict(),
  z
    .object({ type: z.literal('execution-denied'), reason: z.string().optional(), ...Options })
    .strict(),
  z
    .object({
      type: z.literal('content'),
      value: z.array(
        z.union([
          Text,
          z
            .object({
              type: z.literal('file'),
              data: FileData,
              mediaType: z.string(),
              filename: z.string().optional(),
              ...Options,
            })
            .strict(),
          z
            .object({
              type: z.literal('file-data'),
              data: z.string(),
              mediaType: z.string(),
              filename: z.string().optional(),
              ...Options,
            })
            .strict(),
          z
            .object({
              type: z.literal('image-data'),
              data: z.string(),
              mediaType: z.string(),
              ...Options,
            })
            .strict(),
          z
            .object({
              type: z.literal('file-url'),
              url: z.string(),
              mediaType: z.string().optional(),
              ...Options,
            })
            .strict(),
          z.object({ type: z.literal('image-url'), url: z.string(), ...Options }).strict(),
          z
            .object({
              type: z.enum(['file-id', 'image-file-id']),
              fileId: z.union([z.string(), Reference]),
              ...Options,
            })
            .strict(),
          z
            .object({
              type: z.enum(['file-reference', 'image-file-reference']),
              providerReference: Reference,
              ...Options,
            })
            .strict(),
          z.object({ type: z.literal('custom'), ...Options }).strict(),
        ]),
      ),
    })
    .strict(),
]);

export const ProviderJournalContentSchema = z.union([
  Text,
  File,
  z.object({ type: z.literal('reasoning'), text: z.string(), ...Options }).strict(),
  z.object({ type: z.literal('custom'), kind: z.string(), ...Options }).strict(),
  z
    .object({
      type: z.literal('reasoning-file'),
      data: z.union([TaggedBinary, TaggedUrl, Inline]),
      mediaType: z.string(),
      ...Options,
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      image: z.union([Inline, Reference]),
      mediaType: z.string().optional(),
      ...Options,
    })
    .strict(),
  z
    .object({
      type: z.literal('tool-call'),
      toolCallId: z.string(),
      toolName: z.string(),
      input: z.json(),
      providerExecuted: z.boolean().optional(),
      ...Options,
    })
    .strict(),
  z
    .object({
      type: z.literal('tool-result'),
      toolCallId: z.string(),
      toolName: z.string(),
      output: Output,
      ...Options,
    })
    .strict(),
  z
    .object({
      type: z.literal('tool-approval-request'),
      approvalId: z.string(),
      toolCallId: z.string(),
      signature: z.string().optional(),
      isAutomatic: z.boolean().optional(),
      reason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool-approval-response'),
      approvalId: z.string(),
      approved: z.boolean(),
      reason: z.string().optional(),
      providerExecuted: z.boolean().optional(),
    })
    .strict(),
]);
