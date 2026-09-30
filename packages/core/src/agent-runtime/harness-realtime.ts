import { bindRealtimeServer, type RealtimeServerHandle } from '../server/realtime';
import {
  type AgentBrowserRequest,
  agentControlRealtimeContract,
} from './browser-control-contract';
import type { AgentControlResponse } from './control-schema';
import type { HeadlessAgentHarness } from './harness-contract';
import {
  type AgentHarnessControlServerConfig,
  createAgentHarnessControlServer,
} from './harness-control';

export interface AgentHarnessRealtimeConfig<IDENTITY, CONTEXT>
  extends AgentHarnessControlServerConfig {
  /** Verify identity, conversation access and user-supplied file/metadata policy on EVERY call. */
  authorize(input: {
    identity: IDENTITY;
    request: AgentBrowserRequest;
    signal: AbortSignal;
  }): { context: CONTEXT } | null | Promise<{ context: CONTEXT } | null>;
  /** Server-only diagnostic; raw authorization errors are never sent to a browser. */
  onError?(error: unknown): void;
  maxPendingRequests?: number;
  authorizationTimeoutMs?: number;
}

/** Bind the canonical control server to an existing, application-owned Socket.IO server. */
export function bindAgentHarnessRealtime<CONTEXT, IDENTITY>(
  harness: HeadlessAgentHarness<CONTEXT>,
  handle: RealtimeServerHandle<IDENTITY>,
  config: AgentHarnessRealtimeConfig<IDENTITY, CONTEXT>,
): { close(): void } {
  const control = createAgentHarnessControlServer(harness, config);
  const realtime = bindRealtimeServer(agentControlRealtimeContract, handle);
  const cleanups = new Set<() => void>();
  const maxPending = config.maxPendingRequests ?? 32;
  const authTimeout = config.authorizationTimeoutMs ?? 10_000;
  for (const [name, value] of Object.entries({ maxPending, authTimeout })) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`${name} must be a positive safe integer`);
  }
  const unsubscribe = realtime.onConnection(({ raw, events }) => {
    let closed = false;
    const pending = new Set<{ conversationId: string; cancelled: boolean }>();
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
    const authorize = async (request: AgentBrowserRequest) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = new AbortController();
      try {
        return await Promise.race([
          Promise.resolve().then(() =>
            config.authorize({ identity: raw.data, request, signal: abort.signal }),
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Agent authorization timed out')),
              authTimeout,
            );
          }),
        ]);
      } catch (error) {
        report(error);
        return null;
      } finally {
        abort.abort();
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const connection = control.connect({
      id: raw.id,
      async deliver(delivery) {
        const allowed = await authorize({
          schemaVersion: 1,
          requestId: crypto.randomUUID(),
          operation: 'snapshot',
          conversationId: delivery.event.conversationId,
        });
        if (!allowed) {
          await connection.request({
            schemaVersion: 1,
            requestId: crypto.randomUUID(),
            operation: 'detach',
            conversationId: delivery.event.conversationId,
          });
          return;
        }
        if (!closed) events.emit('agent:delivery', delivery);
      },
      onOverflow(delivery) {
        events.emit('agent:delivery', delivery);
        raw.disconnect(true);
      },
    });
    const offRequest = events.on('agent:control', (request, ack) => {
      const fail = (code: string, message: string): AgentControlResponse => ({
        schemaVersion: 1,
        requestId: request.requestId,
        outcome: 'error',
        error: { code, message },
      });
      if (request.operation === 'detach') {
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
        if (!allowed || closed) {
          // Revocation affects only the requested conversation on a shared transport.
          if (!allowed)
            await connection.request({
              schemaVersion: 1,
              requestId: crypto.randomUUID(),
              operation: 'detach',
              conversationId: request.conversationId,
            });
          return {
            schemaVersion: 1,
            requestId: request.requestId,
            outcome: 'error',
            error: { code: 'ACCESS_DENIED', message: 'Agent access denied' },
          };
        }
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
      offRequest();
      raw.off('disconnect', close);
      connection.close();
      cleanups.delete(close);
    };
    raw.on('disconnect', close);
    cleanups.add(close);
  });
  return {
    close() {
      unsubscribe();
      for (const close of cleanups) close();
      control.close();
    },
  };
}
