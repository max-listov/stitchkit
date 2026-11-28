import { z } from 'zod';
import { base64ToBytes, bytesToBase64 } from '../internal/base64';

/**
 * Neutral model-exchange shapes shared by `tools/` and `agent-runtime/`.
 *
 * Kept in `agent-parts/` (peer-free, imports only `zod` and `internal/base64`)
 * so `stitchkit/tools` and `stitchkit/agent-runtime` speak one clean,
 * non-deprecated message and tool-output vocabulary without violating ADR 0197's
 * one-way core → runtime boundary or leaking optional peer types. → ADR 0336.
 */

export type AgentModelJsonValue = z.infer<ReturnType<typeof z.json>>;

/** Recursive JSON value accepted inside provider option maps (supports optional keys under `exactOptionalPropertyTypes`). */
export type AgentModelProviderOptionValue =
  | string
  | number
  | boolean
  | null
  | readonly AgentModelProviderOptionValue[]
  | { readonly [key: string]: AgentModelProviderOptionValue | undefined };

const AgentModelProviderOptionValueSchema: z.ZodType<
  AgentModelProviderOptionValue,
  AgentModelProviderOptionValue
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(AgentModelProviderOptionValueSchema),
    z.record(z.string(), AgentModelProviderOptionValueSchema.optional()),
  ]),
);

/** Namespaced provider options (`{ openrouter: { ... }, anthropic: { ... } }`). */
export const AgentModelProviderOptionsSchema = z.record(
  z.string(),
  z.record(z.string(), AgentModelProviderOptionValueSchema.optional()).optional(),
);

export type AgentModelProviderOptions = z.infer<typeof AgentModelProviderOptionsSchema>;

/** Portable prompt-caching breakpoint directive supported across native drivers. */
export const AgentCacheControlSchema = z.strictObject({
  type: z.literal('ephemeral'),
  ttl: z.enum(['5m', '1h']).optional(),
});

export type AgentCacheControl = z.infer<typeof AgentCacheControlSchema>;

/** Portable structured-output format requested from a model driver. */
export const AgentModelResponseFormatSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text') }),
  z.strictObject({ type: z.literal('json-object') }),
  z.strictObject({
    type: z.literal('json-schema'),
    name: z.string().min(1).max(64),
    schema: z.record(z.string(), z.unknown()),
    description: z.string().optional(),
    strict: z.boolean().optional(),
  }),
]);

export type AgentModelResponseFormat = z.infer<typeof AgentModelResponseFormatSchema>;

const ProviderOptionsField = {
  providerOptions: AgentModelProviderOptionsSchema.optional(),
  cacheControl: AgentCacheControlSchema.optional(),
};

const ProviderFileReferenceSchema = z
  .record(z.string(), z.string())
  .refine(
    (value) => !('type' in value),
    'Provider reference cannot contain a file discriminator',
  );

const BinaryOrTextDataSchema = z.union([
  z.string(),
  z.instanceof(Uint8Array),
  z.instanceof(ArrayBuffer),
]);

/**
 * Tagged file payload carried into a model request — never an ambiguous bare string.
 *
 * - `{ type: 'data', data }`: raw bytes (`Uint8Array` / `ArrayBuffer`) or base64 string.
 * - `{ type: 'url', url }`: `URL` pointing to the remote media/file.
 * - `{ type: 'reference', reference }`: provider-keyed uploaded file reference (`{ openai: 'file_...' }`).
 * - `{ type: 'text', text }`: inline plain-text document.
 */
export const AgentModelFileDataSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('data'), data: BinaryOrTextDataSchema }),
  z.strictObject({
    type: z.literal('url'),
    url: z.instanceof(URL),
    originalUrl: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('reference'), reference: ProviderFileReferenceSchema }),
  z.strictObject({ type: z.literal('text'), text: z.string() }),
]);

export type AgentModelFileData = z.infer<typeof AgentModelFileDataSchema>;

/** Tagged payload for a generated file emitted by a model driver. */
export type AgentGeneratedFileData =
  | { readonly type: 'data'; readonly data: Uint8Array | string }
  | { readonly type: 'url'; readonly url: URL };

const AgentToolModelContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), ...ProviderOptionsField }),
  z.object({
    type: z.literal('file'),
    data: AgentModelFileDataSchema,
    mediaType: z.string(),
    filename: z.string().optional(),
    ...ProviderOptionsField,
  }),
  z.object({ type: z.literal('custom'), ...ProviderOptionsField }),
]);

export type AgentToolModelContentPart = z.infer<typeof AgentToolModelContentPartSchema>;

/** Structured tool output delivered back to a model on the next step. */
export const AgentToolModelOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string(), ...ProviderOptionsField }),
  z.object({ type: z.literal('error-text'), value: z.string(), ...ProviderOptionsField }),
  z.object({ type: z.literal('json'), value: z.json(), ...ProviderOptionsField }),
  z.object({ type: z.literal('error-json'), value: z.json(), ...ProviderOptionsField }),
  z.object({
    type: z.literal('execution-denied'),
    reason: z.string().optional(),
    ...ProviderOptionsField,
  }),
  z.object({
    type: z.literal('content'),
    value: z.array(AgentToolModelContentPartSchema),
    ...ProviderOptionsField,
  }),
]);

export type AgentToolModelOutput = z.infer<typeof AgentToolModelOutputSchema>;

/** One system instruction block, with optional provider-specific cache/routing options. */
export const AgentModelSystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
  ...ProviderOptionsField,
});

export type AgentModelSystemMessage = z.infer<typeof AgentModelSystemMessageSchema>;

/** Instructions accepted by prompt composition and `prepareStep`. */
export type AgentInstructions =
  | string
  | AgentModelSystemMessage
  | readonly AgentModelSystemMessage[];

/** Normalize any `AgentInstructions` shape into ordered system messages. */
export function normalizeAgentInstructions(
  instructions: AgentInstructions | undefined,
): AgentModelSystemMessage[] {
  if (instructions === undefined) return [];
  if (typeof instructions === 'string') {
    return instructions.length > 0 ? [{ role: 'system', content: instructions }] : [];
  }
  const list = Array.isArray(instructions) ? instructions : [instructions];
  return list
    .filter((entry) => entry.content.length > 0)
    .map((entry) => ({
      role: 'system' as const,
      content: entry.content,
      ...(entry.providerOptions !== undefined && { providerOptions: entry.providerOptions }),
      ...(entry.cacheControl !== undefined && { cacheControl: entry.cacheControl }),
    }));
}

export const AgentModelUserContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), ...ProviderOptionsField }),
  z.object({
    type: z.literal('file'),
    data: AgentModelFileDataSchema,
    mediaType: z.string(),
    filename: z.string().optional(),
    ...ProviderOptionsField,
  }),
]);

export type AgentModelUserContentPart = z.infer<typeof AgentModelUserContentPartSchema>;

export const AgentModelAssistantContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), ...ProviderOptionsField }),
  z.object({ type: z.literal('reasoning'), text: z.string(), ...ProviderOptionsField }),
  z.object({
    type: z.literal('file'),
    data: AgentModelFileDataSchema,
    mediaType: z.string(),
    filename: z.string().optional(),
    ...ProviderOptionsField,
  }),
  z.object({
    type: z.literal('reasoning-file'),
    data: AgentModelFileDataSchema,
    mediaType: z.string(),
    ...ProviderOptionsField,
  }),
  z.object({
    type: z.literal('tool-call'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    providerExecuted: z.boolean().optional(),
    ...ProviderOptionsField,
  }),
  z.object({
    type: z.literal('tool-result'),
    toolCallId: z.string(),
    toolName: z.string(),
    output: AgentToolModelOutputSchema,
    ...ProviderOptionsField,
  }),
  z.object({
    type: z.literal('tool-approval-request'),
    approvalId: z.string(),
    toolCallId: z.string(),
    signature: z.string().optional(),
    isAutomatic: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('custom'),
    kind: z.string(),
    ...ProviderOptionsField,
  }),
]);

