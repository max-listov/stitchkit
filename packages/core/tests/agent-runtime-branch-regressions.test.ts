import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgentChildManager } from '../src/agent-runtime/children';
import type {
  AgentChildBlockingDecision,
  AgentChildBlockingSource,
} from '../src/agent-runtime/children-contract';
import { createAgentSpillStore } from '../src/agent-runtime/spill';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import { canonicalAgentJson } from '../src/agent-runtime/store-events';
import {
  type AgentRuntimeStore,
  type BranchAgentConversationInput,
  createMemoryAgentRuntimeStore,
  decodeAgentConversationArchive,
  encodeAgentConversationArchive,
  projectAgentHistory,
} from '../src/entrypoints/agent-runtime';
import { createAgentCodingTools } from '../src/entrypoints/agent-runtime/coding-tools';
import { branch, branchTurn } from './support/agent-branch-fixture';
import { branchRuntime } from './support/agent-branch-runtime-fixture';

test('archive fingerprint and clone bind the same owned bytes despite caller mutation', async () => {
  const store = createMemoryAgentRuntimeStore();
  await branchTurn(store, 'source', 'first');
  const original = await store.exportConversation('source');
  const mutable = Uint8Array.from(original);
  const changed = new TextEncoder().encode(
    new TextDecoder().decode(original).replaceAll('answer first', 'CHANGED TEXT'),
  );
  expect(changed.byteLength).toBe(mutable.byteLength);
  const request = {
    requestKey: 'bytes',
    destinationConversationId: 'copy',
    source: { kind: 'archive', bytes: mutable },
  } satisfies Parameters<typeof branch>[1];
  const pending = branch(store, request);
  mutable.set(changed);
  const result = await pending;
  expect(JSON.stringify(await store.loadSnapshot('copy'))).toContain('answer first');
  expect(JSON.stringify(await store.loadSnapshot('copy'))).not.toContain('CHANGED TEXT');
  const duplicate = await branch(store, {
    ...request,
    source: { kind: 'archive', bytes: original },
  });
  expect(duplicate).toEqual({ outcome: 'duplicate', receipt: result.receipt });
  await expect(branch(store, request)).rejects.toThrow('conflicts');
});

test('unknown opaque tail is refused even when the requested middle predates it', async () => {
  const original = createMemoryAgentRuntimeStore();
  await expect(
    branch(original, {
      requestKey: 'absent',
      destinationConversationId: 'absent-copy',
      source: { kind: 'conversation', conversationId: 'absent' },
    }),
  ).rejects.toThrow('not found');
  await branchTurn(original, 'source', 'first');
  await branchTurn(original, 'source', 'second');
  await branch(original, {
    requestKey: 'positive',
    destinationConversationId: 'positive',
    source: { kind: 'conversation', conversationId: 'source', throughRunId: 'first' },
  });
  const archive = decodeAgentConversationArchive(await original.exportConversation('source'));
  archive.events.push({
    schemaVersion: 1,
    eventId: 'future',
    conversationId: 'source',
    seq: 7,
    kind: 'future/opaque',
    ignorable: true,
    occurredAt: '2026-10-15T00:00:00.000Z',
    payload: { reference: 'foreign' },
  });
  const imported = createMemoryAgentRuntimeStore();
  await imported.importConversation(encodeAgentConversationArchive(archive));
  await expect(
    branch(imported, {
      requestKey: 'negative',
      destinationConversationId: 'negative',
      source: { kind: 'conversation', conversationId: 'source', throughRunId: 'first' },
    }),
  ).rejects.toThrow('opaque event');
  expect((await imported.loadSnapshot('negative')).version).toBe(0);
});

test('hash-only checkpoint usage cannot silently erase an opaque future field', async () => {
  const store = createMemoryAgentRuntimeStore();
  const runtime = branchRuntime(store);
  try {
    await runtime.submit({
      conversationId: 'source',
      idempotencyKey: 'first',
      context: {},
      metadata: {},
      parts: [{ type: 'text', text: 'go' }],
    }).result;
  } finally {
    await runtime.close();
  }
  const archive = decodeAgentConversationArchive(await store.exportConversation('source'));
  let changed = 0;
  archive.events = archive.events.map((event) => {
    if (event.kind !== 'runtime/transition') return event;
    const parsed = z
      .object({
        type: z.literal('checkpoint'),
        input: z.object({ usage: z.record(z.string(), z.json()).optional() }).passthrough(),
      })
      .passthrough()
      .safeParse(event.payload);
    if (!parsed.success) return event;
    changed++;
    return {
      ...event,
      payload: z.json().parse({
        ...parsed.data,
        input: {
          ...parsed.data.input,
          usage: {
            inputTokens: { provenance: 'unavailable' },
            outputTokens: { provenance: 'unavailable' },
            ...parsed.data.input.usage,
            futureOpaque: { reference: 'hidden-source-ref' },
          },
        },
      }),
    };
  });
  expect(changed).toBeGreaterThan(0);
  await expect(
    branch(store, {
      requestKey: 'opaque',
      destinationConversationId: 'negative',
      source: { kind: 'archive', bytes: encodeAgentConversationArchive(archive) },
    }),
  ).rejects.toThrow('unknown opaque field');
  expect((await store.loadSnapshot('negative')).version).toBe(0);
});

