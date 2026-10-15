import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentStateSlotStore,
  createMemoryAgentRuntimeStore,
  decodeAgentConversationArchive,
  defineStateSlot,
  encodeAgentConversationArchive,
} from 'stitchkit/agent-runtime';
import { z } from 'zod';
import { streamingFixture } from './agent-conversation-streaming-fixture.mjs';

const open = process.versions.bun
  ? (await import('stitchkit/agent-runtime/sqlite/bun')).createBunSqliteAgentRuntimeStore
  : (await import('stitchkit/agent-runtime/sqlite/node')).createNodeSqliteAgentRuntimeStore;
const options = {
  example: { signature: 'synthetic-provider-signature', cache: { type: 'ephemeral' } },
};
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
function inspect(archive, source) {
  const messages = new Map();
  const parts = new Set();
  for (const event of archive.events) {
    if (event.kind === 'provider/message') {
      assert.equal(event.payload.sha256, hash(event.payload.message));
      messages.set(event.payload.sha256, event.payload.message);
      for (const part of event.payload.message.content) {
        if (part.providerOptions) {
          assert.deepEqual(part.providerOptions, options);
          parts.add(part.type);
        }
        if (source && part.type === 'tool-call')
          assert.notEqual(part.toolCallId, 'fixture-call');
      }
    }
    if (event.kind === 'provider/request') {
      const request = event.payload;
      assert.ok(request.messageShas.every((sha) => messages.has(sha)));
      assert.equal(
        request.bodySha256,
        createHash('sha256')
          .update(request.instructionsSha256)
          .update(request.messageShas.join(','))
          .digest('hex'),
      );
    }
  }
  assert.ok(parts.has('reasoning'));
  assert.ok(parts.has('tool-call'));
  assert.ok(parts.has('text'));
}

const scratch = mkdtempSync(join(tmpdir(), 'stitchkit-provider-journal-'));
let sqlite = open({ filename: join(scratch, 'store.sqlite') });
let legacySqlite = open({ filename: join(scratch, 'legacy.sqlite') });
try {
  const fresh = await streamingFixture(sqlite, options);
  const legacy = new Uint8Array(
    readFileSync(new URL('./agent-provider-journal-v0.109.4.json', import.meta.url)),
  );
  const requests = [];
  for (const [label, bytes] of [
    ['fresh', fresh.bytes],
    ['0.109.4', legacy],
  ]) {
    const archive = decodeAgentConversationArchive(bytes);
    inspect(archive, false);
    assert.equal(archive.formatVersion, 1);
    assert.equal(archive.projections.length, 4);
    for (const [backend, store] of [
      ['sqlite', label === 'fresh' ? sqlite.store : legacySqlite.store],
      ['memory', createMemoryAgentRuntimeStore()],
    ]) {
      if (label !== 'fresh' || backend !== 'sqlite') await store.importConversation(bytes);
      for (const kind of ['archive', 'conversation']) {
        const id = `${label}-${backend}-${kind}`;
        const source =
          kind === 'archive'
            ? { kind, bytes }
            : { kind, conversationId: archive.conversationId };
        const request = {
          requestKey: id,
          destinationConversationId: id,
          source,
          artifactAuthorization: { operation: 'read', path: id },
        };
        const created = await store.branchConversation(request);
        assert.deepEqual(await store.branchConversation(request), {
          outcome: 'duplicate',
          receipt: created.receipt,
        });
        if (backend === 'sqlite') requests.push([label, request, created.receipt]);
        const output = decodeAgentConversationArchive(await store.exportConversation(id));
        inspect(output, true);
        const snapshot = await store.loadSnapshot(id);
        assert.ok(
          snapshot.runs.every((run) => !run.ownerId && run.fencingToken === undefined),
        );
        assert.equal(snapshot.messages[0].role, 'summary');
        assert.equal(output.projections.length, 1);
        assert.ok(output.events.some((event) => event.kind === 'runtime/branch-observation'));
        const states = createAgentStateSlotStore({
          store,
          definitions: [defineStateSlot({ name: 'permission', schema: z.boolean() })],
        });
        assert.equal(await states.get(id, 'permission'), undefined);
      }
    }
    for (const defect of ['unknown', 'hash', 'identity', 'request']) {
      const changed = structuredClone(archive);
      const messageEvent = changed.events.find(
        (event) =>
          event.kind === 'provider/message' &&
          event.payload.message.content.some((part) => part.type === 'tool-call'),
      );
      assert.ok(messageEvent);
      if (defect === 'unknown') messageEvent.payload.message.content[0].undocumented = true;
      if (defect === 'identity')
        messageEvent.payload.message.content.find(
          (part) => part.type === 'tool-call',
        ).toolCallId = 'foreign';
      if (defect === 'hash') messageEvent.payload.sha256 = '0'.repeat(64);
      else messageEvent.payload.sha256 = hash(messageEvent.payload.message);
      if (defect === 'request')
        changed.events.find((event) => event.kind === 'provider/request').payload.bodySha256 =
          '0'.repeat(64);
      for (const store of [sqlite.store, createMemoryAgentRuntimeStore()]) {
        const id = `bad-${label}-${defect}`;
        await assert.rejects(
          store.branchConversation({
            requestKey: id,
            destinationConversationId: id,
            source: { kind: 'archive', bytes: encodeAgentConversationArchive(changed) },
          }),
          /Unrecognized|digest is inconsistent|foreign or missing/,
        );
        const snapshot = await store.loadSnapshot(id);
        assert.equal(snapshot.version, 0);
        assert.equal(snapshot.messages.length, 0);
        assert.equal(snapshot.runs.length, 0);
      }
    }
  }
  assert.deepEqual(await sqlite.store.exportConversation(fresh.conversationId), fresh.bytes);
  await sqlite.close();
  await legacySqlite.close();
  sqlite = open({ filename: join(scratch, 'store.sqlite') });
  legacySqlite = open({ filename: join(scratch, 'legacy.sqlite') });
  for (const [label, request, receipt] of requests)
    assert.deepEqual(
      await (label === 'fresh' ? sqlite : legacySqlite).store.branchConversation(request),
      {
        outcome: 'duplicate',
        receipt,
      },
    );
} finally {
  await sqlite.close();
  await legacySqlite.close();
  rmSync(scratch, { recursive: true, force: true });
}
console.log('packed provider journal conversation branch: ok');
