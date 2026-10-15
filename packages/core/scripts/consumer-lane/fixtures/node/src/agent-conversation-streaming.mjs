import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as runtimeRecords from 'stitchkit/agent-runtime';
import {
  agentSummaryProjection,
  createAgentStateSlotStore,
  createMemoryAgentRuntimeStore,
  createSqliteAgentProjectionStore,
  decodeAgentConversationArchive,
  defineStateSlot,
} from 'stitchkit/agent-runtime';
import { z } from 'zod';
import { streamingFixture } from './agent-conversation-streaming-fixture.mjs';

const sqlite = process.versions.bun
  ? (await import('stitchkit/agent-runtime/sqlite/bun')).createBunSqliteAgentRuntimeStore({
      filename: ':memory:',
    })
  : (await import('stitchkit/agent-runtime/sqlite/node')).createNodeSqliteAgentRuntimeStore({
      filename: ':memory:',
    });
try {
  const fresh = await streamingFixture(sqlite);
  const legacy = new Uint8Array(
    readFileSync(new URL('./agent-conversation-streaming-v0.109.4.json', import.meta.url)),
  );
  for (const [label, bytes] of [
    ['fresh', fresh.bytes],
    ['0.109.4', legacy],
  ]) {
    const archive = decodeAgentConversationArchive(bytes);
    assert.equal(archive.projections.length, 4);
    const runId = archive.events.find(
      (event) => event.kind === 'runtime/transition' && event.payload.type === 'terminal',
    ).payload.input.runId;
    for (const store of [sqlite.store, createMemoryAgentRuntimeStore()]) {
      const id = `restored-${label}`;
      const request = {
        requestKey: id,
        destinationConversationId: id,
        source: { kind: 'archive', bytes },
        artifactAuthorization: { operation: 'read', path: 'destination-only' },
      };
      const created = await store.branchConversation(request);
      assert.deepEqual(await store.branchConversation(request), {
        outcome: 'duplicate',
        receipt: created.receipt,
      });
      const snapshot = await store.loadSnapshot(id);
      assert.equal(snapshot.messages[0].role, 'summary');
      assert.equal(snapshot.messages[0].parts[0].text, 'compacted streamed context');
      assert.ok(snapshot.runs.every((run) => !run.ownerId && run.fencingToken === undefined));
      const output = decodeAgentConversationArchive(await store.exportConversation(id));
      assert.equal(output.spills.length, 1);
      assert.notEqual(output.spills[0].reference, archive.spills[0].reference);
      assert.deepEqual(output.spills[0].authorization, request.artifactAuthorization);
      assert.equal(output.projections.length, 1);
      assert.ok(output.events.some((event) => event.kind === 'runtime/branch-observation'));
      const states = createAgentStateSlotStore({
        store,
        definitions: [defineStateSlot({ name: 'permission', schema: z.boolean() })],
      });
      assert.equal(await states.get(id, 'permission'), undefined);
      const rebranch = `again-${label}`;
      await store.branchConversation({
        ...request,
        destinationConversationId: rebranch,
        source: { kind: 'conversation', conversationId: id },
      });
      assert.equal((await store.loadSnapshot(rebranch)).messages[0].role, 'summary');
    }
    let checkpoints = 0;
    for (const event of archive.events) {
      if (event.kind !== 'runtime/transition') continue;
      const record = runtimeRecords.AgentStoreTransitionRecordSchema.parse(event.payload);
      assert.deepEqual(record, event.payload);
      if (record.type === 'checkpoint' && typeof record.input.assistant.parts === 'number')
        checkpoints++;
    }
    assert.ok(checkpoints > 0);
    if (label === 'fresh') {
      await sqlite.store.branchConversation({
        requestKey: 'exact',
        destinationConversationId: 'exact',
        source: {
          kind: 'conversation',
          conversationId: fresh.conversationId,
          throughRunId: runId,
        },
        artifactAuthorization: { operation: 'read', path: 'exact-only' },
      });
      const exact = await sqlite.store.loadSnapshot('exact');
      assert.equal(exact.messages.length, 2);
      assert.ok(
        exact.messages
          .flatMap((message) => message.parts)
          .some((part) => part.type === 'tool-result'),
      );
      const projections = createSqliteAgentProjectionStore({ sqlite });
      assert.equal(projections.load('exact', agentSummaryProjection), undefined);
      assert.ok(
        (await projections.advance('exact', agentSummaryProjection)).value.eventCount > 0,
      );
    }
  }
  assert.deepEqual(await sqlite.store.exportConversation(fresh.conversationId), fresh.bytes);
} finally {
  await sqlite.close();
}
console.log('packed streaming conversation branch: ok');
