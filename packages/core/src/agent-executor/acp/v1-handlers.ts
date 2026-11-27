import { holdEngineRequest } from '../engine-requests';
import type { InteractionReply } from '../executor-contract';
import { JSON_RPC_METHOD_NOT_FOUND, JsonRpcError, type JsonRpcValue } from '../json-rpc-peer';
import { invokeSafely, offerTurnDelta } from '../session-primitives';
import type { ExecutorDelta } from '../vocabulary';
import { type AcpUpdateTrack, mapAcpUpdate } from './v1-map';
import {
  ACP_CANCELLED,
  answerAcpSessionRequest,
  answerActiveAcpTurnRequest,
  buildAcpPermissionDeltaFields,
  type PendingExternalAcpRequest,
} from './v1-permission';
import {
  type AcpConfigOption,
  type AcpPermissionRequest,
  AcpPermissionRequestSchema,
  type AcpSessionUpdate,
  AcpSessionUpdateSchema,
  AcpUpdateNotificationSchema,
} from './v1-protocol';
import type { AcpTurnSlot } from './v1-turn';

const JSON_RPC_INTERNAL_ERROR = -32603;
const MAX_EXTERNAL_PENDING_REQUESTS = 256;

/** Optional hook normalizing, expanding, or dropping one incoming `session/update` before mapping. */
export type AcpTransformUpdate = (
  update: AcpSessionUpdate,
) => AcpSessionUpdate | readonly AcpSessionUpdate[] | null | undefined;

/** `session/update` notification observed on an open ACP session (during or after `startTurn()`). */
export interface AcpUpdateEvent {
  /** Session identifier carried on the notification. */
  readonly sessionId: string;
  /** The normalized ACP `session/update` payload (after `transformUpdate`, if configured). */
  readonly update: AcpSessionUpdate;
  /** `true` when a driver-initiated `startTurn()` owned the session as this update arrived. */
  readonly duringActiveTurn: boolean;
  /** Normalized executor deltas produced for this update. */
  readonly deltas: readonly ExecutorDelta[];
}

/** `session/request_permission` received from ACP (outside `startTurn()`, or also during `startTurn()` when `permissionRequestDelivery` is `'all'`). */
export interface AcpPermissionRequestEvent {
  /** JSON-RPC request identifier as a string, also carried on `delta.interactionId`. */
  readonly interactionId: string;
  /** Session identifier carried on the permission request. */
  readonly sessionId: string;
  /** Parsed ACP permission request payload including `toolCall` and full `options`. */
  readonly request: AcpPermissionRequest;
  /** `true` when a driver-initiated `startTurn()` owned the session as this request arrived. */
  readonly duringActiveTurn: boolean;
  /** Normalized executor `request` delta preserving tool input and option metadata. */
  readonly delta: Extract<ExecutorDelta, { type: 'request' }>;
  /** Answer this permission request once; throws `TypeError` if invalid or already resolved. */
  respond(reply: InteractionReply['reply']): Promise<void>;
}

interface AcpHandlersState {
  externalPending: Map<string, PendingExternalAcpRequest>;
  isOpened: () => boolean;
  getTurn: () => AcpTurnSlot | undefined;
  onSessionMeta: (meta: {
    configOptions?: readonly AcpConfigOption[];
    title?: string;
    commands?: readonly string[];
  }) => void;
  transformUpdate?: AcpTransformUpdate;
  onUpdate?: (event: AcpUpdateEvent) => void;
  onPermissionRequest?: (event: AcpPermissionRequestEvent) => Promise<void> | void;
  permissionRequestDelivery?: 'external-only' | 'all';
  onEnd: (error: Error) => void;
}

export function normalizeTransformedUpdates(
  raw: AcpSessionUpdate,
  transform: AcpTransformUpdate | undefined,
): readonly AcpSessionUpdate[] {
  if (transform === undefined) return [raw];
  const result = transform(raw);
  if (result === null || result === undefined) return [];
  if (Array.isArray(result)) {
    return result.map((entry) => AcpSessionUpdateSchema.parse(entry));
  }
  return [AcpSessionUpdateSchema.parse(result)];
}

