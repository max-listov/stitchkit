import { expect, test } from 'bun:test';
import type { RealtimeClientTransport } from '../src/browser/realtime-client';
import type {
  AgentControlDelivery,
  AgentControlResponse,
  AgentSnapshot,
} from '../src/entrypoints/agent-runtime/browser';
import {
  AgentBrowserRequestSchema,
  createAgentController,
} from '../src/entrypoints/agent-runtime/browser';
import { eventually } from './support/agent-composition';
import { eventLoopTurn } from './support/until';

function fixture() {
  let connected = true;
  const listeners = new Set<(connected: boolean) => void>();
  const events = new Set<(...args: unknown[]) => void>();
  const requests: Array<{
    request: ReturnType<typeof AgentBrowserRequestSchema.parse>;
    respond(response: AgentControlResponse): void;
  }> = [];
  const transport: RealtimeClientTransport = {
    get connected() {
      return connected;
    },
    on: (_event, listener) => {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    emit: () => true,
    emitWithAck: (_event, args) =>
      new Promise((respond) => {
        requests.push({ request: AgentBrowserRequestSchema.parse(args[0]), respond });
      }),
    onConnectionChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const snapshot = (version: number): AgentSnapshot => ({
    schemaVersion: 1,
    conversationId: 'one',
    version,
    runs: [],
    messages: [],
  });
  return {
    transport,
    requests,
    snapshot,
    deliver(delivery: AgentControlDelivery) {
      for (const event of events) event(delivery);
    },
    connection(value: boolean) {
      connected = value;
      for (const listener of listeners) listener(value);
    },
    respond(index: number, version: number) {
      const pending = requests[index];
      if (!pending) throw new Error('Missing request');
      pending.respond({
        schemaVersion: 1,
        requestId: pending.request.requestId,
        outcome: 'ok',
        snapshot: snapshot(version),
      });
    },
    listeners,
  };
}

test('controller rejects excess requests before sending and validates finite configuration', async () => {
  const f = fixture();
  const controller = createAgentController({
    transport: f.transport,
    conversationId: 'one',
    access: 'observe',
    maxPendingRequests: 1,
  });
  await eventually(() => f.requests.length === 1);
  await expect(controller.request({ operation: 'snapshot' })).rejects.toThrow('capacity');
  expect(f.requests).toHaveLength(1);
  f.respond(0, 1);
  await eventually(() => controller.getSnapshot().status === 'ready');
  f.connection(false);
  await controller.close();
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.1]) {
    expect(() =>
      createAgentController({
        transport: f.transport,
        conversationId: 'one',
        access: 'observe',
        timeoutMs: value,
      }),
    ).toThrow('positive safe integer');
  }
});

test('controller fences old acknowledgements, bounds event count and bytes, and keeps shared transport ownership', async () => {
  for (const limits of [{ maxBufferedEvents: 1 }, { maxBufferedBytes: 1 }]) {
    const f = fixture();
    const controller = createAgentController({
      transport: f.transport,
      conversationId: 'one',
      access: 'observe',
      ...limits,
    });
    await eventually(() => f.requests.length === 1);
    f.connection(false);
    f.connection(true);
    await eventually(() => f.requests.length === 2);
    f.respond(1, 5);
    await eventually(() => controller.getSnapshot().status === 'ready');
    f.respond(0, 1);
    await eventLoopTurn();
    expect(controller.getSnapshot().view.conversations.one?.snapshot?.version).toBe(5);
    const pending = controller.request({ operation: 'snapshot' });
    await eventually(() => f.requests.length === 3);
    for (let sequence = 1; sequence <= 2; sequence += 1)
      f.deliver({
        schemaVersion: 1,
        type: 'event',
        event: {
          type: 'assistant-delta',
          conversationId: 'one',
          runId: 'run',
          runtimeEpoch: 'epoch',
          sequence,
          textDelta: 'partial',
          emittedAt: new Date().toISOString(),
        },
      });
    f.respond(2, 6);
    await pending;
    expect(controller.getSnapshot().error?.code).toBe('EVENT_OVERFLOW');
    f.connection(false);
    await controller.close();
    expect(f.listeners.size).toBe(0);
  }
});

test('controller coalesces gaps during attach and reports denied or mismatched replies', async () => {
  const f = fixture();
  const controller = createAgentController({
    transport: f.transport,
    conversationId: 'one',
    access: 'control',
    maxPendingRequests: 1,
  });
  await eventually(() => f.requests.length === 1);
  for (const sequence of [2, 3])
    f.deliver({
      schemaVersion: 1,
      type: 'event',
      event: {
        type: 'assistant-delta',
        conversationId: 'one',
        runId: 'run',
        runtimeEpoch: 'epoch',
        sequence,
        textDelta: 'partial',
        emittedAt: new Date().toISOString(),
      },
    });
  f.respond(0, 1);
  await eventually(() => f.requests.length === 2);
  expect(f.requests[1]?.request.operation).toBe('snapshot');
  f.respond(1, 2);
  await eventually(
    () => controller.getSnapshot().view.conversations.one?.snapshot?.version === 2,
  );
  expect(f.requests).toHaveLength(2);
  const pending = controller.request({ operation: 'interrupt', runId: 'run' });
  await eventually(() => f.requests.length === 3);
  f.requests[2]?.respond({ schemaVersion: 1, requestId: 'wrong', outcome: 'ok' });
  await expect(pending).rejects.toThrow('identity mismatch');
  expect(controller.getSnapshot().error?.code).toBe('CONTROL_REQUEST_FAILED');
  f.connection(false);
  await controller.close();
});

test('a reconnect releases the capacity held by the previous connection and attaches', async () => {
  const f = fixture();
  const controller = createAgentController({
    transport: f.transport,
    conversationId: 'one',
    access: 'observe',
    maxPendingRequests: 1,
  });
  await eventually(() => f.requests.length === 1);
  f.respond(0, 1);
  await eventually(() => controller.getSnapshot().status === 'ready');
  const inFlight = controller.request({ operation: 'snapshot' });
  const settled = inFlight.then(
    () => 'answered',
    (error: unknown) => (error instanceof Error ? error.message : 'rejected'),
  );
  await eventually(() => f.requests.length === 2);
  f.connection(false);
  f.connection(true);
  expect(await settled).toBe('Agent controller connection changed');
  await eventually(() => f.requests.length === 3);
  expect(f.requests[2]?.request.operation).toBe('attach');
  f.respond(2, 2);
  await eventually(() => controller.getSnapshot().status === 'ready');
  expect(controller.getSnapshot().error).toBeUndefined();
  f.connection(false);
  await controller.close();
});

test('an access-denied delivery turns the controller into a FORBIDDEN error', async () => {
  const f = fixture();
  const controller = createAgentController({
    transport: f.transport,
    conversationId: 'one',
    access: 'observe',
  });
  await eventually(() => f.requests.length === 1);
  f.respond(0, 1);
  await eventually(() => controller.getSnapshot().status === 'ready');
  f.deliver({ schemaVersion: 1, type: 'access-denied', conversationId: 'one' });
  expect(controller.getSnapshot()).toMatchObject({
    status: 'error',
    error: { code: 'FORBIDDEN' },
  });
  f.connection(false);
  await controller.close();
});
