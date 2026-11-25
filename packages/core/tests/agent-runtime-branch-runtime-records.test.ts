/**
 * A conversation that used the runtime's own capabilities branches without a
 * word from the host.
 *
 * The model invocation ledger, the deferred tool search and the event search
 * tools all write records into the conversation that name its runs and itself.
 * Those records are the runtime's, so the runtime carries them by their own
 * type: a host declares keys for *its* data, never for these.
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { InvocationFinishedSchema } from '../src/agent-runtime/invocation-schema';
import { createAgentSpillStore } from '../src/agent-runtime/spill';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentMessage,
  type AgentRuntimeStore,
  type BranchAgentConversationInput,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  createModelInvocationLedger,
  defineAgentProtocol,
  defineModelRegistry,
} from '../src/entrypoints/agent-runtime';
import { branch, branchTurn } from './support/agent-branch-fixture';

const LEDGER_KINDS = [
  'invocation/started',
  'invocation/finished',
  'provider/payload',
  'provider/request',
  'provider/response',
];
const trace = { operationId: 'operation', project: 'project', purpose: 'purpose' };
const usage = {
  inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const request = (destination: string, source = 'source') =>
  ({
    requestKey: destination,
    destinationConversationId: destination,
    source: { kind: 'conversation', conversationId: source },
  }) satisfies BranchAgentConversationInput;

const Payload = z.record(z.string(), z.json());
const ObservationSchema = z.object({ sourceKind: z.string(), payload: Payload });

/** A model that answers both a completion and an agent turn. */
function model() {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'the answer' }],
      usage,
      warnings: [],
      finishReason: { unified: 'stop', raw: undefined },
    }),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'hello' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ],
      }),
    }),
  });
}

/**
 * One real agent turn under the ledger, then one completion in the same
 * conversation: every record kind the ledger writes, as it writes them.
 */
