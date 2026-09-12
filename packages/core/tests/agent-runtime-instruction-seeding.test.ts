import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentMessage,
  AgentMessageSchema,
  type AgentRuntimeStore,
  type AgentStoreMutationResult,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime-sqlite-bun';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const BRIEF = 'TENANT BRIEF';
const SEED_KEY = 'prompt.user-instructions';

const paths: string[] = [];

function databasePath(label: string): string {
  const path = join(tmpdir(), `stitchkit-${label}-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

function appliedSnapshot(result: AgentStoreMutationResult) {
  if (result.outcome !== 'applied') {
    throw new Error(`expected applied, got ${result.outcome}`);
  }
  return result.snapshot;
}

function textOf(message: AgentMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function instructionMessage(conversationId: string, id: string, text: string): AgentMessage {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text }],
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  });
}

function runtimeWith(store: AgentRuntimeStore) {
  const prompts: { role?: string }[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(prompt as { role?: string }[]);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'ok' },
            { type: 'text-end', id: 'answer' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ],
        }) as never,
      };
    },
  });
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'instruction-seeding',
          contextWindow: 100_000,
          capabilities: [],
        },
        model,
      }),
    },
    prompt: () => ({
      instructions: 'SYSTEM ONLY',
      sections: [],
      userInstructions: [{ name: 'brief', text: BRIEF }],
      instructionTokens: { provenance: 'unavailable' },
      userInstructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({}),
    loop: { maxSteps: 2 },
  });
  return { runtime, prompts };
}

describe('durable once-seeding of user-role instructions', () => {
  test('v2 databases migrate without losing existing history and can seed once', async () => {
    const filename = databasePath('seed-v2-migration');
    const fixture = createBunSqliteAgentRuntimeStore({ filename });
    await fixture.store.seedConversationInput({
      conversationId: 'old',
      seedKey: 'import',
      inputs: [instructionMessage('old', 'existing', 'existing')],
    });
    // V3 adds only this table; dropping it and restoring the meta version
    // constructs the exact V2 schema while retaining real normalized history.
    fixture.database.exec('DROP TABLE stitchkit_agent_runtime_seeds');
    fixture.database
      .prepare("UPDATE stitchkit_agent_runtime_meta SET value='2' WHERE key='schema_version'")
      .run();
    await fixture.close();
    const migrated = createBunSqliteAgentRuntimeStore({ filename });
    try {
      expect(
        migrated.database
          .prepare("SELECT value FROM stitchkit_agent_runtime_meta WHERE key='schema_version'")
          .get(),
      ).toEqual({ value: '3' });
      expect(
        (await migrated.store.loadSnapshot('old')).messages.map((message) => message.id),
      ).toEqual(['existing']);
      const input = {
        conversationId: 'old',
        seedKey: SEED_KEY,
        inputs: [instructionMessage('old', 'new-seed', BRIEF)],
      };
      await migrated.store.seedConversationInput(input);
      await migrated.store.seedConversationInput(input);
      expect(
        (await migrated.store.loadSnapshot('old')).messages.map((message) => message.id),
      ).toEqual(['new-seed', 'existing']);
    } finally {
      await migrated.close();
    }
  });
  test('a user-role instruction is durable user history, not a per-call prelude', async () => {
    const store = createMemoryAgentRuntimeStore();
    const { runtime, prompts } = runtimeWith(store);

    await runtime.submit({
      conversationId: 'c1',
      idempotencyKey: 'i1',
      context: {},
      parts: [{ type: 'text', text: 'hello there' }],
      metadata: {},
    }).result;

    const snapshot = await store.loadSnapshot('c1');
    const seeded = snapshot.messages.filter((message) => textOf(message) === BRIEF);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.role).toBe('user');
    // The seed is ahead of the turn's input, as the recomposition used to be.
    expect(snapshot.messages.map((message) => textOf(message))).toEqual([
      BRIEF,
      'hello there',
      'ok',
    ]);

    const first = prompts[0] ?? [];
    const briefAt = first.findIndex((message) => JSON.stringify(message).includes(BRIEF));
    const helloAt = first.findIndex((message) =>
      JSON.stringify(message).includes('hello there'),
    );
    expect(first[briefAt]?.role).toBe('user');
    expect(briefAt).toBeGreaterThanOrEqual(0);
    expect(briefAt).toBeLessThan(helloAt);
  });

  test('history replacement removes the seed, and the next run does not resurrect it', async () => {
    const store = createMemoryAgentRuntimeStore();
    const { runtime, prompts } = runtimeWith(store);

    await runtime.submit({
      conversationId: 'c1',
      idempotencyKey: 'i1',
      context: {},
      parts: [{ type: 'text', text: 'hello there' }],
      metadata: {},
    }).result;

    const before = await store.loadSnapshot('c1');
    const seedId = before.messages.find((message) => textOf(message) === BRIEF)?.id;
    expect(seedId).toBeDefined();

    const compacted = await store.replaceCompactedRange({
      conversationId: 'c1',
      expectedVersion: before.version,
      replacedMessageIds: [seedId as string],
      summary: AgentMessageSchema.parse({
        schemaVersion: 1,
        id: 'summary-1',
        conversationId: 'c1',
        role: 'summary',
        status: 'committed',
        parts: [{ type: 'text', text: 'summary of earlier context' }],
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
      }),
    });
    expect(compacted.outcome).toBe('applied');

    const promptsBefore = prompts.length;
    await runtime.submit({
      conversationId: 'c1',
      idempotencyKey: 'i2',
      context: {},
      parts: [{ type: 'text', text: 'second question' }],
      metadata: {},
    }).result;

    const after = await store.loadSnapshot('c1');
    expect(after.messages.some((message) => textOf(message) === BRIEF)).toBe(false);
    for (const prompt of prompts.slice(promptsBefore)) {
      expect(JSON.stringify(prompt).includes(BRIEF)).toBe(false);
    }
  });

  test('a replay and a retry of the seed write exactly one copy', async () => {
    const store = createMemoryAgentRuntimeStore();
    const first = instructionMessage('c1', 'seed-1', BRIEF);
    const applied = await store.seedConversationInput({
      conversationId: 'c1',
      seedKey: SEED_KEY,
      inputs: [first],
    });
    expect(applied.outcome).toBe('applied');

    // Replay: same key and identity, no second message, no new version.
    const repeated = await store.seedConversationInput({
      conversationId: 'c1',
      seedKey: SEED_KEY,
      inputs: [first],
    });
    expect(repeated.outcome).toBe('applied');
    expect(appliedSnapshot(repeated).version).toBe(appliedSnapshot(applied).version);

    // Concurrent admission: both settle, still one copy.
    await Promise.all([
      store.seedConversationInput({
        conversationId: 'c1',
        seedKey: SEED_KEY,
        inputs: [first],
      }),
      store.seedConversationInput({
        conversationId: 'c1',
        seedKey: SEED_KEY,
        inputs: [first],
      }),
    ]);

    const snapshot = await store.loadSnapshot('c1');
    expect(snapshot.messages.filter((message) => message.id === 'seed-1')).toHaveLength(1);
  });

  test('the sqlite driver seeds durably, in order, once, and survives a reopen', async () => {
    const filename = databasePath('instruction-seeding');
    const fixture = createBunSqliteAgentRuntimeStore({ filename });
    const conversationId = 'sqlite-conversation';
    const inputs = [
      instructionMessage(conversationId, 'seed-1', BRIEF),
      instructionMessage(conversationId, 'seed-2', 'SECOND BRIEF'),
    ];

    const first = await fixture.store.seedConversationInput({
      conversationId,
      seedKey: SEED_KEY,
      inputs,
    });
    expect(first.outcome).toBe('applied');
    expect(appliedSnapshot(first).messages.map((message) => message.id)).toEqual([
      'seed-1',
      'seed-2',
    ]);
    const replay = await fixture.store.seedConversationInput({
      conversationId,
      seedKey: SEED_KEY,
      inputs,
    });
    expect(appliedSnapshot(replay).version).toBe(appliedSnapshot(first).version);
    expect(
      appliedSnapshot(replay).messages.filter((message) => message.id.startsWith('seed-')),
    ).toHaveLength(2);
    await fixture.close();

    const reopened = createBunSqliteAgentRuntimeStore({ filename });
    try {
      const stillThere = await reopened.store.seedConversationInput({
        conversationId,
        seedKey: SEED_KEY,
        inputs,
      });
      expect(appliedSnapshot(stillThere).version).toBe(appliedSnapshot(first).version);
      const snapshot = await reopened.store.loadSnapshot(conversationId);
      expect(snapshot.messages.map((message) => message.id)).toEqual(['seed-1', 'seed-2']);
    } finally {
      await reopened.close();
    }
  });

  test('an imported conversation whose compacted seed survived without its receipt re-seeds idempotently', async () => {
    const filename = databasePath('instruction-seeding-compacted');
    const fixture = createBunSqliteAgentRuntimeStore({ filename });
    const conversationId = 'compacted-seed-conversation';
    const seed = instructionMessage(conversationId, 'seed-1', BRIEF);

    const first = await fixture.store.seedConversationInput({
      conversationId,
      seedKey: SEED_KEY,
      inputs: [seed],
    });
    expect(first.outcome).toBe('applied');

    // Compaction takes the seed out of the active view; its row survives as an
    // inactive message that still owns the `(conversation_id, id)` identity.
    const before = await fixture.store.loadSnapshot(conversationId);
    const compacted = await fixture.store.replaceCompactedRange({
      conversationId,
      expectedVersion: before.version,
      replacedMessageIds: ['seed-1'],
      summary: AgentMessageSchema.parse({
        schemaVersion: 1,
        id: 'summary-1',
        conversationId,
        role: 'summary',
        status: 'committed',
        parts: [{ type: 'text', text: 'summary of earlier context' }],
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
      }),
    });
    expect(compacted.outcome).toBe('applied');
    const compactedVersion = appliedSnapshot(compacted).version;

    // A restore that carried messages but not seed receipts: the identity is
    // present only as the inactive row.
    fixture.database
      .prepare('DELETE FROM stitchkit_agent_runtime_seeds WHERE conversation_id = ?')
      .run(conversationId);

    const reseeded = await fixture.store.seedConversationInput({
      conversationId,
      seedKey: SEED_KEY,
      inputs: [seed],
    });
    expect(reseeded.outcome).toBe('applied');
    // Already seeded: no version bump, no resurfaced active message.
    expect(appliedSnapshot(reseeded).version).toBe(compactedVersion);
    expect(appliedSnapshot(reseeded).messages.some((message) => message.id === 'seed-1')).toBe(
      false,
    );

    const stored = fixture.database
      .prepare(
        'SELECT count(*) AS count FROM stitchkit_agent_runtime_messages WHERE conversation_id = ? AND id = ?',
      )
      .get(conversationId, 'seed-1');
    expect((stored as { count: number }).count).toBe(1);

    await fixture.close();
  });
});
