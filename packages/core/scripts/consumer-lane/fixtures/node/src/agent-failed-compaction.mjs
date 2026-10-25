import assert from 'node:assert/strict';
import {
  AgentMessageSchema,
  AgentRunSchema,
  createMemoryAgentRuntimeStore,
  decodeAgentConversationArchive,
  projectAgentHistoryDetailed,
  selectCompactableHistory,
  structuredCompaction,
} from 'stitchkit/agent-runtime';
import { createLocalStepDurability } from 'stitchkit/tools';
import { z } from 'zod';

const at = '2026-10-25T00:00:00.000Z';
const conversationId = 'failed-compaction';
const evidencePolicy = { failedAssistant: 'assistant-marked' };
const summarySchema = z.object({ failed: z.array(z.string()), evidence: z.string() });

function message(id, role, status, parts, runId) {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    role,
    status,
    parts,
    createdAt: at,
    updatedAt: at,
    ...(runId && { runId }),
  });
}

function pair(id, status = 'completed', parts = [{ type: 'text', text: 'done' }]) {
  return [
    message(`u${id}`, 'user', 'committed', [{ type: 'text', text: `question ${id}` }]),
    message(`a${id}`, 'assistant', status, parts, `r${id}`),
  ];
}

function selectionControls() {
  const later = [...pair(2), ...pair(3)];
  for (const parts of [[], [{ type: 'control', reason: 'stale-run' }]]) {
    const failed = pair(1, 'failed', parts);
    const messages = [...failed, ...later];
    assert.equal(
      selectCompactableHistory({ messages, keepRecentTurns: 1 }).compactable.length,
      0,
    );
    const selected = selectCompactableHistory({
      messages,
      keepRecentTurns: 1,
      evidencePolicy,
    });
    assert.deepEqual(selected.compactable, [...failed, ...pair(2)]);
    assert.deepEqual(selected.retained, pair(3));
  }
  const call = { type: 'tool-call', callId: 'c', toolName: 'send', input: {} };
  const result = {
    type: 'tool-result',
    callId: 'c',
    toolName: 'send',
    outcome: 'error',
    output: { code: 'UNKNOWN' },
  };
  const request = { type: 'tool-approval-request', callId: 'c', approvalId: 'approve' };
  const denied = { type: 'tool-approval-response', approvalId: 'approve', approved: false };
  for (const parts of [
    [call],
    [result],
    [call, request],
    [call, request, result],
    [call, { ...result, callId: 'wrong' }],
    [call, result, result],
    [call, request, denied, { ...result, outcome: 'success' }],
  ]) {
    const messages = [...pair(1, 'failed', parts), ...later];
    assert.deepEqual(
      selectCompactableHistory({ messages, keepRecentTurns: 0, evidencePolicy }),
      { compactable: [], retained: messages },
    );
  }
  for (const prefix of [[pair(1)[0]], pair(1, 'streaming', []), pair(1, 'superseded', [])]) {
    const messages = [...prefix, ...later];
    assert.equal(
      selectCompactableHistory({ messages, keepRecentTurns: 0, evidencePolicy }).compactable
        .length,
      0,
    );
  }
  const unknown = pair(1, 'failed', [call, result]);
  assert.deepEqual(
    selectCompactableHistory({
      messages: [...unknown, ...later],
      keepRecentTurns: 1,
      evidencePolicy,
    }).compactable,
    [...unknown, ...pair(2)],
  );
}

async function projectionControls() {
  for (const parts of [[], [{ type: 'control', reason: 'stale-run' }]]) {
    const failed = pair(1, 'failed', parts);
    assert.equal((await projectAgentHistoryDetailed(failed)).messages.length, 1);
    const projected = await projectAgentHistoryDetailed(failed, {
      evidencePolicy,
      incompleteToolTurn: 'error',
    });
    assert.equal(
      projected.messages.length,
      2,
      'empty failed assistant lost its failure marker',
    );
    assert.match(JSON.stringify(projected.messages[1]), /did not complete successfully/);
    assert.equal(failed[1].status, 'failed');
  }
  const emptyInterrupted = await projectAgentHistoryDetailed(pair(1, 'interrupted', []), {
    evidencePolicy,
  });
  assert.equal(emptyInterrupted.messages.length, 1);
  const split = [
    ...pair(1, 'failed', [
      { type: 'tool-call', callId: 'split', toolName: 'send', input: {} },
    ]),
    message('result', 'tool', 'committed', [
      {
        type: 'tool-result',
        callId: 'split',
        toolName: 'send',
        outcome: 'error',
        output: { code: 'UNKNOWN' },
      },
    ]),
  ];
  assert.equal(
    selectCompactableHistory({ messages: split, keepRecentTurns: 0, evidencePolicy })
      .compactable.length,
    3,
  );
  await assert.rejects(
    projectAgentHistoryDetailed(split, { evidencePolicy, incompleteToolTurn: 'error' }),
    /incomplete tool chronology/,
  );
}