export type AgentModelAssistantContentPart = z.infer<
  typeof AgentModelAssistantContentPartSchema
>;

export const AgentModelToolContentPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool-result'),
    toolCallId: z.string(),
    toolName: z.string(),
    output: AgentToolModelOutputSchema,
    ...ProviderOptionsField,
  }),
  z.object({
    type: z.literal('tool-approval-response'),
    approvalId: z.string(),
    approved: z.boolean(),
    reason: z.string().optional(),
    providerExecuted: z.boolean().optional(),
  }),
]);

export type AgentModelToolContentPart = z.infer<typeof AgentModelToolContentPartSchema>;

export const AgentModelUserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(AgentModelUserContentPartSchema)]),
  ...ProviderOptionsField,
});

export type AgentModelUserMessage = z.infer<typeof AgentModelUserMessageSchema>;

export const AgentModelAssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([z.string(), z.array(AgentModelAssistantContentPartSchema)]),
  ...ProviderOptionsField,
});

export type AgentModelAssistantMessage = z.infer<typeof AgentModelAssistantMessageSchema>;

export const AgentModelToolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.array(AgentModelToolContentPartSchema),
  ...ProviderOptionsField,
});

export type AgentModelToolMessage = z.infer<typeof AgentModelToolMessageSchema>;

/** Canonical model-facing message — peer-free and non-deprecated. */
export const AgentModelMessageSchema = z.discriminatedUnion('role', [
  AgentModelSystemMessageSchema,
  AgentModelUserMessageSchema,
  AgentModelAssistantMessageSchema,
  AgentModelToolMessageSchema,
]);

export type AgentModelMessage = z.infer<typeof AgentModelMessageSchema>;

/** File generated by a model during a step and handed to `persistGeneratedFile`. */
export interface AgentGeneratedFile {
  readonly mediaType: string;
  readonly data: AgentGeneratedFileData;
  readonly filename?: string;
  readonly url?: URL;
  readonly base64: string;
  readonly uint8Array: Uint8Array;
  readonly providerMetadata?: AgentModelProviderOptions;
}

/** Construct a lazy `AgentGeneratedFile` from inline bytes/base64 or a remote `URL`. */
export function createAgentGeneratedFile(
  mediaType: string,
  payload: AgentGeneratedFileData | Uint8Array | string,
  providerMetadata?: AgentModelProviderOptions,
  filename?: string,
): AgentGeneratedFile {
  const normalized: AgentGeneratedFileData =
    payload instanceof Uint8Array || typeof payload === 'string'
      ? { type: 'data', data: payload }
      : payload;
  if (normalized.type === 'url') {
    const url = normalized.url;
    return {
      mediaType,
      data: normalized,
      ...(filename !== undefined && { filename }),
      url,
      ...(providerMetadata !== undefined && { providerMetadata }),
      get base64(): string {
        throw new Error(
          `Generated file (${mediaType}) carries a remote URL (${url.origin}) and has no inline base64 bytes`,
        );
      },
      get uint8Array(): Uint8Array {
        throw new Error(
          `Generated file (${mediaType}) carries a remote URL (${url.origin}) and has no inline bytes`,
        );
      },
    };
  }
  let cachedBase64: string | undefined =
    typeof normalized.data === 'string' ? normalized.data : undefined;
  let cachedBytes: Uint8Array | undefined =
    normalized.data instanceof Uint8Array ? normalized.data : undefined;
  return {
    mediaType,
    data: normalized,
    ...(filename !== undefined && { filename }),
    ...(providerMetadata !== undefined && { providerMetadata }),
    get base64(): string {
      if (cachedBase64 === undefined) {
        cachedBase64 = bytesToBase64(cachedBytes ?? new Uint8Array());
      }
      return cachedBase64;
    },
    get uint8Array(): Uint8Array {
      if (cachedBytes === undefined) {
        cachedBytes = base64ToBytes(cachedBase64 ?? '');
      }
      return cachedBytes;
    },
  };
}
