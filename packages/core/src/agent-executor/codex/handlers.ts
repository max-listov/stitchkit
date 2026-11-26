import { endEngineTurn, holdEngineRequest } from '../engine-requests';
import type { InteractionReply } from '../executor-contract';
import type { PlanLimits } from '../hello';
import { JSON_RPC_METHOD_NOT_FOUND, JsonRpcError, type JsonRpcValue } from '../json-rpc-peer';
import { mergeRateLimitEvent } from '../plan-limits';
import { invokeSafely, offerTurnDelta } from '../session-primitives';
import type { ExecutorDelta } from '../vocabulary';
import { classifyCodexNotification } from './classify';
import { codexPlanWindows } from './limits';
import {
  answerActiveCodexTurnRequest,
  answerCodexSessionRequest,
  type CodexServerRequestMethod,
  type CodexTurnSlot,
  codexStopped,
  codexStoppedAnswer,
  externalCodexTurnIdOf,
  isKnownCodexRequestMethod,
  type PendingExternalCodexRequest,
  parseCodexServerRequest,
} from './request-answers';

const JSON_RPC_INTERNAL_ERROR = -32603;
const MAX_EXTERNAL_PENDING_REQUESTS = 256;

/** Notification observed on a Codex app-server connection (both during and outside `startTurn()`). */
export interface CodexNotificationEvent {
  /** Raw JSON-RPC notification method (e.g. `thread/status/changed`, `turn/started`, `item/plan/delta`). */
  readonly method: string;
  /** Raw JSON-RPC notification params as received from the server. */
  readonly params: JsonRpcValue | undefined;
  /** `true` when a driver-initiated `startTurn()` owned the thread as this notification arrived. */
  readonly duringActiveTurn: boolean;
  /** Normalized executor deltas produced by the classifier, including for external/TUI turns. */
  readonly deltas: readonly ExecutorDelta[];
}

/** Server request received from Codex (outside `startTurn()`, or also during `startTurn()` when `serverRequestDelivery` is `'all'`). */
export interface CodexServerRequestEvent {
  /** JSON-RPC request identifier as a string, also carried on `delta.interactionId`. */
  readonly interactionId: string;
  /** Original JSON-RPC request identifier preserving numeric vs string wire type. */
  readonly requestId: string | number;
  /** Codex server request method (`requestApproval`, `requestUserInput`, or `mcpServer/elicitation/request`). */
  readonly method: CodexServerRequestMethod;
  /** Raw JSON-RPC request params as received from the server. */
  readonly params: JsonRpcValue | undefined;
  /** `true` when a driver-initiated `startTurn()` owned the thread as this request arrived. */
  readonly duringActiveTurn: boolean;
  /** Normalized executor `request` delta preserving approval, permissions, question, or elicitation metadata. */
  readonly delta: Extract<ExecutorDelta, { type: 'request' }>;
  /** Answer this server request once; throws `TypeError` if already resolved or invalid. */
  respond(reply: InteractionReply['reply']): Promise<void>;
}

interface CodexHandlersState {
  profileId: string;
  limits: Map<string, PlanLimits>;
  externalPending: Map<string, PendingExternalCodexRequest>;
  getTurn: () => CodexTurnSlot | undefined;
  clearTurn: () => void;
  onNotification?: (event: CodexNotificationEvent) => void;
  onServerRequest?: (event: CodexServerRequestEvent) => void;
  serverRequestDelivery?: 'external-only' | 'all';
}

function emitCodexNotification(
  state: CodexHandlersState,
  method: string,
  params: JsonRpcValue | undefined,
  duringActiveTurn: boolean,
  deltas: readonly ExecutorDelta[],
): void {
  if (state.onNotification === undefined) return;
  invokeSafely(() => state.onNotification?.({ method, params, duringActiveTurn, deltas }));
}

