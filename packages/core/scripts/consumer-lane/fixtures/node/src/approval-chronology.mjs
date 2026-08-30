import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { defineAgentProtocol, projectAgentHistoryDetailed } from 'stitchkit/agent-runtime';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import { createHeadlessAgentHarness } from 'stitchkit/agent-runtime/harness';
import { mountAgent } from 'stitchkit/tools';
import { z } from 'zod';

// SQLite drivers are runtime-specific leaves; neither host imports the other driver.
const openSqlite = process.versions.bun
  ? (await import('stitchkit/agent-runtime/sqlite/bun')).createBunSqliteAgentRuntimeStore
  : (await import('stitchkit/agent-runtime/sqlite/node')).createNodeSqliteAgentRuntimeStore;
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const toolStream = (id, toolName, input) => ({
  stream: simulateReadableStream({
    chunks: [
      { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
    ],
  }),
});
const textStream = () => ({
  stream: simulateReadableStream({
    chunks: [
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: 'complete' },
      { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
    ],
  }),
});

for (const automatic of [false, true]) {
  const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-packed-approval-'));
  const filename = path.join(root, 'runtime.sqlite');
  let sqlite = openSqlite({ filename });
  const writes = [];
  const model = new MockLanguageModelV4({
    doStream: [
      toolStream(
        'first',
        automatic ? 'read_file' : 'write_file',
        automatic ? { path: 'seed.txt' } : { path: 'first.txt', content: 'first' },
      ),
      toolStream('second', 'write_file', { path: 'second.txt', content: 'second' }),
      textStream(),
      textStream(),
    ],
  });
  const open = () =>
    createHeadlessAgentHarness({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
        terminalAcceptance: 'require-output',
      }),
      store: sqlite.store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fixture',
            modelId: 'packed-approval',
            contextWindow: 16_000,
            capabilities: ['tools'],
          },
          model,
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => ({
        contextWindow,
        reservedOutput: 1_000,
        toolSchemas: { value: 100, provenance: 'measured' },
        attachments: { value: 0, provenance: 'measured' },
        providerOverhead: { provenance: 'unavailable' },
      }),
      tools: (context) =>
        mountAgent([], {
          runtimeTools: createAgentCodingTools({
            root,
            authorize: (request) => {
              if (request.operation === 'write') writes.push(request.path);
              return true;
            },
          }),
          lifecycle: context.toolFenceLifecycle,
        }),
      loop: {
        toolApproval: { read_file: 'approved', write_file: 'user-approval' },
        toolApprovalSecret: 'packed-chronology-secret',
      },
    });
  let harness = open();
  try {
    await writeFile(path.join(root, 'seed.txt'), 'seed');
    const requested = await harness.submit({
      conversationId: 'packed',
      idempotencyKey: 'initial',
      context: {},
      parts: [{ type: 'text', text: 'apply two operations' }],
      metadata: {},
    }).result;
    assert.equal(requested.reason, 'provider_stop');
    if (!automatic) {
      const [pending] = await harness.pendingApprovals('packed');
      assert.ok(pending?.signature);
      const first = await harness.respondToApproval({
        conversationId: 'packed',
        approvalId: pending.approvalId,
        approved: true,
        context: {},
      });
      assert.equal((await first.result).reason, 'provider_stop');
    }
    const [before] = await harness.pendingApprovals('packed');
    assert.equal(before?.callId, 'second');
    assert.ok(before.signature);
    await harness.close();
    await sqlite.close();
    sqlite = openSqlite({ filename });
    harness = open();
    assert.deepEqual(await harness.pendingApprovals('packed'), [before]);
    const second = await harness.respondToApproval({
      conversationId: 'packed',
      approvalId: before.approvalId,
      approved: true,
      context: {},
    });
    assert.equal((await second.result).reason, 'success');
    assert.equal(model.doStreamCalls.length, 3);
    assert.equal(await readFile(path.join(root, 'second.txt'), 'utf8'), 'second');
    if (!automatic)
      assert.equal(await readFile(path.join(root, 'first.txt'), 'utf8'), 'first');
    assert.deepEqual(writes, automatic ? ['second.txt'] : ['first.txt', 'second.txt']);
    const snapshot = await harness.snapshot('packed');
    assert.equal(
      (await projectAgentHistoryDetailed(snapshot.messages)).decisions.every(
        ({ action }) => action === 'projected',
      ),
      true,
    );
    assert.deepEqual(
      snapshot.messages
        .flatMap(({ parts }) => parts)
        .filter(({ type }) => type === 'tool-result')
        .map(({ callId }) => callId),
      ['first', 'second'],
    );
    const later = await harness.submit({
      conversationId: 'packed',
      idempotencyKey: 'later',
      context: {},
      parts: [{ type: 'text', text: 'ordinary next message' }],
      metadata: {},
    }).result;
    assert.equal(later.reason, 'success');
    assert.equal(model.doStreamCalls.length, 4);
    assert.deepEqual(writes, automatic ? ['second.txt'] : ['first.txt', 'second.txt']);
    assert.deepEqual(await harness.pendingApprovals('packed'), []);
  } finally {
    await harness.close();
    await sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
}
console.log('packed approval chronology: ok');
