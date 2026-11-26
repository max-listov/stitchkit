import { z } from 'zod';
import { type InteractionReply, InteractionReplySchema } from '../executor-contract';
import {
  type InlinedPart,
  isSupportedImageMediaType,
  type SupportedImageMediaType,
} from '../image-input';
import { safeJsonValue } from '../session-primitives';

type JsonValue = z.infer<ReturnType<typeof z.json>>;

/**
 * The slice of Claude Code's `stream-json` dialect the driver reads, as
 * observed on the CLI (2.1.330) and the Agent SDK it serves. Records carry
 * many more fields; each schema names only what the driver uses and lets the
 * rest through, so a field the CLI adds does not refuse the record — a record
 * TYPE it adds is classified `unhandled` instead.
 */
const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const ThinkingBlock = z.looseObject({
  type: z.literal('thinking'),
  thinking: z.string().optional(),
});
const ToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.json(),
});
const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.json().optional(),
  is_error: z.boolean().optional(),
});
const OtherBlock = z.looseObject({ type: z.string() });

export const ClaudeContentBlockSchema = z.union([
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  OtherBlock,
]);

const Usage = z.looseObject({
  input_tokens: z.int().nonnegative().nullish(),
  output_tokens: z.int().nonnegative().nullish(),
  cache_read_input_tokens: z.int().nonnegative().nullish(),
  cache_creation_input_tokens: z.int().nonnegative().nullish(),
  output_tokens_details: z
    .looseObject({
      thinking_tokens: z.int().nonnegative().nullish(),
    })
    .nullish(),
});

export const ClaudeRecordSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('system'),
    subtype: z.string(),
    session_id: z.string().optional(),
    model: z.string().optional(),
    uuid: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal('user'),
    uuid: z.string().optional(),
    isReplay: z.boolean().optional(),
    message: z.looseObject({
      content: z.union([z.string(), z.array(ClaudeContentBlockSchema)]),
    }),
  }),
  z.looseObject({
    type: z.literal('assistant'),
    parent_tool_use_id: z.string().nullable().optional(),
    message: z.looseObject({
      id: z.string().min(1),
      model: z.string().optional(),
      content: z.array(ClaudeContentBlockSchema),
    }),
  }),
  z.looseObject({
    type: z.literal('stream_event'),
    api_message_id: z.string().optional(),
    event: z.looseObject({
      type: z.string(),
      index: z.int().nonnegative().optional(),
      delta: z
        .union([
          z.looseObject({ type: z.literal('text_delta'), text: z.string() }),
          z.looseObject({ type: z.literal('thinking_delta'), thinking: z.string() }),
          // `message_delta` carries a delta without a `type` (stop reason, usage).
          z.looseObject({ type: z.string().optional() }),
        ])
        .optional(),
      message: z.looseObject({ id: z.string().optional() }).optional(),
    }),
  }),
  z.looseObject({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean(),
    session_id: z.string().optional(),
    terminal_reason: z.string().optional(),
    api_error_status: z.union([z.int(), z.string()]).nullable().optional(),
    result: z.string().optional(),
    total_cost_usd: z.number().nonnegative().optional(),
    usage: Usage.nullish(),
    // Parsed leniently so partial or future per-model rows never drop turn-end.
    modelUsage: z.record(z.string(), z.unknown()).nullish(),
  }),
  z.looseObject({ type: z.literal('rate_limit_event'), rate_limit_info: z.looseObject({}) }),
  z.looseObject({
    type: z.literal('control_request'),
    request_id: z.string().min(1),
    request: z.looseObject({
      subtype: z.string(),
      tool_name: z.string().optional(),
      input: z.json().optional(),
      tool_use_id: z.string().optional(),
      suppress_always_allow_rule: z.boolean().optional(),
    }),
  }),
  z.looseObject({
    type: z.literal('control_response'),
    response: z.looseObject({ subtype: z.string(), request_id: z.string().optional() }),
  }),
  z.looseObject({
    type: z.literal('command_lifecycle'),
    command_uuid: z.string().optional(),
    state: z.string(),
  }),
  z.looseObject({
    type: z.literal('tool_progress'),
  }),
]);

export type ClaudeRecord = z.infer<typeof ClaudeRecordSchema>;

/** A record whose `type` this driver does not know: carried as `unhandled`, never dropped. */
export const ClaudeUnknownRecordSchema = z.looseObject({ type: z.string() });

/** One content block in a Claude CLI / Agent SDK user message. */
export type ClaudeUserContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly source: {
        readonly type: 'base64';
        readonly media_type: SupportedImageMediaType;
        readonly data: string;
      };
    };

