import { z } from 'zod';
import { answerEngineRequest, type EngineRequestTurn } from '../engine-requests';
import { type InteractionReply, InteractionReplySchema } from '../executor-contract';
import type { JsonRpcValue } from '../json-rpc-peer';
import { nonEmptyString, safeJsonValue } from '../session-primitives';
import type { AcpPermissionOption, AcpPermissionRequest } from './v1-protocol';

/** The answer to a permission request nobody will choose an option for. */
export const ACP_CANCELLED: JsonRpcValue = { outcome: { outcome: 'cancelled' } };

const AcpOptionSelectionInputSchema = z.strictObject({
  optionId: z.string().min(1),
});

/** Metadata kept with one held ACP permission request. */
export interface AcpPermissionDetail {
  readonly options: readonly AcpPermissionOption[];
}

/** A permission request arriving outside an active `startTurn()` (post-settle background work). */
export interface PendingExternalAcpRequest {
  readonly detail: AcpPermissionDetail;
  resolve(answer: JsonRpcValue): void;
}

function isPlainJsonRecord(
  value: JsonRpcValue | undefined,
): value is Record<string, JsonRpcValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the `request` delta fields for one ACP `session/request_permission` payload.
 * Preserves existing top-level `rawInput`/`args` keys while exposing `options`
 * (`optionId`, `kind`, `name`, `_meta`) in `delta.input`.
 */
export function buildAcpPermissionDeltaFields(asked: AcpPermissionRequest) {
  const callId = nonEmptyString(asked.toolCall.toolCallId);
  const title = nonEmptyString(asked.toolCall.title);
  const toolName = nonEmptyString(asked.toolCall.name) ?? title ?? 'tool';
  const toolInput = asked.toolCall.rawInput ?? asked.toolCall.args;
  const options = asked.options.map((option) => ({
    optionId: option.optionId,
    kind: option.kind,
    ...(option.name !== undefined && { name: option.name }),
    ...(option._meta !== undefined && option._meta !== null && { _meta: option._meta }),
  }));
  let inputPayload: Record<string, unknown>;
  if (isPlainJsonRecord(toolInput)) {
    inputPayload =
      'options' in toolInput
        ? { ...toolInput, rawInput: toolInput, options }
        : { ...toolInput, options };
  } else if (toolInput !== undefined) {
    inputPayload = { rawInput: toolInput, options };
  } else {
    inputPayload = { options };
  }
  return {
    ...(callId !== undefined && { callId }),
    toolName,
    input: safeJsonValue(inputPayload),
    ...(title !== undefined && { prompt: title }),
  };
}

/**
 * Validate and build the ACP JSON-RPC response payload for one held permission request.
 * All fail-closed checks run before any pending map entry is consumed so a refused reply
 * leaves the request open for a valid follow-up answer.
 */
export function buildAcpPermissionAnswer(
  detail: AcpPermissionDetail,
  rawReply: InteractionReply['reply'],
): JsonRpcValue {
  const reply = InteractionReplySchema.shape.reply.parse(rawReply);
  if (reply.kind === 'input') {
    const selected = AcpOptionSelectionInputSchema.safeParse(reply.value);
    if (!selected.success) {
      throw new TypeError(
        'An ACP input reply must carry { optionId: string } matching one of the offered options',
      );
    }
    const option = detail.options.find(
      (candidate) => candidate.optionId === selected.data.optionId,
    );
    if (option === undefined) {
      throw new TypeError(
        `The ACP permission request offered no option with optionId ${JSON.stringify(selected.data.optionId)}`,
      );
    }
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
  if (reply.kind === 'approve') {
    if (reply.updatedInput !== undefined) {
      throw new TypeError(
        'The ACP driver does not support rewriting tool input (updatedInput)',
      );
    }
    if (reply.scope === 'session') {
      const always = detail.options.find((candidate) => candidate.kind === 'allow_always');
      if (always === undefined) {
        throw new TypeError(
          'The ACP permission request offered no allow_always option for session-scoped approval',
        );
      }
      return { outcome: { outcome: 'selected', optionId: always.optionId } };
    }
    const option =
      detail.options.find((candidate) => candidate.kind === 'allow_once') ??
      detail.options.find((candidate) => candidate.kind.startsWith('allow'));
    if (option === undefined) throw new TypeError('The agent offered no allow option');
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
  if (reply.interrupt === true) {
    throw new TypeError(
      'The ACP driver does not support turn-cancelling approval denials; call interrupt() instead',
    );
  }
  const option =
    detail.options.find((candidate) => candidate.kind === 'reject_once') ??
    detail.options.find((candidate) => candidate.kind.startsWith('reject'));
  if (option === undefined) throw new TypeError('The agent offered no reject option');
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

/** Answer one held permission request owned by the active turn (`turn.respond`). */
export function answerActiveAcpTurnRequest(
  turn: EngineRequestTurn<JsonRpcValue, AcpPermissionDetail>,
  interactionId: string,
  rawReply: InteractionReply['reply'],
): void {
  const waiting = turn.pending.get(interactionId);
  if (waiting === undefined) {
    throw new TypeError(`Unknown interaction ${interactionId} for this turn`);
  }
  const answer = buildAcpPermissionAnswer(waiting.detail, rawReply);
  answerEngineRequest(turn, interactionId, answer);
}

/** Answer one pending permission request on the active turn or post-settle external map. */
export function answerAcpSessionRequest(input: {
  turn: EngineRequestTurn<JsonRpcValue, AcpPermissionDetail> | undefined;
  externalPending: Map<string, PendingExternalAcpRequest>;
  expectedEntry?: PendingExternalAcpRequest;
  interactionId: string;
  reply: InteractionReply['reply'];
}): void {
  if (input.turn?.pending.has(input.interactionId)) {
    answerActiveAcpTurnRequest(input.turn, input.interactionId, input.reply);
    return;
  }
  const external = input.externalPending.get(input.interactionId);
  if (
    external === undefined ||
    (input.expectedEntry !== undefined && external !== input.expectedEntry)
  ) {
    throw new TypeError(`Unknown interaction ${input.interactionId} for this ACP session`);
  }
  const answer = buildAcpPermissionAnswer(external.detail, input.reply);
  input.externalPending.delete(input.interactionId);
  external.resolve(answer);
}
