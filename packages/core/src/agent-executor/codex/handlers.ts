import {
  type EngineTurnLiveness,
  endEngineTurn,
  holdEngineRequest,
  leaveEngineRequestUnanswered,
} from '../engine-requests';
import type { InteractionReply } from '../executor-contract';
import { JSON_RPC_METHOD_NOT_FOUND, JsonRpcError, type JsonRpcValue } from '../json-rpc-peer';
import {
  invokeObserver,
  type ObserverErrorHandler,
  offerTurnDelta,
  reportObserverError,
} from '../session-primitives';
import type { ExecutorDelta } from '../vocabulary';
import { classifyCodexNotification } from './classify';
import { codexEventTurn, codexThreadIdOf, codexTurnIdOf } from './event-routing';
import type { CodexLimitBook } from './limits';
import {
  answerActiveCodexTurnRequest,
  answerCodexSessionRequest,
  type CodexServerRequestMethod,
  type CodexTurnSlot,
  codexStopped,
  codexStoppedAnswer,
  codexStoppedReply,
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
  /** Answer this server request once; rejects if the connection is no longer alive, or throws `TypeError` if already resolved or invalid. */
  respond(reply: InteractionReply['reply']): Promise<void>;
}

interface CodexHandlersState {
  profileId: string;
  limits: CodexLimitBook;
  externalPending: Map<string, PendingExternalCodexRequest>;
  liveness: EngineTurnLiveness;
  getTurn: () => CodexTurnSlot | undefined;
  clearTurn: () => void;
  onNotification?: (event: CodexNotificationEvent) => void;
  onServerRequest?: (event: CodexServerRequestEvent) => void;
  serverRequestDelivery?: 'external-only' | 'all';
  onObserverError?: ObserverErrorHandler;
  /**
   * `true` while the owner closes a connection only this driver talks to and the engine can still
   * read: a request arriving then is answered as stopped. After an abort or a lost connection
   * nothing is written, and on a transport shared with a TUI the request is left for it.
   */
  closingGracefully?: () => boolean;
  /**
   * Another client of the same app-server (a TUI on a Unix socket) may answer an external request
   * this driver's observer failed on; without one, a failed observer is answered with a refusal so
   * the engine's turn does not wait forever.
   */
  sharedWithOtherClients: boolean;
}

type CodexObserverOptions = Pick<
  CodexHandlersState,
  'onNotification' | 'onServerRequest' | 'serverRequestDelivery' | 'onObserverError'
>;

/** The observer options of a driver configuration as its handlers take them: absent ones left out. */
export function codexObserverOptions(
  config: {
    readonly [K in keyof CodexObserverOptions]?: CodexObserverOptions[K] | undefined;
  },
): CodexObserverOptions {
  return {
    ...(config.onNotification !== undefined && { onNotification: config.onNotification }),
    ...(config.onServerRequest !== undefined && { onServerRequest: config.onServerRequest }),
    ...(config.serverRequestDelivery !== undefined && {
      serverRequestDelivery: config.serverRequestDelivery,
    }),
    ...(config.onObserverError !== undefined && { onObserverError: config.onObserverError }),
  };
}

function emitCodexNotification(
  state: CodexHandlersState,
  method: string,
  params: JsonRpcValue | undefined,
  duringActiveTurn: boolean,
  deltas: readonly ExecutorDelta[],
): void {
  if (state.onNotification === undefined) return;
  invokeObserver(state.onObserverError, 'onNotification', () =>
    state.onNotification?.({ method, params, duringActiveTurn, deltas }),
  );
}