async function appendTurn(
  store,
  id,
  status = 'completed',
  parts = [{ type: 'text', text: 'done' }],
) {
  const [input, assistant] = pair(id, status, parts);
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id: `r${id}`,
    conversationId,
    inputMessageIds: [input.id],
    assistantMessageId: assistant.id,
    state: 'queued',
    revision: 0,
    createdAt: at,
    updatedAt: at,
  });
  const admission = { idempotencyKey: `request-${id}`, input, run };
  assert.equal((await store.acceptInputAndAssignRun(admission)).outcome, 'applied');
  const acquired = await store.acquireRun({
    conversationId,
    runId: run.id,
    expectedRevision: 0,
    ownerId: 'proof',
  });
  assert.equal(acquired.outcome, 'applied');
  const owned = acquired.snapshot.runs.find((candidate) => candidate.id === run.id);
  const terminal = {
    conversationId,
    runId: run.id,
    expectedRevision: owned.revision,
    ownerId: 'proof',
    assistant,
    reason: status === 'failed' ? 'provider_failure' : 'success',
  };
  assert.equal((await store.commitRunTerminal(terminal)).outcome, 'applied');
  return { admission, terminal, assistant };
}

function compactor(summarize, maxAttempts = 1) {
  let summaries = 0;
  return structuredCompaction({
    schema: summarySchema,
    keepRecentTurns: 1,
    evidencePolicy,
    maxAttempts,
    threshold: () => true,
    summarize,
    readPreviousSummary: (entry) => JSON.parse(entry.parts[0].text),
    createSummaryMessage: ({ summary }) =>
      message(`summary-${++summaries}`, 'summary', 'committed', [
        { type: 'text', text: JSON.stringify(summary) },
      ]),
  });
}

async function summarize({ eligibleMessages, previousSummary }) {
  const projected = await projectAgentHistoryDetailed(eligibleMessages, {
    evidencePolicy,
    incompleteToolTurn: 'error',
  });
  const failed = eligibleMessages
    .filter((entry) => entry.status === 'failed')
    .map((entry) => entry.id);
  const evidence = JSON.stringify(projected.messages);
  if (failed.length > 0) assert.match(evidence, /did not complete successfully/);
  return summarySchema.parse({
    failed: [...(previousSummary?.failed ?? []), ...failed],
    evidence,
  });
}

const compactInput = (store) => ({
  conversationId,
  store,
  signal: new AbortController().signal,
});
const engine = (store) => createLocalStepDurability({ store, conversationId, runId: 'r1' });
const events = (bytes) => decodeAgentConversationArchive(bytes).events;

