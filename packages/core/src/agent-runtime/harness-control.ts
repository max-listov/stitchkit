import { assertPositiveSafeInteger } from '../internal/positive-integer';
import {
  type AgentControlDelivery,
  type AgentControlErrorCode,
  type AgentControlRequest,
  AgentControlRequestSchema,
  type AgentControlResponse,
  AgentControlResponseSchema,
} from './control-schema';
import { type AgentRuntimeEventSink, createAgentRuntimeEventSink } from './events';
import type { HeadlessAgentHarness } from './harness-contract';
import type { AgentSnapshot } from './schemas';

export interface AgentHarnessControlConnection {
  request(input: AgentControlRequest): Promise<AgentControlResponse>;
  close(): void;
}

export interface AgentHarnessControlServer {
  connect(input: {
    id: string;
    deliver(delivery: Extract<AgentControlDelivery, { type: 'event' }>): void | Promise<void>;
    /** Out-of-band: close/abort the transport, then reconnect and request a snapshot. */
    onOverflow(delivery: Extract<AgentControlDelivery, { type: 'resync-required' }>): void;
  }): AgentHarnessControlConnection;
  close(): void;
}

export interface AgentHarnessControlServerConfig {
  maxPendingEvents?: number;
  /** Maximum concurrent snapshot-backed attachment requests across this server. */
  maxPendingAttachments?: number;
}

/** Transport-neutral correlated control with observer attachments and exclusive mutation leases. */
/**
 * The operations that need the controller lease — interrupt, answer an
 * approval, submit — once the lease is proven. Each answers with the snapshot
 * the operation left behind.
 */
async function runControlledOperation<CONTEXT>(
  harness: HeadlessAgentHarness<CONTEXT>,
  request: Extract<
    AgentControlRequest,
    { operation: 'interrupt' | 'respond-approval' | 'submit' }
  >,
): Promise<AgentControlResponse> {
  if (request.operation === 'interrupt') {
    await harness.interrupt({
      conversationId: request.conversationId,
      runId: request.runId,
    });
    return AgentControlResponseSchema.parse({
      schemaVersion: 1,
      requestId: request.requestId,
      outcome: 'ok',
      snapshot: await harness.snapshot(request.conversationId),
    });
  }
  if (request.operation === 'respond-approval') {
    const ticket = await harness.respondToApproval({
      conversationId: request.conversationId,
      approvalId: request.approvalId,
      approved: request.approved,
      ...(request.reason && { reason: request.reason }),
      context: request.context,
      ...(request.metadata !== undefined && { metadata: request.metadata }),
    });
    const admission = await ticket.admission;
    return AgentControlResponseSchema.parse({
      schemaVersion: 1,
      requestId: request.requestId,
      outcome: 'ok',
      runId: admission.runId,
      snapshot: await harness.snapshot(request.conversationId),
    });
  }
  const ticket = harness.submit({
    conversationId: request.conversationId,
    idempotencyKey: request.idempotencyKey,
    context: request.context,
    parts: request.parts,
    ...(request.metadata !== undefined && { metadata: request.metadata }),
  });
  const admission = await ticket.admission;
  return AgentControlResponseSchema.parse({
    schemaVersion: 1,
    requestId: request.requestId,
    outcome: 'ok',
    runId: admission.runId,
    snapshot: await harness.snapshot(request.conversationId),
  });
}

function controlFailure(
  requestId: string,
  code: AgentControlErrorCode,
  message: string,
): AgentControlResponse {
  return AgentControlResponseSchema.parse({
    schemaVersion: 1,
    requestId,
    outcome: 'error',
    error: { code, message },
  });
}

function attachmentLimit(config: AgentHarnessControlServerConfig): number {
  const limit = config.maxPendingAttachments ?? 32;
  assertPositiveSafeInteger('maxPendingAttachments', limit);
  return limit;
}

function connectionState(
  config: AgentHarnessControlServerConfig,
  {
    deliver,
    onOverflow,
  }: Pick<Parameters<AgentHarnessControlServer['connect']>[0], 'deliver' | 'onOverflow'>,
  disconnect: () => void,
) {
  const state = {
    attached: new Map<string, 'observe' | 'control'>(),
    pendingAttachments: new Set<string>(),
    cancelledAttachments: new Set<string>(),
    overflowed: false,
    sink: createAgentRuntimeEventSink({
      write: (event) => deliver({ schemaVersion: 1, type: 'event', event }),
      maxPending: config.maxPendingEvents ?? 128,
      onDrop: ({ event }) => {
        if (state.overflowed) return;
        state.overflowed = true;
        onOverflow({
          schemaVersion: 1,
          type: 'resync-required',
          conversationId: event.conversationId,
          reason: 'overflow',
        });
        disconnect();
      },
    }),
  };
  return state;
}