function handleCodexNotification(
  state: CodexHandlersState,
  method: string,
  params: JsonRpcValue | undefined,
): void {
  const turn = state.getTurn();
  const duringActiveTurn = turn !== undefined;
  const effectiveTurnId = turn?.state.turnId ?? externalCodexTurnIdOf(params);
  let verdict: ReturnType<typeof classifyCodexNotification>;
  try {
    verdict = classifyCodexNotification(
      method,
      params,
      turn?.state ?? { turnId: effectiveTurnId, interruptRequested: false },
    );
  } catch (error) {
    const errorDelta: ExecutorDelta = {
      type: 'error',
      turnId: effectiveTurnId,
      itemId: `unhandled:${method}`,
      raw: { source: 'codex', type: method },
      kind: 'unhandled',
      message: `Codex notification ${method} did not match schema: ${error instanceof Error ? error.message : String(error)}`,
    };
    if (turn !== undefined) offerTurnDelta(turn.channel, errorDelta);
    emitCodexNotification(state, method, params, duringActiveTurn, [errorDelta]);
    return;
  }
  switch (verdict.kind) {
    case 'limits':
      try {
        state.limits.set(
          state.profileId,
          mergeRateLimitEvent({
            previous: state.limits.get(state.profileId),
            windows: codexPlanWindows(verdict.rateLimits),
            now: new Date(),
          }),
        );
        emitCodexNotification(state, method, params, duringActiveTurn, []);
      } catch (error) {
        const errorDelta: ExecutorDelta = {
          type: 'error',
          turnId: effectiveTurnId,
          itemId: `unhandled:${method}`,
          raw: { source: 'codex', type: method },
          kind: 'unhandled',
          message: `Codex rate-limit update could not be merged: ${error instanceof Error ? error.message : String(error)}`,
        };
        if (turn !== undefined) offerTurnDelta(turn.channel, errorDelta);
        emitCodexNotification(state, method, params, duringActiveTurn, [errorDelta]);
      }
      return;
    case 'resolved': {
      const resolvedTurn = turn?.pending.delete(verdict.requestId) === true;
      const externalEntry = state.externalPending.get(verdict.requestId);
      const resolvedExternal = externalEntry !== undefined;
      if (resolvedExternal) state.externalPending.delete(verdict.requestId);
      const resolvedDelta: ExecutorDelta = {
        type: 'request-resolved',
        turnId: resolvedTurn
          ? (turn?.state.turnId ?? effectiveTurnId)
          : (externalEntry?.turnId ?? effectiveTurnId),
        itemId: `resolved:${verdict.requestId}`,
        raw: { source: 'codex', type: 'serverRequest/resolved' },
        interactionId: verdict.requestId,
      };
      if (resolvedTurn && turn !== undefined) offerTurnDelta(turn.channel, resolvedDelta);
      emitCodexNotification(
        state,
        method,
        params,
        duringActiveTurn,
        resolvedTurn || resolvedExternal ? [resolvedDelta] : [],
      );
      return;
    }
    case 'deltas':
    case 'unhandled': {
      const emitted = verdict.kind === 'deltas' ? verdict.deltas : [verdict.delta];
      if (turn !== undefined) {
        for (const delta of emitted) offerTurnDelta(turn.channel, delta);
      }
      emitCodexNotification(state, method, params, duringActiveTurn, emitted);
      return;
    }
    case 'end':
      endEngineTurn(turn, codexStopped, verdict.deltas);
      state.clearTurn();
      emitCodexNotification(state, method, params, duringActiveTurn, verdict.deltas);
      return;
    case 'ignore':
      emitCodexNotification(state, method, params, duringActiveTurn, []);
      return;
  }
}

