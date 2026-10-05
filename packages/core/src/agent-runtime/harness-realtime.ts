import { raceAbort } from '../internal/abort-race';
import { withSignalDeadline } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { MAX_TIMER_MS } from '../internal/timers';
import { bindRealtimeServer, type RealtimeServerHandle } from '../server/realtime';
import {
  type AgentBrowserRequest,
  agentControlRealtimeContract,
} from './browser-control-contract';
import type { AgentControlErrorCode, AgentControlResponse } from './control-schema';
import type { HeadlessAgentHarness } from './harness-contract';
import {
  type AgentHarnessControlServerConfig,
  createAgentHarnessControlServer,
} from './harness-control';

/**
 * Config for `bindAgentHarnessRealtime`: the harness control settings plus `authorize`, which
 * runs on every browser request and decides access.
 */
export interface AgentHarnessRealtimeConfig<IDENTITY, CONTEXT>
  extends AgentHarnessControlServerConfig {
  /**
   * Verify identity, conversation access and user-supplied file/metadata policy on EVERY
   * request. The events of an attached conversation are delivered under the grant the
   * latest successful request created, without one call per event; the binding's
   * `revoke()` ends that grant, and the next event is delivered only if this hook
   * answers again for an `operation: 'snapshot'` request of that conversation.
   */
  authorize(input: {
    identity: IDENTITY;
    request: AgentBrowserRequest;
    /**
     * `delivery` when the check guards an event that is about to be sent and no
     * request of the browser is involved; `request` is a `snapshot` request the
     * browser itself made, or any other operation.
     */
    source: 'request' | 'delivery';
    signal: AbortSignal;
  }): { context: CONTEXT } | null | Promise<{ context: CONTEXT } | null>;
  /** Server-only diagnostic; raw authorization errors are never sent to a browser. */
  onError?(error: unknown): void;
  maxPendingRequests?: number;
  authorizationTimeoutMs?: number;
}

/**
 * Handle returned by `bindAgentHarnessRealtime`: `close()` unbinds, `revoke()` withdraws a
 * conversation's access.
 */
export interface AgentHarnessRealtimeBinding<IDENTITY> {
  close(): void;
  /**
   * Signal that access to a conversation may have been withdrawn. The delivery grant of
   * every matching socket (all sockets when `matches` is omitted) is dropped; the next
   * event of that conversation is re-authorized, and a refusal detaches it and tells the
   * browser with an `access-denied` delivery. A request is always authorized on arrival.
   */
  revoke(conversationId: string, matches?: (identity: IDENTITY) => boolean): void;
}

interface SocketGrants<IDENTITY> {
  identity: IDENTITY;
  /** Conversations whose events may be delivered without asking the hook again. */
  granted: Set<string>;
  /** Bumped by every revoke, so an authorization that began before one cannot grant. */
  revocations: Map<string, number>;
  /** Conversations refused during delivery; their queued events are dropped. */
  refused: Set<string>;
}

/**
 * Ask the application's `authorize` hook under a deadline. A hook failure or timeout is reported
 * and answers "no access". The hook's signal also aborts once it settles, so a hook cannot keep
 * working for a decision nobody awaits.
 */
async function askAuthorizationHook<IDENTITY, CONTEXT>(input: {
  config: AgentHarnessRealtimeConfig<IDENTITY, CONTEXT>;
  identity: IDENTITY;
  request: AgentBrowserRequest;
  source: 'request' | 'delivery';
  timeoutMs: number;
  report(error: unknown): void;
}): Promise<{ context: CONTEXT } | null> {
  const { config, identity, request, source, timeoutMs, report } = input;
  const settled = new AbortController();
  try {
    return await withSignalDeadline(
      timeoutMs,
      undefined,
      () => new Error('Agent authorization timed out'),
      (deadline) => {
        const signal = AbortSignal.any([deadline, settled.signal]);
        return raceAbort(
          Promise.resolve().then(() =>
            config.authorize({ identity, request, source, signal }),
          ),
          signal,
        );
      },
    );
  } catch (error) {
    report(error);
    return null;
  } finally {
    settled.abort();
  }
}

/**
 * Bind the canonical control server to an existing, application-owned Socket.IO server.
 */