async function audited(store: AgentRuntimeStore) {
  const models = defineModelRegistry({
    models: {
      model: { provider: 'mock', modelId: 'model', contextWindow: 8_000, capabilities: [] },
    },
    providers: { mock: { create: () => model() } },
  });
  const ledger = createModelInvocationLedger({
    store,
    models,
    payloadKey: randomBytes(32),
    authorize: () => ({ subject: 'verified' }),
  });
  const runtime = createAgentRuntime({
    store,
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    models: { resolve: () => models.resolve('model') },
    tools: () => ({}),
    prompt: () => ({
      instructions: '',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    invocations: { ledger, trace: () => trace },
  });
  try {
    const turn = await runtime.submit({
      conversationId: 'source',
      idempotencyKey: 'agent',
      context: {},
      parts: [{ type: 'text', text: 'hi' }],
    }).result;
    expect(turn.reason).toBe('success');
  } finally {
    await runtime.close();
  }
  const completion = await ledger.complete(
    {
      conversationId: 'source',
      idempotencyKey: 'completion',
      trace,
      models: ['model'],
      prompt: 'prompt',
      timeoutMs: 1_000,
    },
    {},
  );
  expect(completion.receiptError).toBeUndefined();
  return ledger;
}

const adapters = [
  ['memory', () => ({ store: createMemoryAgentRuntimeStore(), close: async () => undefined })],
  [
    'sqlite',
    () => {
      const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
      return { store: sqlite.store, close: () => sqlite.close() };
    },
  ],
] as const;

async function ledgerRecords(store: AgentRuntimeStore, conversationId: string) {
  return (await store.readEvents({ conversationId, limit: 500 })).items.filter((event) =>
    LEDGER_KINDS.includes(event.kind),
  );
}

async function observations(store: AgentRuntimeStore, conversationId: string) {
  return (await store.readEvents({ conversationId, limit: 500 })).items.flatMap((event) => {
    if (event.kind !== 'runtime/branch-observation') return [];
    const observed = ObservationSchema.parse(event.payload);
    return LEDGER_KINDS.includes(observed.sourceKind) ? [observed] : [];
  });
}

/** The source's ledger records as a branch carries them: the same, without the body. */
function asCarried(records: Awaited<ReturnType<typeof ledgerRecords>>) {
  return records.map((event) => {
    const { iv: _iv, tag: _tag, ciphertext: _body, ...payload } = Payload.parse(event.payload);
    return { sourceKind: event.kind, payload };
  });
}

for (const [adapter, open] of adapters)
  describe(`${adapter}: a conversation with a model invocation ledger`, () => {
    test('branches, and its records cross as inert receipts of the source call', async () => {
      const { store, close } = open();
      try {
        const ledger = await audited(store);
        const source = await ledgerRecords(store, 'source');
        expect(new Set(source.map((event) => event.kind))).toEqual(new Set(LEDGER_KINDS));
        // A completion names no run; the agent turn names its own.
        const runIds = source.map((event) => Payload.parse(event.payload).runId);
        expect(runIds).toContain(undefined);
        expect(runIds.some((runId) => typeof runId === 'string')).toBe(true);
        const before = await store.exportConversation('source');

        await branch(store, request('copy'));
        expect(await ledgerRecords(store, 'copy')).toEqual([]);
        expect(await ledger.read({ conversationId: 'copy', limit: 1_000 }, {})).toEqual({
          items: [],
        });
        const carried = await observations(store, 'copy');
        // Every record crosses exactly, still naming the call's own conversation
        // and run, and no encrypted body comes with it.
        expect(carried).toEqual(asCarried(source));
        const copied = await store.readEvents({ conversationId: 'copy', limit: 500 });
        expect(JSON.stringify(copied)).not.toContain('"ciphertext"');
        expect(Buffer.compare(before, await store.exportConversation('source'))).toBe(0);

        // The receipt still addresses its body where it lives.
        const artifact = carried.find((entry) => entry.sourceKind === 'provider/payload');
        const { artifactId } = z.object({ artifactId: z.string() }).parse(artifact?.payload);
        expect(
          await ledger.readPayload({ conversationId: 'source', artifactId }, {}),
        ).toBeDefined();
        await expect(
          ledger.readPayload({ conversationId: 'copy', artifactId }, {}),
        ).rejects.toThrow();

        // Already inert, the receipts cross again unchanged, and so from an archive.
        await branch(store, request('again', 'copy'));
        expect(await observations(store, 'again')).toEqual(carried);
        await branch(store, {
          ...request('restored'),
          source: { kind: 'archive', bytes: before },
        });
        expect(await observations(store, 'restored')).toEqual(carried);
      } finally {
        await close();
      }
    });
  });

test('an invocation record of another conversation or of an unknown run refuses the branch', async () => {
  for (const [identity, message] of [
    [{ conversationId: 'elsewhere', runId: 'first' }, 'another conversation'],
    [{ conversationId: 'source', runId: 'ghost' }, 'foreign or missing run reference'],
  ] as const) {
    const store = createMemoryAgentRuntimeStore();
    await branchTurn(store, 'source', 'first');
    await store.appendEvent({
      conversationId: 'source',
      kind: 'invocation/finished',
      payload: InvocationFinishedSchema.parse({
        ...identity,
        invocationId: 'invocation-1',
        operationId: 'operation-1',
        type: 'invocation/finished',
        status: 'succeeded',
      }),
    });
    await expect(branch(store, request('copy'))).rejects.toThrow(message);
    expect((await store.loadSnapshot('copy')).version).toBe(0);
  }
});

type ToolOutput = Extract<AgentMessage['parts'][number], { type: 'tool-result' }>['output'];

function receiptFor(runId: string) {
  return {
    schemaVersion: 1,
    kind: 'stitchkit.deferred-tool-selection',
    status: 'SELECTED',
    runId,
    surfaceKey: 'surface',
    selected: ['read_file'],
    matches: [{ name: 'read_file', description: 'Read a file' }],
    truncated: false,
  };
}

function searched(output: ToolOutput): AgentMessage['parts'] {
  return [
    // The search tool's name is the host's to choose; the receipt names itself.
    { type: 'tool-call', callId: 'search', toolName: 'find_tools', input: { query: 'files' } },
    {
      type: 'tool-result',
      callId: 'search',
      toolName: 'find_tools',
      outcome: 'success',
      output,
    },
  ];
}

async function resultOf(store: AgentRuntimeStore, conversationId: string, toolName: string) {
  const part = (await store.loadSnapshot(conversationId)).messages
    .flatMap((message) => message.parts)
    .find((entry) => entry.type === 'tool-result' && entry.toolName === toolName);
  if (part?.type !== 'tool-result') throw new Error(`the branch lost the ${toolName} result`);
  return part.output;
}

test('a deferred tool search receipt follows its run into the branch without any declaration', async () => {
  const store = createMemoryAgentRuntimeStore();
  await branchTurn(store, 'source', 'first', searched(receiptFor('first')));
  await branch(store, request('copy'));
  const [run] = (await store.loadSnapshot('copy')).runs;
  if (!run) throw new Error('the branch has no run');
  expect(run.id).not.toBe('first');
  // The receipt selects tools for the run it was written in: that run's copy.
  expect(await resultOf(store, 'copy', 'find_tools')).toEqual(receiptFor(run.id));

  // A receipt naming no run of this conversation is not its receipt: it is the
  // application's data, judged by the application's declaration.
  const foreign = createMemoryAgentRuntimeStore();
  await branchTurn(foreign, 'source', 'first', searched(receiptFor('elsewhere-run')));
  await expect(branch(foreign, request('copy'))).rejects.toThrow(
    'containing runId at runId; declare it in applicationKeys',
  );
  await branch(foreign, { ...request('copy'), applicationKeys: [{ key: 'runId' }] });
  expect(await resultOf(foreign, 'copy', 'find_tools')).toEqual(receiptFor('elsewhere-run'));

  // Anything that only resembles a receipt is application data too.
  const lookalike = createMemoryAgentRuntimeStore();
  await branchTurn(
    lookalike,
    'source',
    'first',
    searched({ ...receiptFor('first'), note: 'mine' }),
  );
  await expect(branch(lookalike, request('copy'))).rejects.toThrow(
    'containing runId at runId; declare it in applicationKeys',
  );
});

function call(callId: string, toolName: string, input: Record<string, string | number>) {
  return { type: 'tool-call', callId, toolName, input } as const;
}

function answer(callId: string, toolName: string, output: ToolOutput) {
  return { type: 'tool-result', callId, toolName, outcome: 'success', output } as const;
}

test('what the event search tools were asked and answered crosses as the record of the past it is', async () => {
  const store = createMemoryAgentRuntimeStore();
  const found = {
    results: [
      {
        conversationId: 'source',
        seq: 2,
        occurredAt: '2026-10-15T00:00:00.000Z',
        snippet: 'hi',
      },
    ],
  };
  const read = {
    conversationId: 'source',
    seq: 2,
    kind: 'runtime/transition',
    occurredAt: '2026-10-15T00:00:00.000Z',
    payload: { type: 'accept', input: { run: { id: 'first' }, messageId: 'input-first' } },
  };
  // What the model read about a payload artifact: its body never leaves the source.
  const receipt = {
    conversationId: 'source',
    invocationId: 'invocation',
    operationId: 'operation',
    runId: 'first',
    artifactId: 'artifact',
    sha256: 'a'.repeat(64),
    bytes: 20,
  };
  const ciphertext = 'c2VjcmV0LXByb3ZpZGVyLWJvZHk=';
  const body = {
    conversationId: 'source',
    seq: 3,
    kind: 'provider/payload',
    occurredAt: '2026-10-15T00:00:00.000Z',
    payload: { ...receipt, iv: 'aXZpdml2aXZpdml2', tag: 'dGFndGFndGFndGFn', ciphertext },
  };
  await branchTurn(store, 'source', 'first', [
    call('find', 'session_search', { query: 'hi', conversationId: 'source' }),
    answer('find', 'session_search', found),
    call('trace', 'session_trace', { limit: 2 }),
    answer('trace', 'session_trace', { events: [read, body], nextSeq: 4 }),
    call('read', 'session_event', { conversationId: 'source', seq: 3 }),
    answer('read', 'session_event', body),
    // A call the tool refused is in the history too, with the model's raw input.
    call('wrong', 'session_search', { query: 'x', conversationId: 'source', limit: 500 }),
    {
      type: 'tool-result',
      callId: 'wrong',
      toolName: 'session_search',
      outcome: 'error',
      output: 'Too big: expected number to be <=200',
    },
  ]);
  await branch(store, request('copy'));
  expect(await resultOf(store, 'copy', 'session_search')).toEqual(found);
  expect(await resultOf(store, 'copy', 'session_trace')).toEqual({
    events: [read, { ...body, payload: receipt }],
    nextSeq: 4,
  });
  expect(await resultOf(store, 'copy', 'session_event')).toEqual({
    ...body,
    payload: receipt,
  });
  const calls = (await store.loadSnapshot('copy')).messages
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === 'tool-call' ? [[part.toolName, part.input]] : []));
  expect(calls).toEqual([
    ['session_search', { query: 'hi', conversationId: 'source' }],
    ['session_trace', { limit: 2 }],
    ['session_event', { conversationId: 'source', seq: 3 }],
    ['session_search', { query: 'x', conversationId: 'source', limit: 500 }],
  ]);
  expect(
    JSON.stringify(await store.readEvents({ conversationId: 'copy', limit: 500 })),
  ).not.toContain(ciphertext);

  // A tool of the same name that answers in another shape is the application's.
  const other = createMemoryAgentRuntimeStore();
  await branchTurn(other, 'source', 'first', [
    call('read', 'session_event', { id: 7 }),
    answer('read', 'session_event', { runId: 'first', title: 'a calendar session' }),
  ]);
  await expect(branch(other, request('copy'))).rejects.toThrow('containing runId at runId');
});