test('known provider approvals rekey and lose signatures, while structured error references refuse', async () => {
  const store = createMemoryAgentRuntimeStore();
  const snapshot = await branchTurn(store, 'source', 'first', [
    { type: 'tool-call', callId: 'call', toolName: 'example', input: {} },
    {
      type: 'tool-approval-request',
      approvalId: 'approval',
      callId: 'call',
      signature: 'source-secret-signature',
      isAutomatic: true,
    },
    { type: 'tool-approval-response', approvalId: 'approval', approved: true },
    {
      type: 'tool-result',
      callId: 'call',
      toolName: 'example',
      outcome: 'success',
      output: 'evidence',
    },
  ]);
  for (const message of await projectAgentHistory(snapshot.messages))
    await store.appendEvent({
      conversationId: 'source',
      kind: 'provider/message',
      payload: z.json().parse({
        message,
        sha256: createHash('sha256').update(canonicalAgentJson(message)).digest('hex'),
      }),
    });
  await branch(store, {
    requestKey: 'approval',
    destinationConversationId: 'positive',
    source: { kind: 'conversation', conversationId: 'source' },
  });
  const positive = new TextDecoder().decode(await store.exportConversation('positive'));
  expect(positive).not.toContain('source-secret-signature');
  expect(positive).not.toContain('"approvalId":"approval"');
  const message = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call',
        toolName: 'example',
        output: { type: 'error-json', value: { reference: 'foreign' } },
      },
    ],
  };
  await store.appendEvent({
    conversationId: 'source',
    kind: 'provider/message',
    payload: {
      message,
      sha256: createHash('sha256').update(canonicalAgentJson(message)).digest('hex'),
    },
  });
  await expect(
    branch(store, {
      requestKey: 'error',
      destinationConversationId: 'negative',
      source: { kind: 'conversation', conversationId: 'source' },
    }),
  ).rejects.toThrow('opaque payload');
  expect((await store.loadSnapshot('negative')).version).toBe(0);
});

function planBranch(store: AgentRuntimeStore, input: BranchAgentConversationInput) {
  if (!store.planConversationBranch)
    throw new Error('Store does not implement planConversationBranch');
  return store.planConversationBranch(input);
}