function handleCodexRequest(
  state: CodexHandlersState,
  method: string,
  params: JsonRpcValue | undefined,
  id: string | number,
): Promise<JsonRpcValue> {
  const turn = state.getTurn();
  if (!isKnownCodexRequestMethod(method)) {
    if (turn !== undefined) {
      offerTurnDelta(turn.channel, {
        type: 'error',
        turnId: turn.state.turnId,
        itemId: `unhandled-request:${id}`,
        raw: { source: 'codex', type: method },
        kind: 'unhandled',
        message: `Codex request ${method} is not known to this driver; refused`,
      });
    }
    throw new JsonRpcError(
      JSON_RPC_METHOD_NOT_FOUND,
      `${method} is not handled by this executor`,
    );
  }
  const interactionId = String(id);
  if (turn !== undefined) {
    const parsed = parseCodexServerRequest(method, params);
    const delta: Extract<ExecutorDelta, { type: 'request' }> = {
      type: 'request',
      turnId: turn.state.turnId,
      itemId: `request:${interactionId}`,
      raw: { source: 'codex', type: method },
      interactionId,
      kind: parsed.kind,
      ...parsed.deltaFields,
    };
    const promise = new Promise<JsonRpcValue>((resolve) => {
      holdEngineRequest(turn, {
        interactionId,
        detail: parsed.detail,
        answeredBy: { source: 'codex', type: method },
        delta: () => delta,
        refusal: codexStoppedAnswer(method),
        resolve,
      });
    });
    if (
      state.serverRequestDelivery === 'all' &&
      state.onServerRequest !== undefined &&
      turn.pending.has(interactionId)
    ) {
      const observer = state.onServerRequest;
      invokeSafely(() =>
        observer({
          interactionId,
          requestId: id,
          method,
          params,
          duringActiveTurn: true,
          delta,
          async respond(reply) {
            answerActiveCodexTurnRequest(turn, interactionId, reply);
          },
        }),
      );
    }
    return promise;
  }
  const observer = state.onServerRequest;
  if (observer === undefined) {
    throw new JsonRpcError(
      JSON_RPC_METHOD_NOT_FOUND,
      `${method} is not handled by this executor`,
    );
  }
  if (state.externalPending.size >= MAX_EXTERNAL_PENDING_REQUESTS) {
    throw new JsonRpcError(
      JSON_RPC_INTERNAL_ERROR,
      `Too many pending external Codex server requests (limit ${MAX_EXTERNAL_PENDING_REQUESTS})`,
    );
  }
  if (state.externalPending.has(interactionId)) {
    throw new JsonRpcError(
      JSON_RPC_INTERNAL_ERROR,
      `Duplicate pending external Codex server request ${interactionId}`,
    );
  }
  const parsed = parseCodexServerRequest(method, params);
  const turnId = externalCodexTurnIdOf(params);
  const delta: Extract<ExecutorDelta, { type: 'request' }> = {
    type: 'request',
    turnId,
    itemId: `request:${interactionId}`,
    raw: { source: 'codex', type: method },
    interactionId,
    kind: parsed.kind,
    ...parsed.deltaFields,
  };
  return new Promise<JsonRpcValue>((resolve, reject) => {
    const entry: PendingExternalCodexRequest = { detail: parsed.detail, turnId, resolve };
    state.externalPending.set(interactionId, entry);
    const onObserverError = (error: unknown) => {
      if (state.externalPending.get(interactionId) !== entry) return;
      state.externalPending.delete(interactionId);
      // Forward only explicit JsonRpcError refusals; isolate arbitrary host exceptions so a local
      // observer crash never leaks internal error strings or kills an active external TUI prompt.
      if (error instanceof JsonRpcError) reject(error);
    };
    try {
      const outcome: unknown = observer({
        interactionId,
        requestId: id,
        method,
        params,
        duringActiveTurn: false,
        delta,
        async respond(reply) {
          answerCodexSessionRequest({
            turn: undefined,
            externalPending: state.externalPending,
            expectedEntry: entry,
            interactionId,
            reply,
          });
        },
      });
      if (
        typeof outcome === 'object' &&
        outcome !== null &&
        'then' in outcome &&
        typeof outcome.then === 'function'
      ) {
        void Promise.resolve(outcome).catch(onObserverError);
      }
    } catch (error) {
      onObserverError(error);
    }
  });
}

/** Create JSON-RPC notification and server-request handlers for a Codex session or control link. */
export function createCodexHandlers(state: CodexHandlersState) {
  return {
    onNotification: (method: string, params: JsonRpcValue | undefined) =>
      handleCodexNotification(state, method, params),
    onRequest: (method: string, params: JsonRpcValue | undefined, id: string | number) =>
      handleCodexRequest(state, method, params, id),
  };
}
