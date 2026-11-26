import { z } from 'zod';
import type { AgentMessagePart } from '../../agent-parts/parts';
import { type DriverImageOptions, type InlinedPart, inlineOrderedParts } from '../image-input';
import type { JsonRpcValue } from '../json-rpc-peer';

const NonEmptyNoNulStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0 && !value.includes('\0'), {
    message: 'must be a non-empty string without NUL bytes',
  });

/** Codex-native `skill` user input item forwarded verbatim in `turn/start` and `turn/steer`. */
export const CodexSkillInputSchema = z.strictObject({
  type: z.literal('skill'),
  name: NonEmptyNoNulStringSchema,
  path: NonEmptyNoNulStringSchema,
});

/** Codex-native `skill` input item inferred from {@link CodexSkillInputSchema}. */
export type CodexSkillInput = z.infer<typeof CodexSkillInputSchema>;

/** Ordered input element accepted by {@link CodexSession.startTurn} and {@link CodexSession.steerTurn}. */
export type CodexTurnInputPart = AgentMessagePart | CodexSkillInput;

/** Validated, host-resolved Codex turn part ready for wire serialization. */
export type InlinedCodexPart = InlinedPart | CodexSkillInput;

function validateSkillInput(part: CodexTurnInputPart): CodexSkillInput | undefined {
  if (part.type !== 'skill') return undefined;
  const parsed = CodexSkillInputSchema.safeParse(part);
  if (!parsed.success) {
    throw new TypeError(
      'Codex skill input name and path must be non-empty strings without NUL bytes',
    );
  }
  return { type: 'skill', name: parsed.data.name, path: parsed.data.path };
}

/**
 * Validate every Codex turn part synchronously before the first `resolveFile` call, then resolve
 * image attachments in original order alongside text and `skill` items.
 */
export function inlineCodexParts(
  parts: readonly CodexTurnInputPart[],
  options: DriverImageOptions & {
    readonly driverLabel: string;
    readonly signal?: AbortSignal;
  },
): Promise<InlinedCodexPart[]> {
  return inlineOrderedParts<CodexSkillInput, CodexSkillInput>(parts, {
    ...options,
    acceptedDescription: 'text, images, and skills',
    validateExtra: validateSkillInput,
  });
}

/**
 * Encode validated Codex turn parts into app-server `UserInput[]` items: plain text joins into
 * one text item (preserving wire compatibility), while inputs with images or skills keep exact order.
 */
export function codexTurnInput(parts: readonly InlinedCodexPart[]): JsonRpcValue[] {
  if (parts.every((part) => part.type === 'text')) {
    return [
      { type: 'text', text: parts.map((part) => part.text).join('\n'), text_elements: [] },
    ];
  }
  const out: JsonRpcValue[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text, text_elements: [] });
    } else if (part.type === 'skill') {
      out.push({ type: 'skill', name: part.name, path: part.path });
    } else {
      out.push({ type: 'image', url: `data:${part.mediaType};base64,${part.base64}` });
    }
  }
  return out;
}