test('full child lifecycle branches on parent, child and archive while strict schema rejects rogue keys', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  try {
    await branchTurn(sqlite.store, 'parent', 'p1');
    const blockingByChild = new Map<string, Map<string, AgentChildBlockingSource>>();
    const manager = createAgentChildManager({
      store: sqlite.store,
      host: sqlite.host,
      maxActiveChildren: 4,
      remainingBudget: () => ({ tokens: 1_000, usd: 10, milliseconds: 60_000 }),
      spawn: ({ childConversationId }) => {
        const pending = new Map<string, AgentChildBlockingSource>();
        if (childConversationId === 'child-a') {
          pending.set('apr-1', {
            approvalId: 'apr-1',
            callId: 'child-call-1',
            toolName: 'confirm_step',
            input: { label: 'approve' },
            kind: 'approval',
            batchId: 'batch-1',
          });
          pending.set('inp-1', {
            approvalId: 'inp-1',
            callId: 'child-call-2',
            toolName: 'ask_choice',
            input: { prompt: 'pick one' },
            kind: 'input',
          });
        }
        blockingByChild.set(childConversationId, pending);
        return {
          result: new Promise(() => undefined),
          stopPolicy: () => undefined,
          sendMessage: () => undefined,
          reachable: () => childConversationId !== 'child-lost',
          blockingEvents: () => [...pending.values()],
          respondToBlocking: (decision: AgentChildBlockingDecision) => {
            pending.delete(decision.approvalId);
          },
        };
      },
    });

    await manager.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child-a',
      childInput: { task: 'a' },
      budget: { tokens: 10 },
    });
    await branchTurn(sqlite.store, 'child-a', 'c1');
    await manager.sendMessage('parent', 'child-a', { text: 'ping' });
    const presented = (await manager.listChildBlocking('parent')).pending;
    expect(presented).toHaveLength(2);
    const approvalReq = presented.find((event) => event.kind === 'approval');
    const inputReq = presented.find((event) => event.kind === 'input');
    if (!approvalReq || !inputReq)
      throw new Error('expected approval and input blocking events');
    await manager.respondToChildBlocking('parent', {
      approvalId: approvalReq.approvalId,
      approved: true,
    });
    await manager.respondToChildBlocking('parent', {
      approvalId: inputReq.approvalId,
      value: { answer: 'option-a' },
    });
    // The confirmed budget stop ends child-a: it takes no message or answer after it.
    const overBudget = await manager.recordStepUsage({
      childConversationId: 'child-a',
      usage: {
        inputTokens: { value: 8, provenance: 'provider-reported' },
        outputTokens: { value: 6, provenance: 'provider-reported' },
        cost: { currency: 'USD', value: 0.02, provenance: 'provider-reported' },
      },
      elapsedMs: 12,
    });
    expect(overBudget.stop).toBe(true);
    expect(overBudget.enforced).toBe(true);

    // Reconciliation event shape written when post-tx stop enforcement reconciles the log.
    await sqlite.store.appendEvent({
      conversationId: 'parent',
      kind: 'child/state',
      payload: {
        childConversationId: 'child-a',
        state: 'running',
        policyName: 'child-budget',
        enforced: true,
      },
    });
    await sqlite.store.appendEvent({
      conversationId: 'child-a',
      kind: 'child/state',
      payload: {
        parentConversationId: 'parent',
        childConversationId: 'child-a',
        state: 'running',
        policyName: 'child-budget',
        enforced: true,
      },
    });

    await manager.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child-b',
      childInput: { task: 'b' },
      budget: { tokens: 100 },
    });
    await manager.interruptChild('parent', 'child-b');
    await manager.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child-lost',
      childInput: { task: 'lost' },
      budget: { tokens: 100 },
    });
    await manager.stopChildren('parent');

    // Plan and branch parent conversation.
    const parentPlan = await planBranch(sqlite.store, {
      requestKey: 'parent-copy',
      destinationConversationId: 'parent-copy',
      source: { kind: 'conversation', conversationId: 'parent' },
    });
    expect(parentPlan.ready).toBe(true);
    expect(parentPlan.refusals).toEqual([]);
    await branch(sqlite.store, {
      requestKey: 'parent-copy',
      destinationConversationId: 'parent-copy',
      source: { kind: 'conversation', conversationId: 'parent' },
    });

    // Plan and branch child conversation.
    const childPlan = await planBranch(sqlite.store, {
      requestKey: 'child-copy',
      destinationConversationId: 'child-copy',
      source: { kind: 'conversation', conversationId: 'child-a' },
    });
    expect(childPlan.ready).toBe(true);
    expect(childPlan.refusals).toEqual([]);
    await branch(sqlite.store, {
      requestKey: 'child-copy',
      destinationConversationId: 'child-copy',
      source: { kind: 'conversation', conversationId: 'child-a' },
    });

    // Archive branch of parent AND re-branch of already-branched parent-copy.
    const parentArchive = await sqlite.store.exportConversation('parent');
    const archivePlan = await planBranch(sqlite.store, {
      requestKey: 'parent-archive-copy',
      destinationConversationId: 'parent-archive-copy',
      source: { kind: 'archive', bytes: parentArchive },
    });
    expect(archivePlan.ready).toBe(true);
    await branch(sqlite.store, {
      requestKey: 'parent-archive-copy',
      destinationConversationId: 'parent-archive-copy',
      source: { kind: 'archive', bytes: parentArchive },
    });
    await branch(sqlite.store, {
      requestKey: 'parent-rebranch',
      destinationConversationId: 'parent-rebranch',
      source: { kind: 'conversation', conversationId: 'parent-copy' },
    });

    const copiedParentEvents = (
      await sqlite.store.readEvents({ conversationId: 'parent-copy', limit: 200 })
    ).items;
    const serializedParent = JSON.stringify(copiedParentEvents);
    expect(serializedParent).toContain('"policyName":"child-budget"');
    expect(serializedParent).toContain('"policyName":"parent-interrupt"');
    expect(serializedParent).toContain('"stopDurationMs":');
    expect(serializedParent).toContain('"action":"message-sent"');
    expect(serializedParent).toContain('"action":"blocking-presented"');
    expect(serializedParent).toContain('"action":"blocking-resolved"');
    expect(serializedParent).not.toContain('"child-a"');
    expect(serializedParent).not.toContain('"child-call-1"');
    expect(serializedParent).not.toContain('"apr-1"');

    // Negative control: unknown key (`rogue: true`) MUST still be rejected by `.strict()`.
    for (const badEvent of [
      {
        kind: 'child/state',
        payload: { childConversationId: 'child-a', state: 'running', rogue: true },
      },
      {
        kind: 'child/spawned',
        payload: { childConversationId: 'child-x', seedUptoSeq: 0, budget: {}, rogue: true },
      },
    ] as const) {
      const tampered = decodeAgentConversationArchive(parentArchive);
      tampered.events.push({
        schemaVersion: 1,
        eventId: `rogue-${badEvent.kind}`,
        conversationId: 'parent',
        seq: tampered.events.length + 1,
        kind: badEvent.kind,
        occurredAt: '2026-10-15T00:00:00.000Z',
        payload: z.json().parse(badEvent.payload),
      });
      const tamperedBytes = encodeAgentConversationArchive(tampered);
      const badPlan = await planBranch(sqlite.store, {
        requestKey: `bad-${badEvent.kind}`,
        destinationConversationId: `bad-${badEvent.kind}`,
        source: { kind: 'archive', bytes: tamperedBytes },
      });
      expect(badPlan.ready).toBe(false);
      expect(badPlan.refusals.some((refusal) => refusal.code === 'integrity')).toBe(true);
      await expect(
        branch(sqlite.store, {
          requestKey: `bad-${badEvent.kind}`,
          destinationConversationId: `bad-${badEvent.kind}`,
          source: { kind: 'archive', bytes: tamperedBytes },
        }),
      ).rejects.toThrow(/unrecognized/i);
    }
  } finally {
    await sqlite.close();
  }
});