test('a spill address the model read in an event stays an address in the source', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  try {
    const spills = createAgentSpillStore({
      host: sqlite.host,
      conversationId: 'source',
      runId: 'first',
    });
    const { reference } = await spills.write({
      data: new TextEncoder().encode('source-only bytes'),
      mediaType: 'text/plain',
      authorization: { operation: 'read', path: 'source-only' },
      toolCallId: 'read',
    });
    const event = {
      conversationId: 'source',
      seq: 2,
      kind: 'spill/created',
      occurredAt: '2026-10-15T00:00:00.000Z',
      payload: { reference, bytes: 17 },
    };
    await branchTurn(sqlite.store, 'source', 'first', [
      call('read', 'session_event', { conversationId: 'source', seq: 2 }),
      answer('read', 'session_event', event),
    ]);
    // The spill itself crosses by its own contract, under a fresh authorization
    // and a new address; the record of what the model read keeps the old one.
    await branch(sqlite.store, {
      ...request('copy'),
      artifactAuthorization: { operation: 'read', path: 'destination-only' },
    });
    expect(await resultOf(sqlite.store, 'copy', 'session_event')).toEqual(event);
    // The record names the source's spill; the destination cannot read it by that name.
    const copied = createAgentSpillStore({ host: sqlite.host, conversationId: 'copy' });
    await expect(copied.read({ reference, offset: 0, maxBytes: 100 })).rejects.toThrow();
    const source = await spills.read({ reference, offset: 0, maxBytes: 100 });
    expect(new TextDecoder().decode(source.data)).toBe('source-only bytes');
  } finally {
    await sqlite.close();
  }
});