function handleAcpNotification(
  state: AcpHandlersState,
  externalState: { chunk: number; track: AcpUpdateTrack },
  method: string,
  params: JsonRpcValue | undefined,
): void {
  const turn = state.getTurn();
  if (method !== 'session/update') {
    if (turn !== undefined) {
      turn.chunk += 1;
      offerTurnDelta(turn.channel, {
        type: 'error',
        turnId: turn.state.turnId,
        itemId: `unhandled:${method}:${turn.chunk}`,
        raw: { source: 'acp', type: method },
        kind: 'unhandled',
        message: `ACP notification ${method} is not known to this driver`,
      });
    }
    return;
  }
  const parsed = AcpUpdateNotificationSchema.safeParse(params);
  if (!parsed.success) {
    if (turn !== undefined) {
      turn.chunk += 1;
      offerTurnDelta(turn.channel, {
        type: 'error',
        turnId: turn.state.turnId,
        itemId: `unhandled:session/update:${turn.chunk}`,
        raw: { source: 'acp', type: method },
        kind: 'unhandled',
        message: `ACP update did not match schema: ${parsed.error.message}`,
      });
    }
    return;
  }
  let updates: readonly AcpSessionUpdate[];
  try {
    updates = normalizeTransformedUpdates(parsed.data.update, state.transformUpdate);
  } catch (error) {
    if (turn !== undefined) {
      turn.chunk += 1;
      offerTurnDelta(turn.channel, {
        type: 'error',
        turnId: turn.state.turnId,
        itemId: `unhandled:session/update:${turn.chunk}`,
        raw: { source: 'acp', type: method },
        kind: 'unhandled',
        message: `ACP transformUpdate failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return;
  }
  const opened = state.isOpened();
  for (const update of updates) {
    state.onSessionMeta({
      ...(update.configOptions !== undefined && { configOptions: update.configOptions }),
      ...(update.sessionUpdate === 'session_info_update' &&
        typeof update.title === 'string' && { title: update.title }),
      ...(update.availableCommands !== undefined && {
        commands: update.availableCommands.map((command) => command.name),
      }),
    });
    let deltas: readonly ExecutorDelta[] = [];
    if (turn !== undefined) {
      turn.chunk += 1;
      deltas = mapAcpUpdate(update, turn.state.turnId, turn.chunk, turn.track);
      for (const delta of deltas) offerTurnDelta(turn.channel, delta);
    } else if (opened && state.onUpdate !== undefined) {
      externalState.chunk += 1;
      deltas = mapAcpUpdate(update, 'external', externalState.chunk, externalState.track);
    }
    if (opened && state.onUpdate !== undefined) {
      const event: AcpUpdateEvent = {
        sessionId: parsed.data.sessionId,
        update,
        duringActiveTurn: turn !== undefined,
        deltas,
      };
      invokeSafely(() => state.onUpdate?.(event));
    }
  }
}

function handleAcpRequest(
  state: AcpHandlersState,
  method: string,
  params: JsonRpcValue | undefined,
  id: string | number,
): Promise<JsonRpcValue> {
  const turn = state.getTurn();
  if (method !== 'session/request_permission') {
    if (turn !== undefined) {
      offerTurnDelta(turn.channel, {
        type: 'error',
        turnId: turn.state.turnId,
        itemId: `unhandled-request:${id}`,
        raw: { source: 'acp', type: method },
        kind: 'unhandled',
        message: `ACP request ${method} is not known to this driver; refused`,
      });
    }
    throw new JsonRpcError(
      JSON_RPC_METHOD_NOT_FOUND,
      `${method} is not handled by this executor`,
    );
  }
  const interactionId = String(id);
  if (turn !== undefined) {
    const asked = AcpPermissionRequestSchema.parse(params);
    const delta: Extract<ExecutorDelta, { type: 'request' }> = {
      type: 'request',
      turnId: turn.state.turnId,
      itemId: `request:${interactionId}`,
      raw: { source: 'acp', type: method },
      interactionId,
      kind: 'approval',
      ...buildAcpPermissionDeltaFields(asked),
    };
    const promise = new Promise<JsonRpcValue>((resolve) => {
      holdEngineRequest(turn, {
        interactionId,
        detail: { options: asked.options },
        answeredBy: { source: 'acp', type: method },
        delta: () => delta,
        refusal: ACP_CANCELLED,
        resolve,
      });
    });
    if (
      state.permissionRequestDelivery === 'all' &&
      state.onPermissionRequest !== undefined &&
      turn.pending.has(interactionId)
    ) {
      const observer = state.onPermissionRequest;
      invokeSafely(() =>
        observer({
          interactionId,
          sessionId: asked.sessionId,
          request: asked,
          duringActiveTurn: true,
          delta,
          async respond(reply) {
            answerActiveAcpTurnRequest(turn, interactionId, reply);
          },
        }),
      );
    }
    return promise;
  }
  const observer = state.onPermissionRequest;
  if (observer === undefined || !state.isOpened()) {
    throw new JsonRpcError(
      JSON_RPC_METHOD_NOT_FOUND,
      `${method} is not handled by this executor`,
    );
  }
  if (state.externalPending.size >= MAX_EXTERNAL_PENDING_REQUESTS) {
    throw new JsonRpcError(
      JSON_RPC_INTERNAL_ERROR,
      `Too many pending external ACP permission requests (limit ${MAX_EXTERNAL_PENDING_REQUESTS})`,
    );
  }
  if (state.externalPending.has(interactionId)) {
    throw new JsonRpcError(
      JSON_RPC_INTERNAL_ERROR,
      `Duplicate pending external ACP permission request ${interactionId}`,
    );
  }
  const asked = AcpPermissionRequestSchema.parse(params);
  const delta: Extract<ExecutorDelta, { type: 'request' }> = {
    type: 'request',
    turnId: 'external',
    itemId: `request:${interactionId}`,
    raw: { source: 'acp', type: method },
    interactionId,
    kind: 'approval',
    ...buildAcpPermissionDeltaFields(asked),
  };
  return new Promise<JsonRpcValue>((resolve, reject) => {
    const entry: PendingExternalAcpRequest = { detail: { options: asked.options }, resolve };
    state.externalPending.set(interactionId, entry);
    const onObserverError = (error: unknown) => {
      if (state.externalPending.get(interactionId) !== entry) return;
      state.externalPending.delete(interactionId);
      // Forward explicit JsonRpcError refusals; isolate arbitrary host exceptions as a clean
      // cancellation so internal host errors never leak and the stdio agent is never left hanging.
      if (error instanceof JsonRpcError) reject(error);
      else resolve(ACP_CANCELLED);
    };
    try {
      const outcome: unknown = observer({
        interactionId,
        sessionId: asked.sessionId,
        request: asked,
        duringActiveTurn: false,
        delta,
        async respond(reply) {
          answerAcpSessionRequest({
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

/** Create JSON-RPC notification, permission-request, and disconnect handlers for an ACP session. */
export function createAcpHandlers(state: AcpHandlersState) {
  const externalState: { chunk: number; track: AcpUpdateTrack } = {
    chunk: 0,
    track: { segment: 0, toolNames: new Map() },
  };
  return {
    onNotification: (method: string, params: JsonRpcValue | undefined) =>
      handleAcpNotification(state, externalState, method, params),
    onRequest: (method: string, params: JsonRpcValue | undefined, id: string | number) =>
      handleAcpRequest(state, method, params, id),
    onEnd: state.onEnd,
  };
}
