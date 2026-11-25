/**
 * Regressions for `branchConversation` and `planConversationBranch` with:
 * - legitimately expired spills (`spill/created` -> `spill/deleted`, empty `archive.spills`)
 * - `throughRunId` cut before `spill/deleted` followed by a second branch (Branch 1 -> Branch 2)
 * - spill integrity refusals (orphan `spill/deleted`, duplicate create/delete, mismatched bytes,
 *   still-live spill with `spill/deleted`)
 * - application tool JSON containing spill references via `sourceIdentity: 'rekey-spill'`
 *   with SQLite reopen verification (destination readable, source inaccessible, foreign refused)
 * - pure `branchOpaqueJson` transformation on `provider/message` with `sha256` consistency.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  AgentConversationBranchRefusedError,
  type AgentMessagePart,
  type AgentRuntimeStore,
  canonicalAgentJson,
  createAgentSpillStore,
  createMemoryAgentRuntimeStore,
} from '../src/entrypoints/agent-runtime';
import { createBunSqliteAgentRuntimeStore } from '../src/entrypoints/agent-runtime/sqlite/bun';

const NOW = '2026-11-25T10:00:00.000Z';
const AUTH = { operation: 'read', path: 'source-only' } as const;
const DEST_AUTH = { operation: 'read', path: 'destination-only' } as const;

async function commitTurn(
  store: AgentRuntimeStore,
  conversationId: string,
  runId: string,
  opts: {
    toolName: string;
    callId: string;
    toolOutput: z.infer<ReturnType<typeof z.json>>;
    fileRef?: string;
    expectedVersion?: number;
  },
) {
  const inputMsgId = `${runId}-in`;
  const assistantMsgId = `${runId}-asst`;
  const accepted = await store.acceptInputAndAssignRun({
    idempotencyKey: `key-${runId}`,
    ...(opts.expectedVersion !== undefined && { expectedVersion: opts.expectedVersion }),
    input: {
      schemaVersion: 1,
      id: inputMsgId,
      conversationId,
      role: 'user',
      status: 'committed',
      createdAt: NOW,
      updatedAt: NOW,
      parts: [{ type: 'text', text: `prompt ${runId}` }],
    },
    run: {
      schemaVersion: 1,
      id: runId,
      conversationId,
      state: 'queued',
      revision: 0,
      inputMessageIds: [inputMsgId],
      assistantMessageId: assistantMsgId,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  if (accepted.outcome !== 'applied') throw new Error(`accept failed: ${accepted.outcome}`);
  const acquired = await store.acquireRun({
    conversationId,
    runId,
    expectedRevision: 0,
    ownerId: 'owner-1',
  });
  if (acquired.outcome !== 'applied') throw new Error(`acquire failed: ${acquired.outcome}`);
  const assistantParts: AgentMessagePart[] = [
    {
      type: 'tool-call',
      callId: opts.callId,
      toolName: opts.toolName,
      input: { query: 'find' },
    },
    {
      type: 'tool-result',
      callId: opts.callId,
      toolName: opts.toolName,
      outcome: 'success',
      output: opts.toolOutput,
    },
    ...(opts.fileRef
      ? [
          {
            type: 'file' as const,
            mediaType: 'text/plain',
            reference: opts.fileRef,
          },
        ]
      : []),
    { type: 'text', text: 'done' },
  ];
  const terminal = await store.commitRunTerminal({
    conversationId,
    runId,
    expectedRevision: 1,
    ownerId: 'owner-1',
    fencingToken: 1,
    reason: 'success',
    assistant: {
      schemaVersion: 1,
      id: assistantMsgId,
      conversationId,
      runId,
      role: 'assistant',
      status: 'completed',
      createdAt: NOW,
      updatedAt: NOW,
      parts: assistantParts,
    },
  });
  if (terminal.outcome !== 'applied') throw new Error(`terminal failed: ${terminal.outcome}`);
  return terminal.snapshot.version;
}

describe('branchConversation expired spills and application spill rekeying', () => {
  test('branches a conversation whose spills expired via spill/deleted (empty archive.spills), including throughRunId double-branching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-branch-expired-'));
    const dbPath = join(dir, 'agent.sqlite');
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: dbPath });
    try {
      let clock = new Date('2026-01-01T00:00:00.000Z');
      const spills = createAgentSpillStore({
        host: sqlite.host,
        conversationId: 'src',
        runId: 'run-1',
        retentionMs: 1000,
        now: () => clock,
      });
      const v1 = await commitTurn(sqlite.store, 'src', 'run-1', {
        toolName: 'search_docs',
        callId: 'call-1',
        toolOutput: { ok: true },
      });
      // Write a spill with short retention, then record it in run-2 output & file part.
      const written = await spills.write({
        toolCallId: 'call-1',
        mediaType: 'text/plain',
        data: new TextEncoder().encode('large expired payload'),
        authorization: AUTH,
      });
      await commitTurn(sqlite.store, 'src', 'run-2', {
        toolName: 'search_docs',
        callId: 'call-2',
        toolOutput: { reference: written.reference, summary: 'spilled' },
        fileRef: written.reference,
        expectedVersion: v1,
      });
      // Advance clock past retention and clean up -> deletes row from spills table & appends spill/deleted event.
      clock = new Date('2026-11-25T12:00:00.000Z');
      const cleaned = await spills.cleanup();
      expect(cleaned.deleted).toBe(1);

      // 1. Plan & branch whole conversation (empty archive.spills, paired spill/created + spill/deleted).
      const plan = await sqlite.store.planConversationBranch({
        requestKey: 'plan-expired',
        destinationConversationId: 'dst-full',
        source: { kind: 'conversation', conversationId: 'src' },
        applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
      });
      expect(plan.ready).toBe(true);
      expect(plan.refusals).toEqual([]);

      const branched = await sqlite.store.branchConversation({
        requestKey: 'branch-expired-full',
        destinationConversationId: 'dst-full',
        source: { kind: 'conversation', conversationId: 'src' },
        applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
      });
      expect(branched.outcome).toBe('created');

      // Destination history carries a rekeyed reference (never the source spill ID).
      const dstSnap = await sqlite.store.loadSnapshot('dst-full');
      expect(JSON.stringify(dstSnap)).not.toContain(written.reference);

      // Branch from archive bytes (restore) also succeeds.
      const archiveBytes = await sqlite.store.exportConversation('src');
      const restored = await sqlite.store.branchConversation({
        requestKey: 'branch-expired-archive',
        destinationConversationId: 'dst-archive',
        source: { kind: 'archive', bytes: archiveBytes },
        applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
      });
      expect(restored.outcome).toBe('created');

      // 2. Branch throughRunId='run-2' (cuts BEFORE the tail spill/deleted event), then branch AGAIN!
      const branch1 = await sqlite.store.branchConversation({
        requestKey: 'branch-prefix-1',
        destinationConversationId: 'dst-prefix-1',
        source: { kind: 'conversation', conversationId: 'src', throughRunId: 'run-2' },
        applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
      });
      expect(branch1.outcome).toBe('created');

      const branch2 = await sqlite.store.branchConversation({
        requestKey: 'branch-prefix-2',
        destinationConversationId: 'dst-prefix-2',
        source: { kind: 'conversation', conversationId: 'dst-prefix-1' },
        applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
      });
      expect(branch2.outcome).toBe('created');
    } finally {
      await sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rekeys live application tool spill references across SQLite reopen and refuses foreign or non-spill values before writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-branch-appspill-'));
    const dbPath = join(dir, 'agent.sqlite');
    let sourceRef = '';
    let destinationRef = '';

    {
      const sqlite = createBunSqliteAgentRuntimeStore({ filename: dbPath });
      try {
        const spills = createAgentSpillStore({
          host: sqlite.host,
          conversationId: 'src',
          runId: 'run-1',
        });
        const v1 = await commitTurn(sqlite.store, 'src', 'run-1', {
          toolName: 'search_tasks',
          callId: 'call-1',
          toolOutput: { ok: true },
        });
        const written = await spills.write({
          toolCallId: 'call-1',
          mediaType: 'application/json',
          data: new TextEncoder().encode('{"rows":[1,2,3]}'),
          authorization: AUTH,
        });
        sourceRef = written.reference;
        await commitTurn(sqlite.store, 'src', 'run-2', {
          toolName: 'search_tasks',
          callId: 'call-2',
          toolOutput: {
            reference: sourceRef,
            optionalRef: null,
            nested: { reference: sourceRef },
          },
          expectedVersion: v1,
        });

        // Also record a provider/message containing the spill reference to verify pure rekey + sha256.
        const providerMsg = {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool-result' as const,
              toolCallId: 'call-2',
              toolName: 'search_tasks',
              output: { type: 'error-json' as const, value: { reference: sourceRef } },
            },
          ],
        };
        const msgSha = createHash('sha256')
          .update(canonicalAgentJson(providerMsg))
          .digest('hex');
        await sqlite.store.appendEvent({
          conversationId: 'src',
          kind: 'provider/message',
          payload: { sha256: msgSha, message: providerMsg },
        });

        // Negative control: foreign reference in another conversation refuses BEFORE any write.
        await commitTurn(sqlite.store, 'foreign-src', 'run-f1', {
          toolName: 'search_tasks',
          callId: 'call-f1',
          toolOutput: { reference: 'foreign-spill-not-in-source' },
        });
        const foreignPlan = await sqlite.store.planConversationBranch({
          requestKey: 'plan-foreign',
          destinationConversationId: 'dst-never-written',
          source: { kind: 'conversation', conversationId: 'foreign-src' },
          applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
        });
        expect(foreignPlan.ready).toBe(false);
        expect(foreignPlan.refusals[0]?.code).toBe('application-key-source-identity');

        await expect(
          sqlite.store.branchConversation({
            requestKey: 'branch-foreign',
            destinationConversationId: 'dst-never-written',
            source: { kind: 'conversation', conversationId: 'foreign-src' },
            applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
          }),
        ).rejects.toBeInstanceOf(AgentConversationBranchRefusedError);
        expect(
          (await sqlite.store.readEvents({ conversationId: 'dst-never-written', limit: 10 }))
            .items,
        ).toHaveLength(0);

        // Positive: branch live application spill with fresh destination authorization.
        const result = await sqlite.store.branchConversation({
          requestKey: 'branch-live-app',
          destinationConversationId: 'dst-live',
          source: { kind: 'conversation', conversationId: 'src' },
          artifactAuthorization: DEST_AUTH,
          applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
        });
        expect(result.outcome).toBe('created');

        const snap = await sqlite.store.loadSnapshot('dst-live');
        const toolResult = snap.messages
          .flatMap((m) => m.parts)
          .find(
            (p) =>
              p.type === 'tool-result' &&
              p.toolName === 'search_tasks' &&
              p.output &&
              typeof p.output === 'object' &&
              'reference' in p.output,
          );
        expect(toolResult).toBeDefined();
        if (toolResult?.type !== 'tool-result') throw new Error('missing tool-result');
        const out = toolResult.output as {
          reference: string;
          optionalRef: null;
          nested: { reference: string };
        };
        expect(out.reference).not.toBe(sourceRef);
        expect(out.nested.reference).toBe(out.reference);
        expect(out.optionalRef).toBeNull();
        destinationRef = out.reference;
        expect(JSON.stringify(snap)).not.toContain(sourceRef);

        // Verify provider/message event had its spill rekeyed AND its sha256 recomputed consistently.
        const dstEvents = (
          await sqlite.store.readEvents({ conversationId: 'dst-live', limit: 100 })
        ).items;
        const pMsgEvent = dstEvents.find((e) => e.kind === 'provider/message');
        expect(pMsgEvent).toBeDefined();
        expect(JSON.stringify(pMsgEvent?.payload)).toContain(destinationRef);
        expect(JSON.stringify(pMsgEvent?.payload)).not.toContain(sourceRef);
      } finally {
        await sqlite.close();
      }
    }

    // Reopen SQLite from disk: rekeyed spill is readable in destination, source ID is NOT accessible in destination.
    const reopened = createBunSqliteAgentRuntimeStore({ filename: dbPath });
    try {
      const spills = createAgentSpillStore({
        host: reopened.host,
        conversationId: 'dst-live',
      });
      const readDest = await spills.read({
        reference: destinationRef,
        offset: 0,
        maxBytes: 1024,
      });
      expect(new TextDecoder().decode(readDest.data)).toBe('{"rows":[1,2,3]}');

      await expect(
        spills.read({
          reference: sourceRef,
          offset: 0,
          maxBytes: 1024,
        }),
      ).rejects.toThrow();

      // Re-branching the destination also succeeds (proving provider/message sha256 stayed valid).
      const rebranched = await reopened.store.branchConversation({
        requestKey: 'rebranch-dst',
        destinationConversationId: 'dst-live-2',
        source: { kind: 'conversation', conversationId: 'dst-live' },
        artifactAuthorization: DEST_AUTH,
        applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
      });
      expect(rebranched.outcome).toBe('created');
    } finally {
      await reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses unexplained missing spill, orphan spill/deleted, and byte-mismatched spill/deleted with integrity', async () => {
    const store = createMemoryAgentRuntimeStore();
    await commitTurn(store, 'unexplained', 'run-1', {
      toolName: 't',
      callId: 'c1',
      toolOutput: { ok: true },
    });
    await store.appendEvent({
      conversationId: 'unexplained',
      kind: 'spill/created',
      payload: { reference: 'ghost-spill', bytes: 42 },
    });
    const planMissing = await store.planConversationBranch({
      requestKey: 'p1',
      destinationConversationId: 'dst1',
      source: { kind: 'conversation', conversationId: 'unexplained' },
    });
    expect(planMissing.ready).toBe(false);
    expect(planMissing.refusals.some((r) => r.code === 'integrity')).toBe(true);

    // Orphan spill/deleted without spill/created
    await commitTurn(store, 'orphan-del', 'run-1', {
      toolName: 't',
      callId: 'c1',
      toolOutput: { ok: true },
    });
    await store.appendEvent({
      conversationId: 'orphan-del',
      kind: 'spill/deleted',
      payload: { reference: 'never-created', bytes: 10 },
    });
    const planOrphan = await store.planConversationBranch({
      requestKey: 'p2',
      destinationConversationId: 'dst2',
      source: { kind: 'conversation', conversationId: 'orphan-del' },
    });
    expect(planOrphan.ready).toBe(false);
    expect(planOrphan.refusals.some((r) => r.code === 'integrity')).toBe(true);

    // Mismatched bytes between spill/created and spill/deleted
    await commitTurn(store, 'mismatch', 'run-1', {
      toolName: 't',
      callId: 'c1',
      toolOutput: { ok: true },
    });
    await store.appendEvent({
      conversationId: 'mismatch',
      kind: 'spill/created',
      payload: { reference: 's-mismatch', bytes: 100 },
    });
    await store.appendEvent({
      conversationId: 'mismatch',
      kind: 'spill/deleted',
      payload: { reference: 's-mismatch', bytes: 999 },
    });
    const planMismatch = await store.planConversationBranch({
      requestKey: 'p3',
      destinationConversationId: 'dst3',
      source: { kind: 'conversation', conversationId: 'mismatch' },
    });
    expect(planMismatch.ready).toBe(false);
    expect(planMismatch.refusals.some((r) => r.code === 'integrity')).toBe(true);

    // Duplicate spill/created
    await commitTurn(store, 'dup-created', 'run-1', {
      toolName: 't',
      callId: 'c1',
      toolOutput: { ok: true },
    });
    await store.appendEvent({
      conversationId: 'dup-created',
      kind: 'spill/created',
      payload: { reference: 's-dup', bytes: 10 },
    });
    await store.appendEvent({
      conversationId: 'dup-created',
      kind: 'spill/created',
      payload: { reference: 's-dup', bytes: 10 },
    });
    const planDupCreated = await store.planConversationBranch({
      requestKey: 'p4',
      destinationConversationId: 'dst4',
      source: { kind: 'conversation', conversationId: 'dup-created' },
    });
    expect(planDupCreated.ready).toBe(false);
    expect(planDupCreated.refusals.some((r) => r.code === 'integrity')).toBe(true);

    // Duplicate spill/deleted
    await commitTurn(store, 'dup-deleted', 'run-1', {
      toolName: 't',
      callId: 'c1',
      toolOutput: { ok: true },
    });
    await store.appendEvent({
      conversationId: 'dup-deleted',
      kind: 'spill/created',
      payload: { reference: 's-del2', bytes: 10 },
    });
    await store.appendEvent({
      conversationId: 'dup-deleted',
      kind: 'spill/deleted',
      payload: { reference: 's-del2', bytes: 10 },
    });
    await store.appendEvent({
      conversationId: 'dup-deleted',
      kind: 'spill/deleted',
      payload: { reference: 's-del2', bytes: 10 },
    });
    const planDupDeleted = await store.planConversationBranch({
      requestKey: 'p5',
      destinationConversationId: 'dst5',
      source: { kind: 'conversation', conversationId: 'dup-deleted' },
    });
    expect(planDupDeleted.ready).toBe(false);
    expect(planDupDeleted.refusals.some((r) => r.code === 'integrity')).toBe(true);

    // Mismatched sha256 between spill/created and spill/deleted
    await commitTurn(store, 'sha-mismatch', 'run-1', {
      toolName: 't',
      callId: 'c1',
      toolOutput: { ok: true },
    });
    await store.appendEvent({
      conversationId: 'sha-mismatch',
      kind: 'spill/created',
      payload: { reference: 's-sha', bytes: 10, sha256: 'a'.repeat(64) },
    });
    await store.appendEvent({
      conversationId: 'sha-mismatch',
      kind: 'spill/deleted',
      payload: { reference: 's-sha', bytes: 10, sha256: 'b'.repeat(64) },
    });
    const planSha = await store.planConversationBranch({
      requestKey: 'p6',
      destinationConversationId: 'dst6',
      source: { kind: 'conversation', conversationId: 'sha-mismatch' },
    });
    expect(planSha.ready).toBe(false);
    expect(planSha.refusals.some((r) => r.code === 'integrity')).toBe(true);

    // Source non-spill identity (runId) under rekey-spill refuses with application-key-source-identity
    await commitTurn(store, 'non-spill-id', 'run-secret', {
      toolName: 't',
      callId: 'c1',
      toolOutput: { reference: 'run-secret' },
    });
    const planNonSpill = await store.planConversationBranch({
      requestKey: 'p7',
      destinationConversationId: 'dst7',
      source: { kind: 'conversation', conversationId: 'non-spill-id' },
      applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
    });
    expect(planNonSpill.ready).toBe(false);
    expect(planNonSpill.refusals[0]?.code).toBe('application-key-source-identity');

    // Live spill with spill/deleted still present in SQLite archive refuses with integrity;
    // live spill under rekey-spill without artifactAuthorization refuses with artifact-authorization-missing.
    const dir = mkdtempSync(join(tmpdir(), 'sk-branch-live-del-'));
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: join(dir, 'agent.sqlite') });
    try {
      const spills = createAgentSpillStore({
        host: sqlite.host,
        conversationId: 'live-no-auth',
        runId: 'run-1',
      });
      const v1 = await commitTurn(sqlite.store, 'live-no-auth', 'run-1', {
        toolName: 't',
        callId: 'c0',
        toolOutput: { ok: true },
      });
      const liveBytes = new TextEncoder().encode('live payload');
      const liveSha = createHash('sha256').update(liveBytes).digest('hex');
      const rec = await spills.write({
        toolCallId: 'c0',
        data: liveBytes,
        mediaType: 'text/plain',
        authorization: AUTH,
      });
      await commitTurn(sqlite.store, 'live-no-auth', 'run-2', {
        toolName: 't',
        callId: 'c1',
        toolOutput: { reference: rec.reference },
        expectedVersion: v1,
      });
      const planNoAuth = await sqlite.store.planConversationBranch({
        requestKey: 'p-no-auth',
        destinationConversationId: 'dst-no-auth',
        source: { kind: 'conversation', conversationId: 'live-no-auth' },
        applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
      });
      expect(planNoAuth.ready).toBe(false);
      expect(
        planNoAuth.refusals.some((r) => r.code === 'artifact-authorization-missing'),
      ).toBe(true);

      // Appending spill/deleted while the live spill row still exists in archive.spills -> integrity refusal
      await sqlite.store.appendEvent({
        conversationId: 'live-no-auth',
        kind: 'spill/deleted',
        payload: { reference: rec.reference, bytes: liveBytes.byteLength, sha256: liveSha },
      });
      const planLiveDeleted = await sqlite.store.planConversationBranch({
        requestKey: 'p-live-del',
        destinationConversationId: 'dst-live-del',
        source: { kind: 'conversation', conversationId: 'live-no-auth' },
        artifactAuthorization: DEST_AUTH,
        applicationKeys: [{ key: 'reference', sourceIdentity: 'rekey-spill' }],
      });
      expect(planLiveDeleted.ready).toBe(false);
      expect(planLiveDeleted.refusals.some((r) => r.code === 'integrity')).toBe(true);
    } finally {
      await sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
