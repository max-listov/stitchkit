/**
 * Regressions for non-fatal oversized invocation payloads (`maxPayloadBytes`) across both
 * `wrapGenerate` and `wrapStream`, and public expiry purging (`store.purgeExpiredPayloads` /
 * `ledger.purgePayloads`) across memory and SQLite stores (including FTS5 ciphertext redaction,
 * `limit` pagination without starvation, idempotency, `{ status: 'expired' }` reads, fail-closed
 * encryption/storage errors, and branching after omission and purge).
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  createModelInvocationLedger,
  defineAgentProtocol,
  defineModelRegistry,
  InvocationPayloadTooLargeError,
  type ModelInvocationAuthorizationInput,
} from '../src/entrypoints/agent-runtime';
import { fromAiSdkModel } from '../src/entrypoints/agent-runtime/ai-sdk';
import { createBunSqliteAgentRuntimeStore } from '../src/entrypoints/agent-runtime/sqlite/bun';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const trace = { operationId: 'op-1', purpose: 'chat', project: 'test' };

function textStreamModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: text },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ],
      }),
    }),
  });
}

function makeModels(model: MockLanguageModelV4) {
  return defineModelRegistry({
    models: {
      model: {
        provider: 'test',
        modelId: 'model-v1',
        contextWindow: 128_000,
        capabilities: ['tools'],
      },
    },
    providers: { test: { create: () => fromAiSdkModel(model) } },
  });
}

describe('invocation maxPayloadBytes omission and payload expiry purge', () => {
  test('oversized request payload in wrapGenerate and wrapStream succeeds with payloadOmitted and InvocationPayloadTooLargeError', async () => {
    const generateModel = textStreamModel('live answer');
    const store = createMemoryAgentRuntimeStore();
    const ledger = createModelInvocationLedger({
      store,
      models: makeModels(generateModel),
      payloadKey: randomBytes(32),
      maxPayloadBytes: 1_024,
      authorize: () => ({ subject: 'verified' }),
    });

    const completed = await ledger.complete(
      {
        conversationId: 'conv-gen',
        idempotencyKey: 'big-gen',
        trace,
        prompt: 'A'.repeat(4_000),
        models: ['model'],
        timeoutMs: 10_000,
      },
      {},
    );
    expect(completed.outcome).toBe('succeeded');
    expect(completed.text).toBe('live answer');
    expect(completed.receiptError).toBeInstanceOf(InvocationPayloadTooLargeError);
    if (completed.receiptError instanceof InvocationPayloadTooLargeError) {
      expect(completed.receiptError.bytes).toBeGreaterThan(1_024);
      expect(completed.receiptError.maxBytes).toBe(1_024);
      expect(completed.receiptError.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(generateModel.doStreamCalls).toHaveLength(1);
    const records = (await ledger.read({ conversationId: 'conv-gen', limit: 100 }, {})).items;
    const req = records.find((r) => r.record.type === 'provider/request')?.record;
    expect(req).toMatchObject({
      type: 'provider/request',
      sent: { payloadOmitted: 'max-payload-bytes' },
    });
    if (req?.type === 'provider/request') expect(req.sent.artifactId).toBeUndefined();

    // Streaming agent step with huge prompt (> maxPayloadBytes) also succeeds cleanly.
    const streamModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'streamed ok' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ],
        }),
      }),
    });
    const streamStore = createMemoryAgentRuntimeStore();
    const streamModels = makeModels(streamModel);
    const streamLedger = createModelInvocationLedger({
      store: streamStore,
      models: streamModels,
      payloadKey: randomBytes(32),
      maxPayloadBytes: 1_024,
      authorize: () => ({ subject: 'verified' }),
    });
    const runtime = createAgentRuntime({
      store: streamStore,
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      models: { resolve: () => streamModels.resolve('model') },
      tools: () => ({}),
      prompt: () => ({
        instructions: 'B'.repeat(4_000),
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      invocations: { ledger: streamLedger, trace: () => trace },
    });
    try {
      const result = await runtime.submit({
        conversationId: 'conv-stream',
        idempotencyKey: 'big-stream',
        context: {},
        parts: [{ type: 'text', text: 'hello' }],
      }).result;
      expect(result.reason).toBe('success');
      const streamRecords = (
        await streamLedger.read({ conversationId: 'conv-stream', limit: 100 }, {})
      ).items;
      const streamReq = streamRecords.find(
        (r) => r.record.type === 'provider/request',
      )?.record;
      expect(streamReq).toMatchObject({
        type: 'provider/request',
        sent: { payloadOmitted: 'max-payload-bytes' },
      });
    } finally {
      await runtime.close();
    }

    // Branching a conversation that has payloadOmitted records succeeds cleanly.
    const branched = await streamStore.branchConversation({
      requestKey: 'branch-omitted',
      destinationConversationId: 'conv-stream-copy',
      source: { kind: 'conversation', conversationId: 'conv-stream' },
    });
    expect(branched.outcome).toBe('created');
  });

  test('storage failure during request payload write is NOT hidden as omission (fails closed)', async () => {
    const model = textStreamModel('must not run');
    const baseStore = createMemoryAgentRuntimeStore();
    const baseAppendOnce = baseStore.appendEventOnce;
    if (!baseAppendOnce) throw new Error('memory store missing appendEventOnce');
    const brokenStore = {
      ...baseStore,
      appendEventOnce: async (
        event: Parameters<NonNullable<typeof baseStore.appendEventOnce>>[0],
        key: string,
      ) => {
        if (event.kind === 'provider/payload') throw new Error('disk full');
        return baseAppendOnce(event, key);
      },
    };
    const ledger = createModelInvocationLedger({
      store: brokenStore,
      models: makeModels(model),
      payloadKey: randomBytes(32),
      authorize: () => ({ subject: 'verified' }),
    });
    const outcome = await ledger.complete(
      {
        conversationId: 'conv-fail',
        idempotencyKey: 'k1',
        trace,
        prompt: 'small prompt',
        models: ['model'],
        timeoutMs: 10_000,
      },
      {},
    );
    expect(outcome.outcome).toBe('failed');
    expect(model.doStreamCalls).toHaveLength(0);
  });

  test('purgePayloads redacts expired bodies in SQLite + FTS5, preserves fresh rows, paginates without starvation, is idempotent, and branches cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-inv-purge-'));
    const dbPath = join(dir, 'agent.sqlite');
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: dbPath });
    try {
      const model = textStreamModel('answer text');
      const actions: ModelInvocationAuthorizationInput[] = [];
      const ledger = createModelInvocationLedger({
        store: sqlite.store,
        models: makeModels(model),
        payloadKey: randomBytes(32),
        authorize: (input) => {
          actions.push(input);
          if (input.context === 'denied') throw new Error('Forbidden');
          return { subject: 'admin' };
        },
      });

      await ledger.complete(
        {
          conversationId: 'conv-old',
          idempotencyKey: 'old-1',
          trace,
          prompt: 'secret old prompt '.repeat(40),
          models: ['model'],
          timeoutMs: 10_000,
        },
        'allowed',
      );
      await ledger.complete(
        {
          conversationId: 'conv-old-other',
          idempotencyKey: 'old-other-1',
          trace,
          prompt: 'other conversation old prompt '.repeat(25),
          models: ['model'],
          timeoutMs: 10_000,
        },
        'allowed',
      );
      await ledger.complete(
        {
          conversationId: 'conv-fresh',
          idempotencyKey: 'fresh-1',
          trace,
          prompt: 'fresh secret prompt '.repeat(20),
          models: ['model'],
          timeoutMs: 10_000,
        },
        'allowed',
      );

      // Also include an old invocation with operationId literally equal to 'ciphertext' and a non-UTC offset (+08:00)
      // so the SQL pre-filter ('"ciphertext":') and non-UTC cutoff window are both exercised.
      await ledger.complete(
        {
          conversationId: 'conv-offset',
          idempotencyKey: 'offset-1',
          trace: { ...trace, operationId: 'ciphertext' },
          prompt: 'non-utc offset prompt '.repeat(20),
          models: ['model'],
          timeoutMs: 10_000,
        },
        'allowed',
      );

      // Backdate conv-old, conv-old-other, and conv-offset in SQLite so they precede cutoff while conv-fresh remains newer.
      const rawDb = new Database(dbPath);
      const oldArtifactIds: string[] = [];
      const oldCiphertexts: string[] = [];
      try {
        rawDb
          .prepare(
            "UPDATE stitchkit_agent_runtime_events SET occurred_at = '2026-01-01T00:00:00.000Z' WHERE conversation_id IN ('conv-old', 'conv-old-other')",
          )
          .run();
        // 2026-06-01T05:00:00+08:00 == 2026-05-31T21:00:00Z (earlier than 2026-06-01T00:00:00Z despite lexically later string!)
        rawDb
          .prepare(
            "UPDATE stitchkit_agent_runtime_events SET occurred_at = '2026-06-01T05:00:00+08:00' WHERE conversation_id = 'conv-offset'",
          )
          .run();
        const rows = rawDb
          .prepare(
            "SELECT payload FROM stitchkit_agent_runtime_events WHERE conversation_id = 'conv-old' AND kind = 'provider/payload'",
          )
          .all() as Array<{ payload: string }>;
        for (const r of rows) {
          const parsed = JSON.parse(r.payload) as { artifactId: string; ciphertext: string };
          oldArtifactIds.push(parsed.artifactId);
          oldCiphertexts.push(parsed.ciphertext);
        }
      } finally {
        rawDb.close();
      }
      expect(oldArtifactIds.length).toBe(2); // request + response

      // Unauthorized purge refuses before touching storage.
      await expect(
        ledger.purgePayloads({ before: '2026-06-01T00:00:00.000Z' }, 'denied'),
      ).rejects.toThrow('Forbidden');
      expect(actions.at(-1)).toEqual({ context: 'denied', action: 'purge-payloads' });

      // Conversation-scoped purge (I9: conversationId) redacts only conv-old and leaves conv-old-other + conv-offset intact.
      const pass1 = await ledger.purgePayloads(
        { before: '2026-06-01T00:00:00.000Z', conversationId: 'conv-old', limit: 1 },
        'allowed',
      );
      expect(pass1.purged).toBe(1);
      expect(pass1.freedBytes).toBeGreaterThan(0);
      expect(pass1.hasMore).toBe(true);

      const pass2 = await ledger.purgePayloads(
        { before: '2026-06-01T00:00:00.000Z', conversationId: 'conv-old', limit: 1 },
        'allowed',
      );
      expect(pass2.purged).toBe(1);
      expect(pass2.freedBytes).toBeGreaterThan(0);
      expect(pass2.hasMore).toBe(false);

      // conv-old-other must still be available because conversationId restricted the purge!
      const otherRecords = (
        await ledger.read({ conversationId: 'conv-old-other', limit: 100 }, 'allowed')
      ).items;
      const otherReq = otherRecords.find((r) => r.record.type === 'provider/request')?.record;
      if (otherReq?.type !== 'provider/request' || !otherReq.sent.artifactId)
        throw new Error('missing other old request');
      expect(
        (
          await ledger.readPayload(
            { conversationId: 'conv-old-other', artifactId: otherReq.sent.artifactId },
            'allowed',
          )
        ).status,
      ).toBe('available');

      // Global purge now sweeps conv-old-other (2 rows) and non-UTC conv-offset (2 rows with operationId='ciphertext').
      const globalSweep = await ledger.purgePayloads(
        { before: '2026-06-01T00:00:00.000Z', limit: 10 },
        'allowed',
      );
      expect(globalSweep.purged).toBe(4);
      expect(globalSweep.freedBytes).toBeGreaterThan(0);
      expect(globalSweep.hasMore).toBe(false);

      // Re-running purge must remain idempotent even with literal 'ciphertext' in redacted operationId.
      const pass3 = await ledger.purgePayloads(
        { before: '2026-06-01T00:00:00.000Z', limit: 10 },
        'allowed',
      );
      expect(pass3).toEqual({ purged: 0, freedBytes: 0, hasMore: false });

      // Verify SQLite events AND FTS5 table no longer hold any purged ciphertext!
      const inspectDb = new Database(dbPath, { readonly: true });
      try {
        const eventsBlob = JSON.stringify(
          inspectDb
            .prepare(
              "SELECT payload FROM stitchkit_agent_runtime_events WHERE conversation_id = 'conv-old'",
            )
            .all(),
        );
        const ftsBlob = JSON.stringify(
          inspectDb
            .prepare(
              "SELECT body FROM stitchkit_agent_runtime_events_fts WHERE conversation_id = 'conv-old'",
            )
            .all(),
        );
        for (const ct of oldCiphertexts) {
          expect(eventsBlob).not.toContain(ct);
          expect(ftsBlob).not.toContain(ct);
        }
      } finally {
        inspectDb.close();
      }

      // readPayload returns { status: 'expired', ... } for purged artifacts.
      for (const artifactId of oldArtifactIds) {
        const read = await ledger.readPayload(
          { conversationId: 'conv-old', artifactId },
          'allowed',
        );
        expect(read.status).toBe('expired');
        expect(read.artifactId).toBe(artifactId);
        if (read.status === 'expired') expect(read.expiredAt).toMatch(/Z$/);
      }

      // Fresh conversation payload is untouched and still available!
      const freshRecords = (
        await ledger.read({ conversationId: 'conv-fresh', limit: 100 }, 'allowed')
      ).items;
      const freshReq = freshRecords.find((r) => r.record.type === 'provider/request')?.record;
      if (freshReq?.type !== 'provider/request' || !freshReq.sent.artifactId)
        throw new Error('missing fresh request');
      const freshRead = await ledger.readPayload(
        { conversationId: 'conv-fresh', artifactId: freshReq.sent.artifactId },
        'allowed',
      );
      expect(freshRead.status).toBe('available');
      if (freshRead.status === 'available') {
        expect(JSON.stringify(freshRead.payload)).toContain('fresh secret prompt');
      }

      // Non-existent artifact still throws 'Invocation artifact not found' (even when scanning past expired rows!).
      await expect(
        ledger.readPayload(
          { conversationId: 'conv-old', artifactId: 'does-not-exist' },
          'allowed',
        ),
      ).rejects.toThrow('Invocation artifact not found');

      // Branching a conversation with purged (expired) payloads succeeds cleanly.
      const branched = await sqlite.store.branchConversation({
        requestKey: 'branch-after-purge',
        destinationConversationId: 'conv-old-copy',
        source: { kind: 'conversation', conversationId: 'conv-old' },
      });
      expect(branched.outcome).toBe('created');
    } finally {
      await sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('memory store purgePayloads redacts expired bodies with conversationId scoping, pagination, and idempotency', async () => {
    const store = createMemoryAgentRuntimeStore();
    const model = textStreamModel('memory answer');
    const ledger = createModelInvocationLedger({
      store,
      models: makeModels(model),
      payloadKey: randomBytes(32),
      authorize: () => ({ subject: 'admin' }),
    });
    await ledger.complete(
      {
        conversationId: 'mem-a',
        idempotencyKey: 'm-a1',
        trace,
        prompt: 'memory secret a '.repeat(20),
        models: ['model'],
        timeoutMs: 10_000,
      },
      {},
    );
    await ledger.complete(
      {
        conversationId: 'mem-b',
        idempotencyKey: 'm-b1',
        trace,
        prompt: 'memory secret b '.repeat(20),
        models: ['model'],
        timeoutMs: 10_000,
      },
      {},
    );

    const futureCutoff = new Date(Date.now() + 60_000).toISOString();
    const firstPage = await ledger.purgePayloads(
      { before: futureCutoff, conversationId: 'mem-a', limit: 1 },
      {},
    );
    expect(firstPage.purged).toBe(1);
    expect(firstPage.freedBytes).toBeGreaterThan(0);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await ledger.purgePayloads(
      { before: futureCutoff, conversationId: 'mem-a', limit: 10 },
      {},
    );
    expect(secondPage.purged).toBe(1);
    expect(secondPage.hasMore).toBe(false);

    // mem-b must still be available because conversationId scoped purge to mem-a.
    const bRecords = (await ledger.read({ conversationId: 'mem-b', limit: 100 }, {})).items;
    const bReq = bRecords.find((r) => r.record.type === 'provider/request')?.record;
    if (bReq?.type !== 'provider/request' || !bReq.sent.artifactId)
      throw new Error('missing mem-b request');
    expect(
      (
        await ledger.readPayload(
          { conversationId: 'mem-b', artifactId: bReq.sent.artifactId },
          {},
        )
      ).status,
    ).toBe('available');

    // Global purge finishes mem-b and is idempotent on repeat.
    const sweepAll = await ledger.purgePayloads({ before: futureCutoff, limit: 10 }, {});
    expect(sweepAll.purged).toBe(2);
    expect(sweepAll.hasMore).toBe(false);
    expect(await ledger.purgePayloads({ before: futureCutoff, limit: 10 }, {})).toEqual({
      purged: 0,
      freedBytes: 0,
      hasMore: false,
    });
    const expiredRead = await ledger.readPayload(
      { conversationId: 'mem-b', artifactId: bReq.sent.artifactId },
      {},
    );
    expect(expiredRead.status).toBe('expired');
  });
});
