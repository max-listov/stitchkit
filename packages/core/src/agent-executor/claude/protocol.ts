import { z } from 'zod';

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
  input_tokens: z.int().nonnegative().optional(),
  output_tokens: z.int().nonnegative().optional(),
  cache_read_input_tokens: z.int().nonnegative().optional(),
});

export const ClaudeRecordSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('system'),
    subtype: z.string(),
    session_id: z.string().optional(),
    model: z.string().optional(),
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
    message: z.looseObject({
      id: z.string().min(1),
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
    usage: Usage.optional(),
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
]);

export type ClaudeRecord = z.infer<typeof ClaudeRecordSchema>;

/** A record whose `type` this driver does not know: carried as `unhandled`, never dropped. */
export const ClaudeUnknownRecordSchema = z.looseObject({ type: z.string() });

/** What the executor writes: one user message under the id it chose. */
export function claudeUserMessage(input: {
  clientId: string;
  text: string;
  sessionId: string;
}) {
  return {
    type: 'user',
    message: { role: 'user', content: input.text },
    uuid: input.clientId,
    parent_tool_use_id: null,
    session_id: input.sessionId,
  };
}

/** An answer to `can_use_tool`, in the dialect's own form: `deny` always carries a message. */
export function claudePermissionResponse(
  requestId: string,
  decision: { behavior: 'allow'; input: unknown } | { behavior: 'deny'; message: string },
) {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response:
        decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: decision.input }
          : { behavior: 'deny', message: decision.message },
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