test('branching preserves read_output without offset and search_output without host maxSearchResults', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  const root = mkdtempSync(join(tmpdir(), 'stitchkit-branch-read-output-'));
  try {
    const spills = createAgentSpillStore({
      host: sqlite.host,
      conversationId: 'source',
      runId: 'first',
    });
    const { reference } = await spills.write({
      data: new TextEncoder().encode('alpha\nbeta\n'),
      mediaType: 'text/plain',
      authorization: { operation: 'read', path: 'source.txt' },
      toolCallId: 'call-read',
    });

    // Calling the real `read_output` tool handler without `offset` defaults offset to 0.
    const tools = createAgentCodingTools({
      root,
      authorize: () => true,
      artifacts: spills,
    });
    const readTool = tools.find((tool) => tool.name === 'read_output');
    if (!readTool) throw new Error('expected read_output coding tool');
    const parsedInput = readTool.input.parse({ reference });
    expect(parsedInput).toEqual({ reference });
    expect('offset' in parsedInput).toBe(false);
    const readResult = await readTool.handler({ params: undefined, input: parsedInput });
    expect(readResult).toEqual({
      reference,
      offset: 0,
      text: 'alpha\nbeta\n',
      bytes: 11,
      totalBytes: 11,
    });

    await branchTurn(sqlite.store, 'source', 'first', [
      {
        type: 'tool-call',
        callId: 'call-read',
        toolName: 'read_output',
        input: { reference },
      },
      {
        type: 'tool-result',
        callId: 'call-read',
        toolName: 'read_output',
        outcome: 'success',
        output: { reference, offset: 0, text: 'alpha\nbeta\n', bytes: 11, totalBytes: 11 },
      },
      {
        type: 'tool-call',
        callId: 'call-search-min',
        toolName: 'search_output',
        input: { reference, query: 'beta' },
      },
      {
        type: 'tool-result',
        callId: 'call-search-min',
        toolName: 'search_output',
        outcome: 'success',
        output: { reference, matches: [{ line: 2, text: 'beta' }] },
      },
      {
        type: 'tool-call',
        callId: 'call-search-high',
        toolName: 'search_output',
        input: { reference, query: 'alpha', maxMatches: 500 },
      },
      {
        type: 'tool-result',
        callId: 'call-search-high',
        toolName: 'search_output',
        outcome: 'success',
        output: { reference, matches: [{ line: 1, text: 'alpha' }] },
      },
    ]);

    await branch(sqlite.store, {
      requestKey: 'artifact-tools',
      destinationConversationId: 'copy',
      source: { kind: 'conversation', conversationId: 'source' },
      artifactAuthorization: { operation: 'read', path: 'dest.txt' },
    });

    const parts = (await sqlite.store.loadSnapshot('copy')).messages.flatMap(
      (message) => message.parts,
    );
    const readCall = parts.find(
      (part) => part.type === 'tool-call' && part.toolName === 'read_output',
    );
    if (readCall?.type !== 'tool-call') throw new Error('missing read_output call');
    const readInput = z.record(z.string(), z.unknown()).parse(readCall.input);
    expect(readInput).toEqual({ reference: expect.any(String) });
    expect('offset' in readInput).toBe(false);
    expect(readInput.reference).not.toBe(reference);

    const searchCalls = parts.filter(
      (part) => part.type === 'tool-call' && part.toolName === 'search_output',
    );
    expect(searchCalls).toHaveLength(2);
    const firstSearch = searchCalls[0];
    if (firstSearch?.type !== 'tool-call') throw new Error('missing first search_output call');
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(firstSearch.input))).toEqual([
      'reference',
      'query',
    ]);
    expect(searchCalls[1]?.type === 'tool-call' && searchCalls[1].input).toMatchObject({
      query: 'alpha',
      maxMatches: 500,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    await sqlite.close();
  }
});

