import { answerEngineRequest, type EngineRequestTurn } from '../engine-requests';
import { type InteractionReply, InteractionReplySchema } from '../executor-contract';
import type { JsonRpcValue } from '../json-rpc-peer';
import { nonEmptyString, safeJsonValue } from '../session-primitives';
import type { CodexTurnState } from './classify';
import type { CodexStartingTurn } from './event-routing';
import {
  CODEX_APPROVAL_DECISION,
  CODEX_APPROVAL_REQUESTS,
  CODEX_ELICITATION_REQUEST,
  CODEX_INPUT_REQUEST,
  CODEX_PERMISSIONS_APPROVAL_REQUEST,
  CodexApprovalParamsSchema,
  CodexMcpElicitationAnswerSchema,
  type CodexMcpElicitationMode,
  CodexMcpElicitationParamsSchema,
  CodexPermissionsApprovalParamsSchema,
  CodexUserInputAnswersSchema,
  CodexUserInputParamsSchema,
} from './protocol';

/** Known Codex app-server request methods handled by the driver. */
export type CodexServerRequestMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'item/tool/requestUserInput'
  | 'mcpServer/elicitation/request';

/** Metadata kept with one held Codex approval, permissions, user-input, or MCP elicitation request. */
export interface CodexRequestDetail {
  readonly method: CodexServerRequestMethod;
  readonly kind?: string;
  readonly availableDecisions?: readonly JsonRpcValue[];
  readonly permissions?: JsonRpcValue;
  readonly elicitationMode?: CodexMcpElicitationMode;
}

/** The turn running in a session, and the engine's requests it is still to answer. */
export interface CodexTurnSlot extends EngineRequestTurn<JsonRpcValue, CodexRequestDetail> {
  readonly state: CodexTurnState;
  readonly threadId?: string;
  starting?: CodexStartingTurn;
  codexTurnId?: string;
}

/** An external/TUI server request held outside `startTurn()`. */
export interface PendingExternalCodexRequest {
  readonly detail: CodexRequestDetail;
  readonly turnId: string;
  readonly threadId?: string;
  resolve(answer: JsonRpcValue): void;
}

export function isKnownCodexRequestMethod(method: string): method is CodexServerRequestMethod {
  return (
    CODEX_APPROVAL_REQUESTS.has(method) ||
    method === CODEX_PERMISSIONS_APPROVAL_REQUEST ||
    method === CODEX_INPUT_REQUEST ||
    method === CODEX_ELICITATION_REQUEST
  );
}

export function parseCodexApprovalRequest(method: CodexServerRequestMethod, params: unknown) {
  const asked = CodexApprovalParamsSchema.parse(params);
  const callId = nonEmptyString(asked.itemId);
  const metadata: Record<string, unknown> = {};
  if (typeof asked.command === 'string') metadata.command = asked.command;
  if (typeof asked.cwd === 'string') metadata.cwd = asked.cwd;
  if (typeof asked.reason === 'string') metadata.reason = asked.reason;
  if (typeof asked.grantRoot === 'string') metadata.grantRoot = asked.grantRoot;
  if (typeof asked.kind === 'string') metadata.kind = asked.kind;
  if (typeof asked.approvalId === 'string') metadata.approvalId = asked.approvalId;
  if (asked.commandActions != null) metadata.commandActions = asked.commandActions;
  if (asked.availableDecisions != null) metadata.availableDecisions = asked.availableDecisions;
  const input = Object.keys(metadata).length > 0 ? safeJsonValue(metadata) : undefined;
  const detail: CodexRequestDetail = {
    method,
    ...(typeof asked.kind === 'string' && { kind: asked.kind }),
    ...(Array.isArray(asked.availableDecisions) && {
      availableDecisions: asked.availableDecisions,
    }),
  };
  return {
    detail,
    deltaFields: {
      ...(callId !== undefined && { callId }),
      ...(typeof asked.command === 'string' && { prompt: asked.command }),
      ...(input !== undefined && { input }),
    },
  };
}

export function parseCodexInputRequest(params: unknown) {
  const asked = CodexUserInputParamsSchema.parse(params);
  const callId = nonEmptyString(asked.itemId);
  const questions = asked.questions.map((question) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    ...(question.options !== undefined && {
      options:
        question.options === null
          ? null
          : question.options.map((option) => ({
              label: option.label,
              description: option.description,
            })),
    }),
    ...(question.isOther !== undefined && { isOther: question.isOther }),
    ...(question.isSecret !== undefined && { isSecret: question.isSecret }),
  }));
  const detail: CodexRequestDetail = { method: CODEX_INPUT_REQUEST };
  return {
    detail,
    deltaFields: {
      ...(callId !== undefined && { callId }),
      input: safeJsonValue(questions),
    },
  };
}