function handleCodexNotification(
  state: CodexHandlersState,
  method: string,
  params: JsonRpcValue | undefined,
): void {
  const turn = codexEventTurn(state.getTurn(), params);
  const duringActiveTurn = turn !== undefined;
  const effectiveTurnId = turn?.state.turnId ?? codexTurnIdOf(params) ?? 'external';
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
        state.limits.update(state.profileId, verdict.rateLimits, new Date());
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
      const threadId = codexThreadIdOf(params);
      const nativeTurnId = codexTurnIdOf(params);
      const resolvedExternal =
        !resolvedTurn &&
        externalEntry !== undefined &&
        (threadId === undefined ||
          externalEntry.threadId === undefined ||
          threadId === externalEntry.threadId) &&
        (nativeTurnId === undefined || nativeTurnId === externalEntry.turnId);
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
        duringActiveTurn && !resolvedExternal,
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
      if (turn !== undefined) state.clearTurn();
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
  const turn = codexEventTurn(state.getTurn(), params);
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
      turn.pending.has(interactionId) &&
      state.liveness.isAlive()
    ) {
      const observer = state.onServerRequest;
      invokeObserver(state.onObserverError, 'onServerRequest', () =>
        observer({
          interactionId,
          requestId: id,
          method,
          params,
          duringActiveTurn: true,
          delta,
          async respond(reply) {
            answerActiveCodexTurnRequest(turn, state.liveness, interactionId, reply);
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
  const turnId = codexTurnIdOf(params) ?? 'external';
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
    const threadId = codexThreadIdOf(params);
    const entry: PendingExternalCodexRequest = {
      detail: parsed.detail,
      turnId,
      ...(threadId !== undefined && { threadId }),
      resolve,
    };
    state.externalPending.set(interactionId, entry);
    // A `JsonRpcError` is the observer's own refusal of the request, not its failure.
    const report = (error: unknown) => {
      if (!(error instanceof JsonRpcError))
        reportObserverError(state.onObserverError, 'onServerRequest', error);
    };
    const onObserverFailure = (error: unknown) => {
      report(error);
      if (state.externalPending.get(interactionId) !== entry) return;
      state.externalPending.delete(interactionId);
      if (!state.liveness.isAlive()) return;
      // Forward explicit JsonRpcError refusals. Any other host exception never reaches the wire as
      // text: on a connection shared with a TUI it stays unanswered (a human may still answer);
      // on a process only this driver talks to it is answered with a refusal that names nothing.
      if (error instanceof JsonRpcError) reject(error);
      else if (!state.sharedWithOtherClients)
        reject(
          new JsonRpcError(
            JSON_RPC_INTERNAL_ERROR,
            'The executor could not handle this request',
          ),
        );
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
            liveness: state.liveness,
            turn: undefined,
            externalPending: state.externalPending,
            expectedEntry: entry,
            interactionId,
            reply,
          });
        },
      });
      const thenable =
        typeof outcome === 'object' &&
        outcome !== null &&
        'then' in outcome &&
        typeof outcome.then === 'function';
      if (!state.liveness.isAlive()) {
        if (state.externalPending.get(interactionId) === entry) {
          state.externalPending.delete(interactionId);
        }
        if (thenable) void Promise.resolve(outcome).catch(report);
        return;
      }
      if (thenable) {
        void Promise.resolve(outcome).then(() => {
          if (
            !state.liveness.isAlive() &&
            state.externalPending.get(interactionId) === entry
          ) {
            state.externalPending.delete(interactionId);
          }
        }, onObserverFailure);
      }
    } catch (error) {
      onObserverFailure(error);
    }
  });
}

/** Create JSON-RPC notification and server-request handlers for a Codex session or control link. */
export function createCodexHandlers(state: CodexHandlersState) {
  const answerClosedRequest = (method: string): Promise<JsonRpcValue> =>
    state.closingGracefully?.() === true && !state.sharedWithOtherClients
      ? codexStoppedReply(method)
      : leaveEngineRequestUnanswered();
  return {
    onNotification(method: string, params: JsonRpcValue | undefined) {
      if (!state.liveness.isAlive()) return;
      const starting = codexEventTurn(state.getTurn(), params)?.starting;
      const deliver = () => {
        if (!state.liveness.isAlive()) return;
        handleCodexNotification(state, method, params);
      };
      if (starting === undefined || !starting.isBuffering) deliver();
      else starting.defer(params, deliver);
    },
    onRequest(method: string, params: JsonRpcValue | undefined, id: string | number) {
      if (!state.liveness.isAlive()) return answerClosedRequest(method);
      const starting = codexEventTurn(state.getTurn(), params)?.starting;
      const deliver = () =>
        state.liveness.isAlive()
          ? handleCodexRequest(state, method, params, id)
          : answerClosedRequest(method);
      if (starting === undefined || !starting.isBuffering) return deliver();
      return new Promise<JsonRpcValue>((resolve, reject) => {
        const overflow = starting.defer(
          params,
          () => {
            if (!state.liveness.isAlive()) return;
            try {
              resolve(deliver());
            } catch (error) {
              reject(error);
            }
          },
          () => codexStoppedReply(method).then(resolve, reject),
        );
        if (overflow !== undefined) reject(overflow);
      });
    },
  };
}
