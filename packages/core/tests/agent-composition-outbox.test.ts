/**
 * The offline outbox recipe of `docs/guide/agent-composition.md`, run against the
 * real controller. The recipe between the markers below is the guide's code block,
 * character for character, so the guide cannot drift from what is proven here.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RealtimeClientTransport } from '../src/browser/realtime-client';
import {
  type AgentBrowserCommand,
  AgentBrowserRequestSchema,
  type AgentController,
  type AgentControlResponse,
  createAgentController,
} from '../src/entrypoints/agent-runtime/browser';
import { eventually } from './support/agent-composition';

// recipe:start
type Submit = Extract<AgentBrowserCommand, { operation: 'submit' }>;
type Pending = Omit<Submit, 'operation'>;

/** Drain `entries` (persist them; the key is chosen once, when the user acts). */
function createOutbox(
  agent: AgentController,
  entries: Pending[],
  onRefused: (entry: Pending, error: { code: string; message: string }) => 'keep' | 'drop',
) {
  let draining = false;
  async function drain() {
    if (draining) return; // one drain at a time: an entry is sent by one loop only
    draining = true;
    try {
      while (agent.getSnapshot().status === 'ready') {
        const next = entries[0];
        if (!next) return;
        const response = await agent.request({ operation: 'submit', ...next });
        if (response.outcome === 'error' && onRefused(next, response.error) === 'keep') return;
        entries.shift(); // admitted (or dropped by the application), never before the answer
      }
    } catch {
      // The connection dropped mid-request: the entry stays first, with its key.
    } finally {
      draining = false;
    }
  }
  const off = agent.subscribe(() => {
    if (agent.getSnapshot().status === 'ready') void drain();
  });
  return {
    push(entry: Pending) {
      entries.push(entry);
      void drain();
    },
    close: off,
  };
}
// recipe:end

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
  const ok = (index: number) => {
    const pending = requests[index];
    if (!pending) throw new Error(`no request ${index}`);
    pending.respond({
      schemaVersion: 1,
      requestId: pending.request.requestId,
      outcome: 'ok',
      snapshot: {
        schemaVersion: 1,
        conversationId: 'one',
        version: 1,
        runs: [],
        messages: [],
      },
    });
  };
  const refuse = (index: number) => {
    const pending = requests[index];
    if (!pending) throw new Error(`no request ${index}`);
    pending.respond({
      schemaVersion: 1,
      requestId: pending.request.requestId,
      outcome: 'error',
      error: { code: 'REQUEST_REJECTED', message: 'refused' },
    });
  };
  const connection = (value: boolean) => {
    connected = value;
    for (const listener of listeners) listener(value);
  };
  // An event for the conversation: the controller notifies its subscribers.
  const deliverEvent = () => {
    for (const event of events)
      event({
        schemaVersion: 1,
        type: 'event',
        event: {
          type: 'assistant-delta',
          conversationId: 'one',
          runId: 'r',
          runtimeEpoch: 'e',
          sequence: 1,
          textDelta: 'x',
          emittedAt: '2026-11-24T00:00:00.000Z',
        },
      });
  };
  return { transport, requests, ok, refuse, connection, deliverEvent };
}

const entry = (key: string): Pending => ({
  idempotencyKey: key,
  parts: [{ type: 'text', text: key }],
});
const submitted = (f: ReturnType<typeof fixture>) =>
  f.requests.flatMap(({ request }) =>
    request.operation === 'submit' ? [request.idempotencyKey] : [],
  );

test('the outbox sends each entry once, in order, and only after the previous answer', async () => {
  const f = fixture();
  const agent = createAgentController({
    transport: f.transport,
    conversationId: 'one',
    access: 'control',
  });
  const entries = [entry('a'), entry('b')];
  const outbox = createOutbox(agent, entries, () => 'drop');
  await eventually(() => f.requests.length === 1);
  f.ok(0); // attach
  await eventually(() => f.requests.length === 2);
  // Events arriving while `a` waits do not start a second drain.
  outbox.push(entry('c'));
  expect(submitted(f)).toEqual(['a']);
  f.ok(1);
  await eventually(() => f.requests.length === 3);
  f.ok(2);
  await eventually(() => f.requests.length === 4);
  f.ok(3);
  await eventually(() => entries.length === 0);
  expect(submitted(f)).toEqual(['a', 'b', 'c']);
  outbox.close();
  f.connection(false);
  await agent.close();
});

test('a refused entry stays first when kept, and the next ready state sends it again', async () => {
  const f = fixture();
  const agent = createAgentController({
    transport: f.transport,
    conversationId: 'one',
    access: 'control',
  });
  const entries = [entry('a'), entry('b')];
  const refused: string[] = [];
  const outbox = createOutbox(agent, entries, (pending, error) => {
    refused.push(`${pending.idempotencyKey}:${error.code}`);
    return 'keep';
  });
  await eventually(() => f.requests.length === 1);
  f.ok(0);
  await eventually(() => f.requests.length === 2);
  f.refuse(1);
  await eventually(() => refused.length === 1);
  expect(entries.map((pending) => pending.idempotencyKey)).toEqual(['a', 'b']);
  // A refusal leaves the controller in `error`: later events do not resend it, the
  // next attach does.
  f.deliverEvent();
  await Bun.sleep(20);
  expect(f.requests).toHaveLength(2);
  f.connection(false);
  f.connection(true);
  await eventually(() => f.requests.length === 3);
  f.ok(2); // the new attach
  await eventually(() => f.requests.length === 4);
  expect(f.requests[3]?.request).toMatchObject({ operation: 'submit', idempotencyKey: 'a' });
  expect(refused).toEqual(['a:REQUEST_REJECTED']);
  outbox.close();
  f.connection(false);
  await agent.close();
});

test('the guide shows this recipe exactly', () => {
  const source = readFileSync(import.meta.path, 'utf8');
  const recipe = source.slice(
    source.indexOf('// recipe:start\n') + '// recipe:start\n'.length,
    source.indexOf('// recipe:end'),
  );
  const guide = readFileSync(
    join(import.meta.dir, '../../../docs/guide/agent-composition.md'),
    'utf8',
  );
  expect(guide).toContain(
    `\`\`\`ts\nimport type { AgentBrowserCommand, AgentController } from 'stitchkit/agent-runtime/browser';\n\n${recipe}\`\`\``,
  );
});