export function parseCodexPermissionsRequest(params: unknown) {
  const asked = CodexPermissionsApprovalParamsSchema.parse(params);
  const callId = nonEmptyString(asked.itemId);
  const permissions = safeJsonValue(asked.permissions);
  const metadata: Record<string, unknown> = {
    threadId: asked.threadId,
    turnId: asked.turnId,
    cwd: asked.cwd,
    permissions,
    startedAtMs: asked.startedAtMs,
  };
  if (typeof asked.reason === 'string') metadata.reason = asked.reason;
  if (typeof asked.environmentId === 'string') metadata.environmentId = asked.environmentId;
  const detail: CodexRequestDetail = {
    method: CODEX_PERMISSIONS_APPROVAL_REQUEST,
    permissions,
  };
  return {
    detail,
    deltaFields: {
      ...(callId !== undefined && { callId }),
      ...(typeof asked.reason === 'string' && { prompt: asked.reason }),
      input: safeJsonValue(metadata),
    },
  };
}

export function parseCodexElicitationRequest(params: unknown) {
  const asked = CodexMcpElicitationParamsSchema.parse(params);
  const toolName = nonEmptyString(asked.serverName);
  const callId = asked.mode === 'url' ? nonEmptyString(asked.elicitationId) : undefined;
  const metadata: Record<string, unknown> = {
    serverName: asked.serverName,
    threadId: asked.threadId,
    mode: asked.mode,
    message: asked.message,
  };
  if (asked.turnId !== undefined) metadata.turnId = asked.turnId;
  if (asked.environmentId !== undefined) metadata.environmentId = asked.environmentId;
  if (asked._meta !== undefined) metadata._meta = asked._meta;
  if (asked.mode === 'url') {
    metadata.elicitationId = asked.elicitationId;
    metadata.url = asked.url;
  } else {
    metadata.requestedSchema = asked.requestedSchema;
  }
  const detail: CodexRequestDetail = {
    method: CODEX_ELICITATION_REQUEST,
    elicitationMode: asked.mode,
  };
  return {
    detail,
    deltaFields: {
      ...(callId !== undefined && { callId }),
      ...(toolName !== undefined && { toolName }),
      prompt: asked.message,
      input: safeJsonValue(metadata),
    },
  };
}

/** Parse any known Codex server request into its normalized delta kind, fields, and held detail. */
export function parseCodexServerRequest(method: CodexServerRequestMethod, params: unknown) {
  if (CODEX_APPROVAL_REQUESTS.has(method)) {
    return { kind: 'approval' as const, ...parseCodexApprovalRequest(method, params) };
  }
  if (method === CODEX_PERMISSIONS_APPROVAL_REQUEST) {
    return { kind: 'approval' as const, ...parseCodexPermissionsRequest(params) };
  }
  if (method === CODEX_ELICITATION_REQUEST) {
    return { kind: 'input' as const, ...parseCodexElicitationRequest(params) };
  }
  return { kind: 'input' as const, ...parseCodexInputRequest(params) };
}

export function codexStoppedAnswer(method: string): JsonRpcValue {
  if (CODEX_APPROVAL_REQUESTS.has(method)) {
    return { decision: CODEX_APPROVAL_DECISION.interrupted };
  }
  if (method === CODEX_PERMISSIONS_APPROVAL_REQUEST) {
    return { permissions: {} };
  }
  if (method === CODEX_ELICITATION_REQUEST) {
    return { action: 'cancel' };
  }
  return { answers: {} };
}

export const codexStopped = (waiting: { detail: { method: string } }) =>
  codexStoppedAnswer(waiting.detail.method);

/**
 * Validate and build the Codex JSON-RPC response payload for one held approval, permissions,
 * user-input, or MCP elicitation request. Refuses unsupported `updatedInput`, invalid kinds,
 * `humanCommand` session approvals, or disallowed `availableDecisions` before state is mutated.
 */
