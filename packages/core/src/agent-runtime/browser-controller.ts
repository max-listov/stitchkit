import { bindRealtimeClient, type RealtimeClientTransport } from '../browser/realtime-client';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import {
  type AgentBrowserRequest,
  agentControlRealtimeContract,
} from './browser-control-contract';
import {
  type AgentControlDelivery,
  type AgentControlErrorCode,
  type AgentControlResponse,
  type AgentControlView,
  createAgentControlView,
  reduceAgentControlEvent,
  reduceAgentControlSnapshot,
} from './control-schema';
import type { AgentSnapshot } from './schemas';

/**
 * Config for `createAgentController`: a realtime transport, one conversation id, `observe` or
 * `control` access, and optional buffer and timeout limits.
 */
export interface AgentControllerConfig {
  transport: RealtimeClientTransport;
  conversationId: string;
  access: 'observe' | 'control';
  timeoutMs?: number;
  maxBufferedEvents?: number;
  maxBufferedBytes?: number;
  maxPendingRequests?: number;
}

/**
 * Connection status (`connecting` to `closed`), the current conversation view and the last
 * error, as returned by `getSnapshot()`.
 */
export interface AgentControllerState {
  status: 'connecting' | 'ready' | 'disconnected' | 'error' | 'closed';
  view: AgentControlView;
  error?: { code: AgentControlErrorCode; message: string };
}

/**
 * A browser request without `schemaVersion`, `requestId` and `conversationId`; the controller
 * fills those in.
 */
export type AgentBrowserCommand<T extends AgentBrowserRequest = AgentBrowserRequest> =
  T extends unknown ? Omit<T, 'schemaVersion' | 'requestId' | 'conversationId'> : never;

/**
 * Browser handle on one conversation: `getSnapshot` and `subscribe` read state, `request`
 * sends a command, `close` detaches (the transport stays yours).
 */
export interface AgentController {
  getSnapshot(): AgentControllerState;
  subscribe(listener: () => void): () => void;
  request(command: AgentBrowserCommand): Promise<AgentControlResponse>;
  /** Release this attachment; the supplied transport and remote runtime remain application-owned. */
  close(): Promise<void>;
}

/**
 * Preserve active transient progress across a durable refresh; terminal runs lose transient
 * state.
 */
function refreshed(view: AgentControlView, snapshot: AgentSnapshot): AgentControlView {
  const current = view.conversations[snapshot.conversationId];
  if (
    Math.max(
      current?.snapshot?.version ?? 0,
      view.cursor.conversations[snapshot.conversationId]?.snapshotVersion ?? 0,
    ) > snapshot.version
  )
    return view;
  const next = reduceAgentControlSnapshot(view, snapshot);
  const transientByRun = Object.fromEntries(
    Object.entries(current?.transientByRun ?? {}).filter(([id]) =>
      snapshot.runs.some(
        (run) => run.id === id && ['running', 'interrupt_requested'].includes(run.state),
      ),
    ),
  );
  return {
    ...next,
    conversations: {
      ...next.conversations,
      [snapshot.conversationId]: { snapshot, resyncRequired: false, transientByRun },
    },
  };
}

/**
 * One conversation over the existing realtime client; no transport or agent-loop ownership.
 */
export function createAgentController(config: AgentControllerConfig): AgentController {
  return new ConversationController(config);
}

