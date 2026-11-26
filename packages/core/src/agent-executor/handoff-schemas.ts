import { z } from 'zod';
import { AgentMessagePartSchema } from '../agent-parts/parts';

export const HANDOFF_LIMITS = {
  id: 256,
  entries: 10_000,
  partsPerEntry: 1024,
  maxTokens: 1_000_000,
  maxBytes: 4 * 1024 * 1024,
  maxOmittedIds: 256,
  defaultMaxOmittedIds: 20,
  recoveryHint: 1024,
  contextWindowTokens: 10_000_000,
  toolSummaryChars: 512,
} as const;

const IdSchema = z.string().min(1).max(HANDOFF_LIMITS.id);

/** One historical message entry eligible for deterministic cross-engine context handoff. */
export const ContextHandoffMessageEntrySchema = z.strictObject({
  kind: z.literal('message'),
  id: IdSchema,
  role: z.enum(['user', 'assistant']),
  parts: z.array(AgentMessagePartSchema).max(HANDOFF_LIMITS.partsPerEntry),
  turnId: IdSchema.optional(),
  providerThreadId: IdSchema.optional(),
  status: z.enum(['completed', 'interrupted', 'failed']).optional(),
});

/** Explicit reset barrier discarding all earlier entries from subsequent handoffs. */
export const ContextHandoffClearEntrySchema = z.strictObject({
  kind: z.literal('clear'),
  id: IdSchema,
  turnId: IdSchema.optional(),
});

/** Discriminated history record consumed by {@link buildContextHandoff}. */
export const ContextHandoffEntrySchema = z.discriminatedUnion('kind', [
  ContextHandoffMessageEntrySchema,
  ContextHandoffClearEntrySchema,
]);

/** Full or delta handoff selection strategy. */
export const ContextHandoffStrategySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('full') }),
  z
    .strictObject({
      mode: z.literal('delta'),
      afterItemId: IdSchema.optional(),
      afterTurnId: IdSchema.optional(),
      /** Behavior when the requested anchor is absent: `'error'` (fail-closed default) or `'full'`. */
      missingAnchor: z.enum(['error', 'full']).optional(),
    })
    .refine(
      (value) => value.afterItemId !== undefined || value.afterTurnId !== undefined,
      'delta strategy requires afterItemId or afterTurnId',
    )
    .refine(
      (value) => !(value.afterItemId !== undefined && value.afterTurnId !== undefined),
      'delta strategy accepts either afterItemId or afterTurnId, not both',
    ),
]);

/** Finite byte and token ceilings governing deterministic handoff selection. */
export const ContextHandoffBudgetSchema = z.strictObject({
  maxTokens: z.int().positive().max(HANDOFF_LIMITS.maxTokens),
  maxBytes: z.int().positive().max(HANDOFF_LIMITS.maxBytes),
  maxOmittedIds: z.int().nonnegative().max(HANDOFF_LIMITS.maxOmittedIds).optional(),
  contextWindowTokens: z.int().positive().max(HANDOFF_LIMITS.contextWindowTokens).optional(),
  usedTokens: z.int().nonnegative().max(HANDOFF_LIMITS.contextWindowTokens).optional(),
  workReserveTokens: z.int().nonnegative().max(HANDOFF_LIMITS.contextWindowTokens).optional(),
});

/** Input accepted by {@link buildContextHandoff}. */
export const ContextHandoffInputSchema = z.strictObject({
  entries: z.array(ContextHandoffEntrySchema).max(HANDOFF_LIMITS.entries),
  strategy: ContextHandoffStrategySchema,
  budget: ContextHandoffBudgetSchema,
  /** Optional host-supplied note telling the model how omitted items can be inspected. */
  recoveryHint: z.string().trim().min(1).max(HANDOFF_LIMITS.recoveryHint).optional(),
});

/** Responses API message item compatible with Codex `thread/inject_items`. */
export const ContextHandoffStructuredItemSchema = z.discriminatedUnion('role', [
  z.strictObject({
    type: z.literal('message'),
    role: z.literal('user'),
    content: z
      .array(z.strictObject({ type: z.literal('input_text'), text: z.string() }))
      .min(1),
  }),
  z.strictObject({
    type: z.literal('message'),
    role: z.literal('assistant'),
    content: z
      .array(z.strictObject({ type: z.literal('output_text'), text: z.string() }))
      .min(1),
  }),
]);

/** Intact historical item selected into a context handoff. */
export const ContextHandoffSelectedItemSchema = z.strictObject({
  id: IdSchema,
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  turnId: IdSchema.optional(),
  providerThreadId: IdSchema.optional(),
  status: z.enum(['completed', 'interrupted', 'failed']).optional(),
});

/** Deterministic result returned by {@link buildContextHandoff}. */
export const ContextHandoffResultSchema = z.strictObject({
  strategy: z.enum(['full', 'delta']),
  selectedItems: z.array(ContextHandoffSelectedItemSchema),
  omittedItemIds: z.array(IdSchema),
  omittedTotal: z.int().nonnegative(),
  inlineText: z.string(),
  structuredItems: z.array(ContextHandoffStructuredItemSchema),
  estimatedTokens: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
});

/** History entry accepted by {@link buildContextHandoff}. */
export type ContextHandoffEntry = z.infer<typeof ContextHandoffEntrySchema>;
/** Input accepted by {@link buildContextHandoff}. */
export type ContextHandoffInput = z.infer<typeof ContextHandoffInputSchema>;
/** Responses API item returned in {@link ContextHandoffResult.structuredItems}. */
export type ContextHandoffStructuredItem = z.infer<typeof ContextHandoffStructuredItemSchema>;
/** Selected historical item returned in {@link ContextHandoffResult.selectedItems}. */
export type ContextHandoffSelectedItem = z.infer<typeof ContextHandoffSelectedItemSchema>;
/** Deterministic handoff payload returned by {@link buildContextHandoff}. */
export type ContextHandoffResult = z.infer<typeof ContextHandoffResultSchema>;

/** Result of composing an inline context handoff ahead of a user turn message. */
export interface InlineHandoffComposition {
  readonly text: string;
  /** `true` when `userText` starts with a `/slash` command so inline context was deferred. */
  readonly deferred: boolean;
}
