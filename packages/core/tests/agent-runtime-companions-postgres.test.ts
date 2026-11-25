/**
 * The runtime's companions on the Postgres store: schedules, children,
 * spills and projections through the companion host, against a real
 * Postgres. Two store instances over one prefix stand in for two processes.
 *
 * Runs in the `test:postgres-stores` lane (`AGENT_STORE_DATABASE_URL`); the
 * SQLite case of the child limit runs everywhere.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createAgentChildManager } from '../src/agent-runtime/children';
import type { AgentCompanionHost } from '../src/agent-runtime/companion-host';
import { createPostgresAgentRuntimeStore } from '../src/agent-runtime/postgres';
import {
  createAgentProjectionStore,
  defineAgentProjection,
} from '../src/agent-runtime/projections';
import { AgentConversationPurgedError } from '../src/agent-runtime/purge';
import { createAgentScheduleService } from '../src/agent-runtime/schedules';
import { createAgentSpillStore } from '../src/agent-runtime/spill';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import type { AgentRuntimeStore } from '../src/agent-runtime/store';
import { expectStopKeepsFinishedResult } from './fixtures/child-stop-race';
import { scheduleClock } from './fixtures/schedule-clock';

const url = Bun.env.AGENT_STORE_DATABASE_URL;
if (url && !new URL(url).pathname.startsWith('/sk_lane_')) {
  throw new Error('The Postgres companion proof refuses a non-disposable database');
}
const sql = url ? new SQL(url, { max: 24 }) : undefined;

afterAll(async () => {
  await sql?.close();
});

/**
 * Two stores over one prefix: two processes sharing one database.
 *
 * `pauseAfter` holds a transaction for a moment after a statement that
 * contains the given text, so two processes are inside the same
 * read-then-write window at once — the interleaving a race needs, made
 * certain instead of left to timing.
 */
