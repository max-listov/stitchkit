/**
 * The durable-store figures the backlog quotes, produced by something you can run.
 *
 * Two numbers were written into task evidence — "100 conversations, one list
 * query", "10 000 events indexed and searched" — with nothing in the tree that
 * prints them. A figure without a source cannot be re-measured, compared with
 * yesterday's or reproduced on another host. This script is the source:
 *
 *   bun scripts/bench-durable-store.ts [--conversations 100] [--events 10000]
 *
 * It prints one JSON line per measurement. The numbers are evidence, not a
 * gate: nothing here asserts a threshold.
 */
import { Database } from 'bun:sqlite';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createAgentRuntime,
  createSqliteAgentEventSearch,
  defineAgentProtocol,
} from '../src/agent-runtime';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../src/agent-runtime-sqlite-bun';

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

const conversations = argument('conversations', 100);
const events = argument('events', 10_000);
// In memory: the figures are about the store's queries, not the disk.
const raw = new Database(':memory:');
const database: SqliteDatabase = {
  exec: (sql) => raw.exec(sql),
  prepare(sql) {
    const statement = raw.query(sql);
    return {
      get: (...parameters: SqliteValue[]) => statement.get(...parameters),
      all: (...parameters: SqliteValue[]) => statement.all(...parameters),
      run: (...parameters: SqliteValue[]) => ({
        changes: statement.run(...parameters).changes,
      }),
    };
  },
  close: () => raw.close(),
};
const handle = createSqliteAgentRuntimeStore({ database });

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function message(conversationId: string, id: string) {
  const at = new Date().toISOString();
  return {
    schemaVersion: 1 as const,
    id,
    conversationId,
    role: 'user' as const,
    status: 'committed' as const,
    parts: [{ type: 'text' as const, text: `message ${id}` }],
    createdAt: at,
    updatedAt: at,
  };
}

try {
  // One list query over N conversations, each with one accepted input.
  for (let index = 0; index < conversations; index += 1) {
    const conversationId = `conversation-${index}`;
    const input = message(conversationId, `input-${index}`);
    await handle.store.acceptInputAndAssignRun({
      idempotencyKey: `request-${index}`,
      input,
      run: {
        schemaVersion: 1,
        id: `run-${index}`,
        conversationId,
        inputMessageIds: [input.id],
        assistantMessageId: `assistant-${index}`,
        state: 'queued',
        revision: 0,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      },
    });
  }
  const listStarted = performance.now();
  const page = await handle.conversations.list({ limit: conversations });
  const queryMs = performance.now() - listStarted;
  console.log(
    JSON.stringify({
      conversations,
      listed: page.items.length,
      queryMs: Number(queryMs.toFixed(3)),
    }),
  );

  // N events into one conversation: the FTS triggers index them as they land.
  const indexStarted = performance.now();
  for (let index = 0; index < events; index += 1) {
    await handle.store.appendEvent({
      conversationId: 'searched',
      kind: 'state/set',
      payload: { text: `event ${index} ${index % 97 === 0 ? 'needle' : 'hay'}` },
    });
  }
  const indexedMs = performance.now() - indexStarted;
  const search = createSqliteAgentEventSearch({ database });
  const searchStarted = performance.now();
  const results = await search({
    requestingConversationId: 'searched',
    query: 'needle',
    limit: 20,
  });
  const searchMs = performance.now() - searchStarted;
  console.log(
    JSON.stringify({
      events,
      indexedMs: Number(indexedMs.toFixed(2)),
      searchMs: Number(searchMs.toFixed(2)),
      results: results.length,
    }),
  );

  // Ledger growth under the request record: a conversation with a long
  // history, one run of several steps. Linear in new messages, not in
  // steps × history, is the claim this line lets a reader check.
  const steps = argument('steps', 5);
  const history = argument('history', 200);
  const conversationId = 'ledger-growth';
  let call = 0;
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: handle.store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'bench',
          modelId: 'bench',
          contextWindow: 1_000_000,
          capabilities: [],
        },
        model: new MockLanguageModelV4({
          doStream: async () => {
            call += 1;
            const last = call >= steps;
            const chunks: Record<string, unknown>[] = last
              ? [
                  { type: 'text-start', id: 't' },
                  { type: 'text-delta', id: 't', delta: 'done' },
                  { type: 'text-end', id: 't' },
                  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
                ]
              : [
                  {
                    type: 'tool-call',
                    toolCallId: `call-${call}`,
                    toolName: 'echo',
                    input: '{}',
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: undefined },
                    usage,
                  },
                ];
            return { stream: simulateReadableStream({ chunks } as never) };
          },
        }),
      }),
    },
    prompt: () => ({
      instructions: 'bench',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({
      echo: tool({ description: 'e', inputSchema: z.object({}), execute: async () => 'ok' }),
    }),
    loop: { maxSteps: steps + 1 },
  });
  for (let index = 0; index < history; index += 1) {
    call = steps - 1; // the next call answers in one step
    await runtime.submit({
      conversationId,
      idempotencyKey: `history-${index}`,
      context: {},
      parts: [{ type: 'text', text: `history ${index}` }],
    }).result;
  }
  call = 0;
  const before = ledgerBytes(conversationId);
  await runtime.submit({
    conversationId,
    idempotencyKey: 'bench-run',
    context: {},
    parts: [{ type: 'text', text: 'go' }],
  }).result;
  await runtime.close();
  const after = ledgerBytes(conversationId);
  console.log(
    JSON.stringify({
      history,
      steps,
      ledgerBytesBefore: before.bytes,
      ledgerBytesAfter: after.bytes,
      ledgerEventsAdded: after.events - before.events,
      messageBodiesWritten: after.bodies,
    }),
  );
} finally {
  await handle.close();
}

function ledgerBytes(conversationId: string): {
  bytes: number;
  events: number;
  bodies: number;
} {
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(payload)), 0) AS bytes, COUNT(*) AS events,
         SUM(CASE WHEN kind = 'provider/message' THEN 1 ELSE 0 END) AS bodies
       FROM stitchkit_agent_runtime_events WHERE conversation_id = ?`,
    )
    .get(conversationId) as { bytes: number; events: number; bodies: number | null };
  return {
    bytes: Number(row.bytes),
    events: Number(row.events),
    bodies: Number(row.bodies ?? 0),
  };
}