export function bindAgentHarnessRealtime<CONTEXT, IDENTITY>(
  harness: HeadlessAgentHarness<CONTEXT>,
  handle: RealtimeServerHandle<IDENTITY>,
  config: AgentHarnessRealtimeConfig<IDENTITY, CONTEXT>,
): AgentHarnessRealtimeBinding<IDENTITY> {
  const control = createAgentHarnessControlServer(harness, config);
  const realtime = bindRealtimeServer(agentControlRealtimeContract, handle);
  const cleanups = new Set<() => void>();
  const sockets = new Set<SocketGrants<IDENTITY>>();
  const maxPending = config.maxPendingRequests ?? 32;
  const authTimeout = config.authorizationTimeoutMs ?? 10_000;
  assertPositiveSafeInteger('maxPendingRequests', maxPending);
  assertPositiveSafeInteger('authorizationTimeoutMs', authTimeout);
  if (authTimeout > MAX_TIMER_MS) {
    throw new RangeError('authorizationTimeoutMs exceeds the timer range');
  }
  const unsubscribe = realtime.onConnection(({ raw, events }) => {
    let closed = false;
    const grants: SocketGrants<IDENTITY> = {
      identity: raw.data,
      granted: new Set(),
      revocations: new Map(),
      refused: new Set(),
    };
    sockets.add(grants);
    const pending = new Set<{ conversationId: string; cancelled: boolean }>();
    const deciding = new Map<string, ReturnType<typeof authorize>>();
    const report = (error: unknown) => {
      try {
        if (config.onError) config.onError(error);
        else console.error('[stitchkit] agent control authorization failed', error);
      } catch (observerError) {
        console.error('[stitchkit] agent control error observer failed', {
          error,
          observerError,
        });
      }
    };
    const authorize = async (
      request: AgentBrowserRequest,
      source: 'request' | 'delivery' = 'request',
    ) => {
      const startedAt = grants.revocations.get(request.conversationId) ?? 0;
      let allowed = await askAuthorizationHook({
        config,
        identity: raw.data,
        request,
        source,
        timeoutMs: authTimeout,
        report,
      });
      // A revoke that arrived while the hook was deciding outranks its answer.
      if (allowed && (grants.revocations.get(request.conversationId) ?? 0) !== startedAt) {
        allowed = null;
      }
      if (allowed && request.operation !== 'detach') {
        grants.granted.add(request.conversationId);
        if (request.operation === 'attach') grants.refused.delete(request.conversationId);
      } else grants.granted.delete(request.conversationId);
      return allowed;
    };
    const connection = control.connect({
      id: raw.id,
      async deliver(delivery) {
        const { conversationId } = delivery.event;
        if (grants.refused.has(conversationId)) return;
        if (!grants.granted.has(conversationId)) {
          // Deliveries that arrive while the hook is deciding share its one answer.
          let decision = deciding.get(conversationId);
          if (!decision) {
            decision = authorize(
              {
                schemaVersion: 1,
                requestId: crypto.randomUUID(),
                operation: 'snapshot',
                conversationId,
              },
              'delivery',
            ).finally(() => deciding.delete(conversationId));
            deciding.set(conversationId, decision);
          }
          const allowed = await decision;
          if (!allowed) {
            if (grants.refused.has(conversationId)) return;
            grants.refused.add(conversationId);
            await connection.request({
              schemaVersion: 1,
              requestId: crypto.randomUUID(),
              operation: 'detach',
              conversationId,
            });
            if (!closed) {
              events.emit('agent:delivery', {
                schemaVersion: 1,
                type: 'access-denied',
                conversationId,
              });
            }
            return;
          }
        }
        if (!closed) events.emit('agent:delivery', delivery);
      },
      onOverflow(delivery) {
        events.emit('agent:delivery', delivery);
        raw.disconnect(true);
      },
    });
    const offRequest = events.on('agent:control', (request, ack) => {
      const fail = (code: AgentControlErrorCode, message: string): AgentControlResponse => ({
        schemaVersion: 1,
        requestId: request.requestId,
        outcome: 'error',
        error: { code, message },
      });
      if (request.operation === 'detach') {
        grants.granted.delete(request.conversationId);
        for (const entry of pending)
          if (entry.conversationId === request.conversationId) entry.cancelled = true;
        // A peer may always release its own lease, including while authorization is pending.
        void connection.request(request);
      }
      if (pending.size >= maxPending) {
        ack(fail('REQUEST_CAPACITY', 'Too many agent requests are pending'));
        return;
      }
      const entry = { conversationId: request.conversationId, cancelled: false };
      pending.add(entry);
      const execute = async (): Promise<AgentControlResponse> => {
        const allowed = await authorize(request);
        if (entry.cancelled) return fail('REQUEST_CANCELLED', 'Agent request was detached');
        if (!allowed) {
          // Revocation affects only the requested conversation on a shared transport.
          await connection.request({
            schemaVersion: 1,
            requestId: crypto.randomUUID(),
            operation: 'detach',
            conversationId: request.conversationId,
          });
          return fail('FORBIDDEN', 'Agent access denied');
        }
        if (closed) return fail('CONNECTION_CLOSED', 'Connection is closed');
        return connection.request(
          request.operation === 'submit' || request.operation === 'respond-approval'
            ? { ...request, context: allowed.context }
            : request,
        );
      };
      void execute()
        .then(ack)
        .catch(report)
        .finally(() => {
          pending.delete(entry);
        });
    });
    const close = () => {
      if (closed) return;
      closed = true;
      sockets.delete(grants);
      offRequest();
      raw.off('disconnect', close);
      connection.close();
      cleanups.delete(close);
    };
    raw.on('disconnect', close);
    cleanups.add(close);
  });
  return {
    revoke(conversationId, matches) {
      for (const socket of sockets) {
        if (matches && !matches(socket.identity)) continue;
        socket.granted.delete(conversationId);
        socket.revocations.set(
          conversationId,
          (socket.revocations.get(conversationId) ?? 0) + 1,
        );
      }
    },
    close() {
      unsubscribe();
      for (const close of cleanups) close();
      control.close();
    },
  };
}