class ConversationController implements AgentController {
  private client;
  private timeoutMs;
  private maxEvents;
  private maxBytes;
  private maxPending;
  private state: AgentControllerState = {
    status: 'connecting',
    view: createAgentControlView(),
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private closed = false;
  private busy = false;
  private buffered: AgentControlDelivery[] = [];
  private bufferedBytes = 0;
  private overflowed = false;
  private refreshScheduled = false;
  private refreshAttempts = 0;
  private tail: Promise<unknown> = Promise.resolve();
  /** In-flight requests of the current connection, each with the way to settle it early. */
  private readonly pending = new Map<object, (reason: Error) => void>();

  private offDelivery: () => void;
  private offConnection: () => void;
  constructor(private config: AgentControllerConfig) {
    this.client = bindRealtimeClient(agentControlRealtimeContract, config.transport);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxEvents = config.maxBufferedEvents ?? 256;
    this.maxBytes = config.maxBufferedBytes ?? 1_048_576;
    this.maxPending = config.maxPendingRequests ?? 32;
    assertPositiveSafeInteger('timeoutMs', this.timeoutMs);
    assertPositiveSafeInteger('maxBufferedEvents', this.maxEvents);
    assertPositiveSafeInteger('maxBufferedBytes', this.maxBytes);
    assertPositiveSafeInteger('maxPendingRequests', this.maxPending);
    if (!config.conversationId) throw new TypeError('conversationId must not be empty');
    this.offDelivery = this.client.on('agent:delivery', (delivery) => this.receive(delivery));
    this.offConnection = this.client.onConnectionChange((connected) =>
      this.changed(connected),
    );
    this.changed(this.client.connected);
  }
  getSnapshot = (): AgentControllerState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: AgentControllerState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private failure(code: AgentControlErrorCode, message: string) {
    this.update({ ...this.state, status: 'error', error: { code, message } });
  }
  private apply(delivery: AgentControlDelivery) {
    if (delivery.type === 'event') {
      this.update({
        ...this.state,
        view: reduceAgentControlEvent(this.state.view, delivery.event),
      });
    } else if (delivery.type === 'access-denied') {
      this.failure('FORBIDDEN', 'Access to the conversation was withdrawn; attach again');
    } else {
      this.failure('EVENT_OVERFLOW', 'Reconnect the transport to restore agent state');
    }
  }
  private scheduleRefresh() {
    if (
      this.refreshScheduled ||
      this.busy ||
      this.pending.size >= this.maxPending ||
      this.state.status !== 'ready' ||
      !this.state.view.conversations[this.config.conversationId]?.resyncRequired
    )
      return;
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (!this.closed && this.state.status === 'ready') {
        if (++this.refreshAttempts > 3) {
          this.failure(
            'RESYNC_EXHAUSTED',
            'Snapshot did not catch up; refresh explicitly to retry',
          );
          return;
        }
        void this.request({ operation: 'snapshot' }).catch(() => {
          /* Failure is exposed by getSnapshot().error. */
        });
      }
    });
  }
  private async execute(
    command: AgentBrowserCommand,
    epoch: number,
  ): Promise<AgentControlResponse> {
    if (this.closed || epoch !== this.generation || !this.client.connected)
      throw new Error('Agent controller is disconnected');
    this.busy = true;
    const requestId = crypto.randomUUID();
    try {
      const response = await this.client.request(
        'agent:control',
        {
          ...command,
          schemaVersion: 1,
          requestId,
          conversationId: this.config.conversationId,
        },
        { timeoutMs: this.timeoutMs },
      );
      if (this.closed || epoch !== this.generation)
        throw new Error('Agent controller connection changed');
      if (response.requestId !== requestId)
        throw new Error('Agent control acknowledgement identity mismatch');
      if (response.outcome === 'error') {
        this.failure(response.error.code, response.error.message);
        return response;
      }
      if (response.snapshot) {
        if (response.snapshot.conversationId !== this.config.conversationId)
          throw new Error('Agent snapshot conversation mismatch');
        this.update({ status: 'ready', view: refreshed(this.state.view, response.snapshot) });
        if (!this.state.view.conversations[this.config.conversationId]?.resyncRequired)
          this.refreshAttempts = 0;
      }
      if (command.operation === 'detach')
        this.update({ ...this.state, status: 'disconnected' });
      return response;
    } catch (error) {
      if (!this.closed && epoch === this.generation)
        this.failure(
          'CONTROL_REQUEST_FAILED',
          error instanceof Error ? error.message : 'Agent request failed',
        );
      throw error;
    } finally {
      if (epoch === this.generation) {
        this.busy = false;
        const deliveries = this.buffered;
        this.buffered = [];
        this.bufferedBytes = 0;
        for (const delivery of deliveries) this.apply(delivery);
        if (this.overflowed) {
          this.overflowed = false;
          this.failure('EVENT_OVERFLOW', 'Refresh agent state before continuing');
        }
      }
    }
  }
  request(command: AgentBrowserCommand): Promise<AgentControlResponse> {
    if (this.closed || this.pending.size >= this.maxPending)
      return Promise.reject(
        new Error(
          this.closed ? 'Agent controller is closed' : 'Agent request capacity exceeded',
        ),
      );
    const entry = {};
    const epoch = this.generation;
    const superseded = new Promise<never>((_resolve, reject) => {
      this.pending.set(entry, reject);
    });
    const result = Promise.race([
      this.tail.then(() => this.execute(command, epoch)),
      superseded,
    ]).finally(() => {
      this.pending.delete(entry);
      this.scheduleRefresh();
    });
    this.tail = result.catch(() => {
      /* Keep serialization usable after a reported failure. */
    });
    return result;
  }
  private receive(delivery: AgentControlDelivery) {
    const conversationId =
      delivery.type === 'event' ? delivery.event.conversationId : delivery.conversationId;
    if (this.closed || conversationId !== this.config.conversationId) return;
    if (this.busy) {
      const bytes = new TextEncoder().encode(JSON.stringify(delivery)).byteLength;
      if (
        this.overflowed ||
        this.buffered.length >= this.maxEvents ||
        this.bufferedBytes + bytes > this.maxBytes
      ) {
        this.overflowed = true;
        this.buffered = [];
        this.bufferedBytes = 0;
      } else {
        this.buffered.push(delivery);
        this.bufferedBytes += bytes;
      }
    } else {
      this.apply(delivery);
      this.scheduleRefresh();
    }
  }
  private changed(connected: boolean) {
    this.generation += 1;
    // Requests of the previous connection can no longer be answered; they must not
    // hold capacity the new attach needs until their own timeouts run out.
    const previous = [...this.pending.values()];
    this.pending.clear();
    for (const settle of previous) settle(new Error('Agent controller connection changed'));
    this.busy = false;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.overflowed = false;
    this.refreshAttempts = 0;
    this.tail = Promise.resolve();
    this.update({
      status: connected ? 'connecting' : 'disconnected',
      view: createAgentControlView(),
    });
    if (connected)
      void this.request({ operation: 'attach', access: this.config.access }).catch(() => {
        /* Failure is exposed by getSnapshot().error. */
      });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.offDelivery();
    this.offConnection();
    this.update({ ...this.state, status: 'closed' });
    if (this.client.connected) {
      const response = await this.client.request(
        'agent:control',
        {
          schemaVersion: 1,
          requestId: crypto.randomUUID(),
          operation: 'detach',
          conversationId: this.config.conversationId,
        },
        { timeoutMs: this.timeoutMs },
      );
      if (
        response.outcome === 'error' &&
        !['CONNECTION_CLOSED', 'FORBIDDEN'].includes(response.error.code)
      )
        throw new Error(`Agent detach failed: ${response.error.code}`);
    }
  }
}