async function storeControls(store, restored) {
  const failed = await appendTurn(store, 1, 'failed', []);
  await appendTurn(store, 2);
  await appendTurn(store, 3);
  let sends = 0;
  const proof = { receipt: 'remote-1' };
  assert.deepEqual(
    await engine(store).effect('accepted', {
      run: () => {
        sends++;
        return proof;
      },
      reconcile: () => null,
    }),
    { outcome: 'accepted', proof },
  );
  for (const name of ['pending', 'unknown']) {
    await assert.rejects(
      engine(store).effect(name, {
        run: () => {
          throw new Error('lost acknowledgement');
        },
        reconcile: () => null,
      }),
      /pending|unknown/,
    );
  }
  assert.deepEqual(
    await engine(store).effect('unknown', {
      run: () => assert.fail('unknown retried'),
      reconcile: () => null,
    }),
    { outcome: 'uncertain' },
  );
  const before = events(await store.exportConversation(conversationId));
  const result = await compactor(summarize)(compactInput(store));
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(
    result.snapshot.messages.map((entry) => entry.id),
    ['summary-1', 'u3', 'a3'],
  );
  assert.deepEqual(JSON.parse(result.snapshot.messages[0].parts[0].text).failed, ['a1']);
  const after = events(await store.exportConversation(conversationId));
  assert.deepEqual(
    after.slice(0, before.length),
    before,
    'compaction changed canonical journal receipts',
  );
  assert.deepEqual(
    after.filter((entry) => entry.kind === 'durability/effect'),
    before.filter((entry) => entry.kind === 'durability/effect'),
  );
  const duplicate = await store.acceptInputAndAssignRun(failed.admission);
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(duplicate.run.terminalReason, 'provider_failure');
  assert.deepEqual(duplicate.assistant, failed.assistant);
  assert.equal((await store.commitRunTerminal(failed.terminal)).outcome, 'conflict');
  assert.deepEqual(
    (await store.loadSnapshot(conversationId)).messages,
    result.snapshot.messages,
  );
  await restored.importConversation(await store.exportConversation(conversationId));
  assert.deepEqual(
    (await restored.loadSnapshot(conversationId)).messages,
    result.snapshot.messages,
  );
  assert.deepEqual(
    (await restored.loadRun({ conversationId, runId: 'r1' })).assistant,
    failed.assistant,
  );
  const never = () => assert.fail('a recorded effect was dispatched again');
  assert.deepEqual(
    await engine(restored).effect('accepted', { run: never, reconcile: never }),
    { outcome: 'accepted', proof },
  );
  assert.deepEqual(
    await engine(restored).effect('unknown', { run: never, reconcile: never }),
    { outcome: 'uncertain' },
  );
  let reconciles = 0;
  assert.deepEqual(
    await engine(restored).effect('pending', {
      run: never,
      reconcile: () => {
        reconciles++;
        return proof;
      },
    }),
    { outcome: 'accepted', proof },
  );
  assert.equal(reconciles, 1);
  assert.equal(sends, 1);
}

async function conflictControls() {
  const store = createMemoryAgentRuntimeStore();
  await appendTurn(store, 1, 'failed', []);
  await appendTurn(store, 2);
  await appendTurn(store, 3);
  const before = await store.loadSnapshot(conversationId);
  await assert.rejects(
    compactor(() => {
      throw new Error('summary unavailable');
    })(compactInput(store)),
    /summary unavailable/,
  );
  assert.deepEqual(await store.loadSnapshot(conversationId), before);
  let attempts = 0;
  const stale = await compactor(async (context) => {
    await appendTurn(store, 4);
    return summarize(context);
  })(compactInput(store));
  assert.equal(stale.outcome, 'conflict');
  assert.equal((await store.loadSnapshot(conversationId)).messages.length, 8);
  const retried = await compactor(async (context) => {
    attempts++;
    if (attempts === 1) await appendTurn(store, 5);
    return summarize(context);
  }, 2)(compactInput(store));
  assert.equal(retried.outcome, 'applied');
  assert.equal(retried.attempts, 2);
  assert.equal(attempts, 2);
  assert.match(JSON.parse(retried.snapshot.messages[0].parts[0].text).evidence, /question 4/);
  assert.deepEqual(
    retried.snapshot.messages.slice(1).map((entry) => entry.id),
    ['u5', 'a5'],
  );
  await appendTurn(store, 6);
  const merged = await compactor(summarize)(compactInput(store));
  assert.equal(merged.outcome, 'applied');
  assert.equal(merged.snapshot.messages.filter((entry) => entry.role === 'summary').length, 1);
  assert.deepEqual(JSON.parse(merged.snapshot.messages[0].parts[0].text).failed, ['a1']);
}

selectionControls();
await projectionControls();
await conflictControls();
await storeControls(createMemoryAgentRuntimeStore(), createMemoryAgentRuntimeStore());
const open = process.versions.bun
  ? (await import('stitchkit/agent-runtime/sqlite/bun')).createBunSqliteAgentRuntimeStore
  : (await import('stitchkit/agent-runtime/sqlite/node')).createNodeSqliteAgentRuntimeStore;
const sqlite = open({ filename: ':memory:' });
const restored = open({ filename: ':memory:' });
try {
  await storeControls(sqlite.store, restored.store);
} finally {
  await restored.close();
  await sqlite.close();
}
console.log('packed failed compaction evidence: ok');