export function buildCodexRequestAnswer(
  detail: CodexRequestDetail,
  rawReply: InteractionReply['reply'],
): JsonRpcValue {
  const reply = InteractionReplySchema.shape.reply.parse(rawReply);
  if (CODEX_APPROVAL_REQUESTS.has(detail.method)) {
    if (reply.kind === 'input') {
      throw new TypeError('A Codex approval is approved or denied, not answered with input');
    }
    if (reply.kind === 'approve' && reply.updatedInput !== undefined) {
      throw new TypeError('Codex approval requests do not support updatedInput');
    }
    const decision =
      reply.kind === 'approve'
        ? reply.scope === 'session'
          ? CODEX_APPROVAL_DECISION.approveForSession
          : CODEX_APPROVAL_DECISION.approve
        : reply.interrupt === true
          ? CODEX_APPROVAL_DECISION.interrupted
          : CODEX_APPROVAL_DECISION.deny;
    if (
      detail.kind === 'humanCommand' &&
      decision === CODEX_APPROVAL_DECISION.approveForSession
    ) {
      throw new TypeError('Codex humanCommand approval does not allow acceptForSession');
    }
    if (detail.availableDecisions !== undefined) {
      const allowed = detail.availableDecisions.some((entry) => entry === decision);
      if (!allowed) {
        throw new TypeError(
          `Codex approval request does not offer decision ${JSON.stringify(decision)}`,
        );
      }
    }
    return { decision };
  }
  if (detail.method === CODEX_PERMISSIONS_APPROVAL_REQUEST) {
    if (reply.kind === 'input') {
      throw new TypeError(
        'A Codex permissions approval is approved or denied, not answered with input',
      );
    }
    if (reply.kind === 'approve') {
      if (reply.updatedInput !== undefined) {
        throw new TypeError('Codex permissions approval requests do not support updatedInput');
      }
      return {
        permissions: detail.permissions ?? {},
        scope: reply.scope === 'session' ? 'session' : 'turn',
      };
    }
    if (reply.interrupt === true) {
      throw new TypeError(
        'Codex permissions approval requests do not support interrupt on deny',
      );
    }
    return { permissions: {} };
  }
  if (detail.method === CODEX_ELICITATION_REQUEST) {
    if (reply.kind === 'approve') {
      throw new TypeError(
        'A Codex MCP elicitation request is answered with input or deny, not approve',
      );
    }
    if (reply.kind === 'deny') {
      return {
        action:
          detail.elicitationMode === 'url' || reply.interrupt === true ? 'cancel' : 'decline',
      };
    }
    const parsed = CodexMcpElicitationAnswerSchema.parse(reply.value);
    return {
      action: parsed.action,
      ...(parsed.content !== undefined && { content: parsed.content }),
      ...(parsed._meta !== undefined && { _meta: parsed._meta }),
    };
  }
  if (reply.kind !== 'input') {
    throw new TypeError('A Codex input request is answered with input');
  }
  return { answers: CodexUserInputAnswersSchema.parse(reply.value) };
}

/** Answer one pending request owned by the active turn (`turn.respond`). */
export function answerActiveCodexTurnRequest(
  turn: CodexTurnSlot,
  interactionId: string,
  rawReply: InteractionReply['reply'],
): void {
  const waiting = turn.pending.get(interactionId);
  if (waiting === undefined) {
    throw new TypeError(`Unknown interaction ${interactionId} for this turn`);
  }
  const answer = buildCodexRequestAnswer(waiting.detail, rawReply);
  answerEngineRequest(turn, interactionId, answer);
}

/** Answer one pending external request (`event.respond` / `session.respond` / `control.respond`). */
export function answerCodexSessionRequest(input: {
  turn: CodexTurnSlot | undefined;
  externalPending: Map<string, PendingExternalCodexRequest>;
  expectedEntry?: PendingExternalCodexRequest;
  interactionId: string;
  reply: InteractionReply['reply'];
}): void {
  if (input.turn?.pending.has(input.interactionId)) {
    answerActiveCodexTurnRequest(input.turn, input.interactionId, input.reply);
    return;
  }
  const external = input.externalPending.get(input.interactionId);
  if (
    external === undefined ||
    (input.expectedEntry !== undefined && external !== input.expectedEntry)
  ) {
    throw new TypeError(
      `Unknown interaction ${input.interactionId} for this Codex connection`,
    );
  }
  const answer = buildCodexRequestAnswer(external.detail, input.reply);
  input.externalPending.delete(input.interactionId);
  external.resolve(answer);
}