export function createAgentHarnessControlServer<CONTEXT>(
  harness: HeadlessAgentHarness<CONTEXT>,
  config: AgentHarnessControlServerConfig = {},
): AgentHarnessControlServer {
  const maxPendingAttachments = attachmentLimit(config);
  const connections = new Map<
    string,
    {
      attached: Map<string, 'observe' | 'control'>;
      pendingAttachments: Set<string>;
      cancelledAttachments: Set<string>;
      sink: AgentRuntimeEventSink;
      overflowed: boolean;
    }
  >();
  const controllers = new Map<string, string>();
  let pendingAttachments = 0;
  let closed = false;
  const unsubscribe = harness.subscribe((event) => {
    for (const connection of connections.values()) {
      if (connection.attached.has(event.conversationId) && !connection.overflowed) {
        connection.sink.publish(event);
      }
    }
  });
  const detach = (connectionId: string): void => {
    const connection = connections.get(connectionId);
    if (!connection) return;
    for (const conversationId of connection.attached.keys()) {
      if (controllers.get(conversationId) === connectionId) {
        controllers.delete(conversationId);
      }
    }
    void connection.sink.close();
    connections.delete(connectionId);
  };
  return {
    connect({ id, deliver, onOverflow }) {
      if (closed) throw new Error('Agent harness control server is closed');
      if (connections.has(id))
        throw new Error('Agent harness control connection id is duplicate');
      const state = connectionState(config, { deliver, onOverflow }, () => detach(id));
      connections.set(id, state);
      return {
        async request(raw) {
          const request = AgentControlRequestSchema.parse(raw);
          const fail = (code: AgentControlErrorCode, message: string) =>
            controlFailure(request.requestId, code, message);
          if (closed || connections.get(id) !== state)
            return fail('CONNECTION_CLOSED', 'Connection is closed');
          try {
            if (request.operation === 'attach') {
              if (state.pendingAttachments.has(request.conversationId)) {
                return fail(
                  'ATTACH_IN_PROGRESS',
                  'Wait for the current attachment request to settle',
                );
              }
              if (pendingAttachments >= maxPendingAttachments) {
                return fail(
                  'ATTACHMENT_CAPACITY',
                  'Too many attachment snapshots are pending on this control server',
                );
              }
              const owner = controllers.get(request.conversationId);
              if (request.access === 'control' && owner && owner !== id) {
                return fail('LEASE_CONFLICT', 'Conversation already has a controller');
              }
              const previousAccess = state.attached.get(request.conversationId);
              const previousController = controllers.get(request.conversationId);
              pendingAttachments += 1;
              state.pendingAttachments.add(request.conversationId);
              // A new observer must receive events while its snapshot is pending. An
              // existing attachment already receives them and keeps its committed access
              // until the replacement snapshot succeeds.
              if (!previousAccess) state.attached.set(request.conversationId, request.access);
              if (request.access === 'control') controllers.set(request.conversationId, id);
              // Attach before reading: a transport adapter can install its delivery callback,
              // issue this request and finitely buffer every event after the snapshot point.
              // Snapshot-then-attach silently loses an event in the await between them.
              let snapshot: AgentSnapshot;
              try {
                snapshot = await harness.snapshot(request.conversationId);
              } catch (error) {
                if (
                  connections.get(id) === state &&
                  !state.cancelledAttachments.delete(request.conversationId)
                ) {
                  if (previousAccess)
                    state.attached.set(request.conversationId, previousAccess);
                  else state.attached.delete(request.conversationId);
                  if (
                    request.access === 'control' &&
                    controllers.get(request.conversationId) === id &&
                    previousController
                  ) {
                    controllers.set(request.conversationId, previousController);
                  } else if (
                    request.access === 'control' &&
                    controllers.get(request.conversationId) === id
                  ) {
                    controllers.delete(request.conversationId);
                  }
                }
                throw error;
              } finally {
                pendingAttachments -= 1;
                state.pendingAttachments.delete(request.conversationId);
              }
              if (closed || connections.get(id) !== state) {
                return fail('CONNECTION_CLOSED', 'Connection is closed');
              }
              if (state.cancelledAttachments.delete(request.conversationId)) {
                return fail(
                  'ATTACH_CANCELLED',
                  'Attachment was detached while its snapshot was pending',
                );
              }
              state.attached.set(request.conversationId, request.access);
              if (
                request.access === 'observe' &&
                controllers.get(request.conversationId) === id
              ) {
                controllers.delete(request.conversationId);
              }
              return AgentControlResponseSchema.parse({
                schemaVersion: 1,
                requestId: request.requestId,
                outcome: 'ok',
                snapshot,
              });
            }
            if (request.operation === 'detach') {
              if (state.pendingAttachments.has(request.conversationId)) {
                state.cancelledAttachments.add(request.conversationId);
              }
              if (controllers.get(request.conversationId) === id)
                controllers.delete(request.conversationId);
              state.attached.delete(request.conversationId);
              return AgentControlResponseSchema.parse({
                schemaVersion: 1,
                requestId: request.requestId,
                outcome: 'ok',
              });
            }
            if (state.pendingAttachments.has(request.conversationId)) {
              return fail(
                'ATTACH_IN_PROGRESS',
                'Wait for the current attachment request to settle',
              );
            }
            if (!state.attached.has(request.conversationId))
              return fail('NOT_ATTACHED', 'Attach before requesting conversation state');
            if (request.operation === 'snapshot') {
              const snapshot = await harness.snapshot(request.conversationId);
              return AgentControlResponseSchema.parse({
                schemaVersion: 1,
                requestId: request.requestId,
                outcome: 'ok',
                snapshot,
              });
            }
            if (
              state.attached.get(request.conversationId) !== 'control' ||
              controllers.get(request.conversationId) !== id
            ) {
              return fail('LEASE_REQUIRED', 'An active controller lease is required');
            }
            return await runControlledOperation(harness, request);
          } catch {
            return fail('REQUEST_REJECTED', 'Control request was rejected');
          }
        },
        close() {
          detach(id);
        },
      };
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const id of [...connections.keys()]) detach(id);
    },
  };
}