test('custom tools named read_output, search_output and run_command fall through to branchOpaqueJson', async () => {
  for (const toolName of ['read_output', 'search_output', 'run_command'] as const) {
    // 1. Harmless custom shape passes without ZodError.
    const harmless = createMemoryAgentRuntimeStore();
    await branchTurn(harmless, 'source', 'first', [
      { type: 'tool-call', callId: 'c1', toolName, input: { custom: 1 } },
      {
        type: 'tool-result',
        callId: 'c1',
        toolName,
        outcome: 'success',
        output: { custom: 2 },
      },
    ]);
    await branch(harmless, {
      requestKey: `harmless-${toolName}`,
      destinationConversationId: 'copy',
      source: { kind: 'conversation', conversationId: 'source' },
    });
    const copiedParts = (await harmless.loadSnapshot('copy')).messages.flatMap(
      (message) => message.parts,
    );
    const copiedCall = copiedParts.find((part) => part.type === 'tool-call');
    const copiedResult = copiedParts.find((part) => part.type === 'tool-result');
    expect(copiedCall?.type === 'tool-call' && copiedCall.input).toEqual({ custom: 1 });
    expect(copiedResult?.type === 'tool-result' && copiedResult.output).toEqual({ custom: 2 });

    // 2. Custom output with `{ runId: 'first' }` falls through to branchOpaqueJson and asks for applicationKeys.
    const opaqueOut = createMemoryAgentRuntimeStore();
    await branchTurn(opaqueOut, 'source', 'first', [
      { type: 'tool-call', callId: 'c1', toolName, input: { custom: 1 } },
      {
        type: 'tool-result',
        callId: 'c1',
        toolName,
        outcome: 'success',
        output: { runId: 'first', custom: true },
      },
    ]);
    await expect(
      branch(opaqueOut, {
        requestKey: `opaque-out-${toolName}`,
        destinationConversationId: 'copy',
        source: { kind: 'conversation', conversationId: 'source' },
      }),
    ).rejects.toThrow('declare it in applicationKeys');
    await branch(opaqueOut, {
      requestKey: `opaque-out-declared-${toolName}`,
      destinationConversationId: 'copy-declared',
      source: { kind: 'conversation', conversationId: 'source' },
      applicationKeys: [{ key: 'runId', sourceIdentity: 'retain' }],
    });

    // 3. Custom input with `{ runId: 'first' }` also falls through to branchOpaqueJson.
    const opaqueIn = createMemoryAgentRuntimeStore();
    await branchTurn(opaqueIn, 'source', 'first', [
      { type: 'tool-call', callId: 'c1', toolName, input: { runId: 'first', custom: true } },
      {
        type: 'tool-result',
        callId: 'c1',
        toolName,
        outcome: 'success',
        output: { custom: 2 },
      },
    ]);
    await expect(
      branch(opaqueIn, {
        requestKey: `opaque-in-${toolName}`,
        destinationConversationId: 'copy',
        source: { kind: 'conversation', conversationId: 'source' },
      }),
    ).rejects.toThrow('declare it in applicationKeys');
    await branch(opaqueIn, {
      requestKey: `opaque-in-declared-${toolName}`,
      destinationConversationId: 'copy-declared',
      source: { kind: 'conversation', conversationId: 'source' },
      applicationKeys: [{ key: 'runId', sourceIdentity: 'retain' }],
    });
  }
});