/**
 * Encode validated turn parts into Claude's user `message.content`: plain text joins into a
 * string (preserving wire compatibility), while inputs with images produce ordered blocks.
 */
export function claudeUserContent(
  parts: readonly InlinedPart[],
): string | ClaudeUserContentBlock[] {
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('\n');
  }
  return parts.map((part): ClaudeUserContentBlock => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (!isSupportedImageMediaType(part.mediaType)) {
      throw new TypeError(`Unsupported Claude image media type: ${part.mediaType}`);
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: part.mediaType, data: part.base64 },
    };
  });
}

/** What the executor writes: one user message under the id it chose. */
export function claudeUserMessage(input: {
  clientId: string;
  content: string | readonly ClaudeUserContentBlock[];
  sessionId: string;
}) {
  return {
    type: 'user',
    message: { role: 'user', content: input.content },
    uuid: input.clientId,
    parent_tool_use_id: null,
    session_id: input.sessionId,
  };
}

/** Session-scoped allow rule attached to a Claude `can_use_tool` allow response. */
export interface ClaudeSessionAllowRule {
  readonly type: 'addRules';
  readonly rules: readonly { readonly toolName: string }[];
  readonly behavior: 'allow';
  readonly destination: 'session';
}

/** Metadata kept with one held Claude permission request (CLI `control_request` or SDK `canUseTool`). */
export interface ClaudePendingPermissionDetail<TInput = unknown> {
  readonly input: TInput;
  readonly toolName: string | undefined;
  readonly suppressSessionRule: boolean;
}

/** Normalized decision produced from a host `InteractionReply` for a pending Claude permission request. */
export type ClaudePermissionDecision<TInput = unknown> =
  | {
      behavior: 'allow';
      input: TInput | Record<string, JsonValue>;
      updatedPermissions?: readonly ClaudeSessionAllowRule[];
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

function safeJsonObject(value: unknown): Record<string, JsonValue> {
  const cloned = safeJsonValue(value);
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
    throw new TypeError('Claude permission updatedInput must be a plain JSON object');
  }
  return cloned;
}

/**
 * Validate a host `InteractionReply` against a held Claude permission request without mutating
 * pending state on refusal. Shared by both Claude CLI and Claude SDK drivers.
 */
export function resolveClaudePermissionReply<TInput>(
  detail: ClaudePendingPermissionDetail<TInput>,
  rawReply: InteractionReply['reply'],
): ClaudePermissionDecision<TInput> {
  const reply = InteractionReplySchema.shape.reply.parse(rawReply);
  if (reply.kind === 'input') {
    throw new TypeError(
      'A Claude permission request is approved or denied, not answered with input',
    );
  }
  if (reply.kind === 'approve') {
    if (reply.scope === 'session') {
      if (detail.toolName === undefined) {
        throw new TypeError(
          'Cannot grant a session-scoped Claude approval without a non-empty toolName',
        );
      }
      if (detail.suppressSessionRule) {
        throw new TypeError(
          'This Claude permission request does not allow a session-scoped approval rule',
        );
      }
    }
    const updatedInput =
      reply.updatedInput !== undefined ? safeJsonObject(reply.updatedInput) : detail.input;
    return {
      behavior: 'allow',
      input: updatedInput,
      ...(reply.scope === 'session' &&
        detail.toolName !== undefined && {
          updatedPermissions: [
            {
              type: 'addRules',
              rules: [{ toolName: detail.toolName }],
              behavior: 'allow',
              destination: 'session',
            },
          ],
        }),
    };
  }
  return {
    behavior: 'deny',
    message: reply.message,
    ...(reply.interrupt === true && { interrupt: true }),
  };
}

/** An answer to `can_use_tool`, in the dialect's own form: `deny` always carries a message. */
export function claudePermissionResponse(
  requestId: string,
  decision: ClaudePermissionDecision,
) {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response:
        decision.behavior === 'allow'
          ? {
              behavior: 'allow',
              updatedInput: decision.input,
              ...(decision.updatedPermissions !== undefined && {
                updatedPermissions: decision.updatedPermissions,
              }),
            }
          : {
              behavior: 'deny',
              message: decision.message,
              ...(decision.interrupt === true && { interrupt: true }),
            },
    },
  };
}

/** The refusal of a control request, in the CLI's `ControlErrorResponse` form. */
export function claudeControlError(requestId: string, error: string) {
  return {
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error },
  };
}

export function claudeInterrupt(requestId: string) {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}
