import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { AgentMessagePart } from '../../agent-parts/parts';
import { type DriverImageOptions, type InlinedPart, inlineOrderedParts } from '../image-input';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import { CodexTurnSteerResponseSchema } from './protocol';

const NonEmptyNoNulStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0 && !value.includes('\0'), {
    message: 'must be a non-empty string without NUL bytes',
  });

const AbsolutePathNoNulSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0 && !value.includes('\0') && isAbsolute(value), {
    message: 'must be an absolute path without NUL bytes',
  });

/** Codex-native `skill` user input item forwarded verbatim in `turn/start` and `turn/steer`. */
export const CodexSkillInputSchema = z.strictObject({
  type: z.literal('skill'),
  name: NonEmptyNoNulStringSchema,
  path: NonEmptyNoNulStringSchema,
});

/** Codex-native `skill` input item inferred from {@link CodexSkillInputSchema}. */
export type CodexSkillInput = z.infer<typeof CodexSkillInputSchema>;

/** Codex-native `localImage` user input item referencing a host-authorized local image path. */
export const CodexLocalImageInputSchema = z.strictObject({
  type: z.literal('localImage'),
  path: AbsolutePathNoNulSchema,
});

/** Codex-native `localImage` input item inferred from {@link CodexLocalImageInputSchema}. */
export type CodexLocalImageInput = z.infer<typeof CodexLocalImageInputSchema>;

/** Ordered input element accepted by {@link CodexSession.startTurn}, {@link CodexSession.steerTurn}, and {@link CodexControlClient.steerTurn}. */
export type CodexTurnInputPart = AgentMessagePart | CodexSkillInput | CodexLocalImageInput;

/** Validated, host-resolved Codex turn part ready for wire serialization. */
export type InlinedCodexPart = InlinedPart | CodexSkillInput | CodexLocalImageInput;

type CodexExtraInput = CodexSkillInput | CodexLocalImageInput;

function validateCodexExtraInput(part: CodexTurnInputPart): CodexExtraInput | undefined {
  if (part.type === 'skill') {
    const parsed = CodexSkillInputSchema.safeParse(part);
    if (!parsed.success) {
      throw new TypeError(
        'Codex skill input name and path must be non-empty strings without NUL bytes',
      );
    }
    return { type: 'skill', name: parsed.data.name, path: parsed.data.path };
  }
  if (part.type === 'localImage') {
    const parsed = CodexLocalImageInputSchema.safeParse(part);
    if (!parsed.success) {
      throw new TypeError(
        'Codex localImage input path must be an absolute path without NUL bytes',
      );
    }
    return { type: 'localImage', path: parsed.data.path };
  }
  return undefined;
}

/**
 * Validate every Codex turn part synchronously before the first `resolveFile` call, then resolve
 * image attachments in original order alongside text, `localImage`, and `skill` items.
 */
export function inlineCodexParts(
  parts: readonly CodexTurnInputPart[],
  options: DriverImageOptions & {
    readonly driverLabel: string;
    readonly signal?: AbortSignal;
  },
): Promise<InlinedCodexPart[]> {
  return inlineOrderedParts<CodexExtraInput, CodexExtraInput>(parts, {
    ...options,
    acceptedDescription: 'text, images, local images, and skills',
    validateExtra: validateCodexExtraInput,
  });
}

/**
 * Encode validated Codex turn parts into app-server `UserInput[]` items: plain text joins into
 * one text item (preserving wire compatibility), while inputs with images, `localImage`, or skills
 * keep exact order.
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
    } else if (part.type === 'localImage') {
      out.push({ type: 'localImage', path: part.path });
    } else {
      out.push({ type: 'image', url: `data:${part.mediaType};base64,${part.base64}` });
    }
  }
  return out;
}

/** Send one validated `turn/steer` JSON-RPC request and parse its acknowledged `turnId`. */
export async function sendCodexTurnSteer(
  peer: JsonRpcPeer,
  params: {
    readonly threadId: string;
    readonly expectedTurnId: string;
    readonly parts: readonly InlinedCodexPart[];
    readonly clientId?: string;
  },
): Promise<{ readonly turnId: string }> {
  const steered = CodexTurnSteerResponseSchema.parse(
    await peer.request('turn/steer', {
      threadId: params.threadId,
      expectedTurnId: params.expectedTurnId,
      input: codexTurnInput(params.parts),
      ...(params.clientId !== undefined && { clientUserMessageId: params.clientId }),
    }),
  );
  return { turnId: steered.turnId };
}