function twoProcesses(database: SQL, pauseAfter?: string) {
  const prefix = `sk_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const open = () =>
    createPostgresAgentRuntimeStore<SQL>({
      transaction: (work) => database.begin((tx) => work(tx)),
      query: async (tx, text, parameters) => {
        const rows = await tx.unsafe(text, [...parameters]);
        if (pauseAfter !== undefined && text.includes(pauseAfter)) await Bun.sleep(50);
        return rows;
      },
      prefix,
    });
  return { prefix, first: open(), second: open() };
}

function childManager(
  owner: { store: AgentRuntimeStore; host: AgentCompanionHost },
  maxActiveChildren: number,
) {
  return createAgentChildManager({
    store: owner.store,
    host: owner.host,
    maxActiveChildren,
    remainingBudget: () => ({ tokens: 1_000 }),
    spawn: () => ({ result: new Promise(() => undefined), stopPolicy: () => undefined }),
  });
}

async function spawnBoth(managers: ReturnType<typeof childManager>[]) {
  return Promise.allSettled(
    managers.map((manager, index) =>
      manager.spawnChild({
        parentConversationId: 'parent',
        childConversationId: `child-${index}`,
        childInput: {},
        budget: { tokens: 10 },
      }),
    ),
  );
}

test('the child limit holds between two managers over one SQLite store', async () => {
  const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  try {
    const managers = [childManager(owner, 1), childManager(owner, 1)];
    const outcomes = await spawnBoth(managers);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(refused?.status === 'rejected' && String(refused.reason)).toContain(
      'the limit is 1',
    );
    expect(await managers[0]?.listChildren('parent')).toHaveLength(1);
  } finally {
    await owner.close();
  }
});

describe.skipIf(!sql)('companions on the Postgres store', () => {
  const database = sql as SQL;

  test('two processes ticking one due schedule dispatch it exactly once', async () => {
    const { first, second } = twoProcesses(database, 'SELECT occurrence, next_at, attempts');
    const clock = scheduleClock();
    const dispatched: string[] = [];
    const service = (owner: typeof first) =>
      createAgentScheduleService({
        host: owner.host,
        maxActivePerConversation: 10,
        minIntervalMs: 1,
        ...clock,
        dispatch: (request) => {
          dispatched.push(request.idempotencyKey);
        },
      });
    const a = service(first);
    const b = service(second);
    try {
      await a.scheduleInput({ conversationId: 'due', input: {}, afterMs: 1 });
      clock.advance(5);
      await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
      expect(dispatched).toHaveLength(1);
      expect((await b.listSchedules('due'))[0]?.state).toBe('completed');
    } finally {
      a.close();
      b.close();
    }
  }, 30_000);

  test('the per-conversation schedule limit holds between two processes', async () => {
    const { first, second } = twoProcesses(database);
    const services = [first, second].map((owner) =>
      createAgentScheduleService({
        host: owner.host,
        maxActivePerConversation: 1,
        minIntervalMs: 1,
        dispatch: () => undefined,
      }),
    );
    try {
      const outcomes = await Promise.allSettled(
        services.flatMap((service) =>
          [0, 1].map(() =>
            service.scheduleInput({ conversationId: 'limited', input: {}, afterMs: 60_000 }),
          ),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(await services[0]?.listSchedules('limited')).toHaveLength(1);
    } finally {
      for (const service of services) service.close();
    }
  }, 30_000);

  test('the child limit holds between two processes', async () => {
    const { first, second } = twoProcesses(database);
    const managers = [childManager(first, 1), childManager(second, 1)];
    const outcomes = await spawnBoth(managers);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await managers[1]?.listChildren('parent')).toHaveLength(1);
  }, 30_000);

  test('two processes reporting child usage at once both count', async () => {
    const { first, second } = twoProcesses(database);
    const managers = [childManager(first, 4), childManager(second, 4)];
    await managers[0]?.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'counted',
      childInput: {},
      budget: { tokens: 1_000 },
    });
    await Promise.all(
      managers.flatMap((manager) =>
        [0, 1, 2].map(() =>
          manager.recordStepUsage({
            childConversationId: 'counted',
            usage: {
              inputTokens: { value: 5, provenance: 'provider-reported' },
              outputTokens: { value: 5, provenance: 'provider-reported' },
            },
            elapsedMs: 1,
          }),
        ),
      ),
    );
    const [record] = (await managers[1]?.listChildren('parent')) ?? [];
    expect(record?.usage).toMatchObject({ tokens: 60, milliseconds: 6 });
  }, 30_000);

  for (const mode of ['stopChildren', 'interruptChild'] as const) {
    test(`${mode}: a child its host finishes while being stopped keeps finished and its result`, async () => {
      const { first } = twoProcesses(database);
      await expectStopKeepsFinishedResult(first, mode);
    }, 30_000);
  }

  /**
   * One process records the child's settlement while another, which has no
   * handle for it, records it lost. Both are held inside the read-then-write
   * window at once; whichever commits first, the row and the parent's journal
   * end exactly once.
   */
  test('a settlement and a stop from two processes end the child once', async () => {
    const { first, second } = twoProcesses(database, 'SELECT state FROM');
    const result = Promise.withResolvers<{ resultReference?: string }>();
    const owner = createAgentChildManager({
      store: first.store,
      host: first.host,
      maxActiveChildren: 1,
      remainingBudget: () => ({ tokens: 1_000 }),
      spawn: () => ({ result: result.promise, stopPolicy: () => undefined }),
    });
    const other = childManager(second, 1);
    await owner.spawnChild({
      parentConversationId: 'raced',
      childConversationId: 'raced-child',
      childInput: {},
      budget: { tokens: 10 },
    });
    result.resolve({ resultReference: 'final-answer' });
    await Promise.all([owner.waitChild('raced-child'), other.stopChildren('raced')]);
    const [row] = await other.listChildren('raced');
    const terminal = (
      await first.store.readEvents({ conversationId: 'raced', limit: 50 })
    ).items
      .filter((event) => event.kind === 'child/state')
      .map((event) => Reflect.get(Object(event.payload), 'state'))
      .filter((state) => state !== 'running');
    expect(terminal).toEqual([row?.state]);
    expect(row?.state).toBeOneOf(['finished', 'lost']);
    if (row?.state === 'finished') expect(row.resultReference).toBe('final-answer');
  }, 30_000);

  test('a spill is written, read and expired with its events in the same transactions', async () => {
    const { first } = twoProcesses(database);
    let clock = Date.parse('2026-11-24T00:00:00.000Z');
    const spills = createAgentSpillStore({
      host: first.host,
      conversationId: 'spilled',
      retentionMs: 1_000,
      now: () => new Date(clock),
    });
    const bytes = new TextEncoder().encode('first line\nneedle line\n');
    const { reference } = await spills.write({ mediaType: 'text/plain', data: bytes });
    const read = await spills.read({ reference, offset: 0, maxBytes: 100 });
    expect(Buffer.from(read.data)).toEqual(Buffer.from(bytes));
    expect(await spills.search({ reference, query: 'needle', maxMatches: 5 })).toEqual([
      { line: 2, text: 'needle line' },
    ]);
    clock += 2_000;
    expect(await spills.cleanup()).toEqual({ deleted: 1, bytes: bytes.byteLength });
    const kinds = (
      await first.store.readEvents({ conversationId: 'spilled', limit: 10 })
    ).items.map((event) => event.kind);
    expect(kinds).toEqual(['spill/created', 'spill/deleted']);
  });

  test('a projection advances, never moves back, and an archive carries spills and projections', async () => {
    const { first } = twoProcesses(database);
    const counter = defineAgentProjection({
      name: 'counter',
      version: 1,
      schema: (await import('zod')).z.object({ count: (await import('zod')).z.int() }),
      initial: () => ({ count: 0 }),
      fold: (state) => ({ count: state.count + 1 }),
    });
    const projections = createAgentProjectionStore({ store: first.store, host: first.host });
    for (let index = 0; index < 3; index += 1) {
      await first.store.appendEvent({
        conversationId: 'folded',
        kind: 'state/set',
        payload: {},
      });
    }
    const results = await Promise.all([
      projections.advance('folded', counter),
      projections.advance('folded', counter),
    ]);
    expect(results.map((result) => result.uptoSeq)).toEqual([3, 3]);
    expect((await projections.load('folded', counter))?.value).toEqual({ count: 3 });
    await createAgentSpillStore({ host: first.host, conversationId: 'folded' }).write({
      mediaType: 'application/octet-stream',
      data: new Uint8Array([0, 1, 2, 255]),
    });
    const archive = await first.store.exportConversation('folded');
    const { second: target } = twoProcesses(database);
    await target.store.importConversation(archive);
    expect(Buffer.from(await target.store.exportConversation('folded'))).toEqual(
      Buffer.from(archive),
    );
    const restored = createAgentProjectionStore({ store: target.store, host: target.host });
    expect((await restored.load('folded', counter))?.value).toEqual({ count: 3 });
  });

  test('a purge removes every companion row, and a companion write to it is refused', async () => {
    const { first } = twoProcesses(database);
    const conversationId = 'purged';
    await createAgentSpillStore({ host: first.host, conversationId }).write({
      mediaType: 'text/plain',
      data: new TextEncoder().encode('x'),
    });
    const schedules = createAgentScheduleService({
      host: first.host,
      maxActivePerConversation: 5,
      minIntervalMs: 1,
      dispatch: () => undefined,
    });
    await schedules.scheduleInput({ conversationId, input: {}, afterMs: 60_000 });
    await childManager(first, 5).spawnChild({
      parentConversationId: conversationId,
      childConversationId: 'purged-child',
      childInput: {},
      budget: { tokens: 10 },
    });
    expect((await first.store.purgeConversation?.({ conversationId }))?.outcome).toBe(
      'purged',
    );
    const t = first.host.tables;
    const leftovers = await first.host.read(async (session) => ({
      spills: await session.all(`SELECT 1 FROM ${t.spills} WHERE conversation_id = ?`, [
        conversationId,
      ]),
      schedules: await session.all(`SELECT 1 FROM ${t.schedules} WHERE conversation_id = ?`, [
        conversationId,
      ]),
      children: await session.all(
        `SELECT 1 FROM ${t.children} WHERE parent_conversation_id = ?`,
        [conversationId],
      ),
      events: await session.all(`SELECT 1 FROM ${t.events} WHERE conversation_id = ?`, [
        conversationId,
      ]),
    }));
    expect(leftovers).toEqual({ spills: [], schedules: [], children: [], events: [] });
    await expect(
      schedules.scheduleInput({ conversationId, input: {}, afterMs: 60_000 }),
    ).rejects.toBeInstanceOf(AgentConversationPurgedError);
    await expect(
      childManager(first, 5).spawnChild({
        parentConversationId: conversationId,
        childConversationId: 'too-late',
        childInput: {},
        budget: { tokens: 10 },
      }),
    ).rejects.toBeInstanceOf(AgentConversationPurgedError);
    schedules.close();
  });

  test('spill authorization rejects invalid payloads on write, read, export and import, and round-trips valid authorization', async () => {
    const { first } = twoProcesses(database);
    const { second: target } = twoProcesses(database);
    const spills = createAgentSpillStore({
      host: first.host,
      conversationId: 'pg-auth',
    });
    const invalidCases = [
      ['false', /expected object, received boolean/],
      ['{"operation":"bogus"}', /invalid_union|operation/],
    ] as const;
    for (const [bad, pattern] of invalidCases) {
      await expect(
        spills.write({
          mediaType: 'text/plain',
          data: new TextEncoder().encode('rejected'),
          authorization: JSON.parse(bad),
        }),
      ).rejects.toThrow(pattern);
    }
    const validAuth = { operation: 'read', path: 'pg-notes.md' } as const;
    const { reference } = await spills.write({
      mediaType: 'text/plain',
      data: new TextEncoder().encode('pg-secret'),
      authorization: validAuth,
    });
    expect(await spills.authorization?.(reference)).toEqual(validAuth);
    expect((await spills.read({ reference, offset: 0, maxBytes: 64 })).authorization).toEqual(
      validAuth,
    );

    const exported = await first.store.exportConversation('pg-auth');
    await target.store.importConversation(exported);
    const restored = createAgentSpillStore({ host: target.host, conversationId: 'pg-auth' });
    expect(await restored.authorization?.(reference)).toEqual(validAuth);
    expect(
      (await restored.read({ reference, offset: 0, maxBytes: 64 })).authorization,
    ).toEqual(validAuth);

    for (const [bad, pattern] of invalidCases) {
      const { first: freshTarget } = twoProcesses(database);
      const tampered = JSON.parse(new TextDecoder().decode(exported));
      tampered.spills[0].authorization = JSON.parse(bad);
      await expect(
        freshTarget.store.importConversation(
          new TextEncoder().encode(JSON.stringify(tampered)),
        ),
      ).rejects.toThrow(pattern);
    }

    await first.host.transaction('pg-auth', async (scope) => {
      await scope.run(
        `UPDATE ${first.host.tables.spills} SET authorization_payload = ? WHERE reference_id = ?`,
        ['false', reference],
      );
    });
    await expect(spills.authorization?.(reference)).rejects.toThrow(
      /expected object, received boolean/,
    );
    await expect(spills.read({ reference, offset: 0, maxBytes: 64 })).rejects.toThrow(
      /expected object, received boolean/,
    );
    await expect(first.store.exportConversation('pg-auth')).rejects.toThrow(
      /expected object, received boolean/,
    );
  });
});
