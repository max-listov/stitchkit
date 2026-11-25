/**
 * A child stop that meets the child's own settlement, and a child host that
 * never answers a stop. The settlement and the stop's record race for one
 * row; the row and both journals end exactly once. A stop is asked of a host
 * within a bound on every path that asks it, and a stop that was not
 * confirmed is recorded as `lost`.
 *
 * The Postgres side of the race runs in the `test:postgres-stores` lane
 * (`agent-runtime-companions-postgres.test.ts`).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import {
  type AgentChildManager,
  type AgentCompanionHost,
  type AgentRuntimeStore,
  createAgentChildManager,
  createAgentChildTools,
} from '../src/entrypoints/agent-runtime';
import { createBunSqliteAgentRuntimeStore } from '../src/entrypoints/agent-runtime/sqlite/bun';
import { expectStopKeepsFinishedResult } from './fixtures/child-stop-race';
import { issuedRunContext } from './support/issued-run-context';

/** The stop bound, made short: every `setTimeout(…, 10_000)` fires after 10 ms. */
function fastStopBound() {
  const realSetTimeout = globalThis.setTimeout;
  const fast = new Proxy(realSetTimeout, {
    apply: (target, thisArg, args: unknown[]) =>
      Reflect.apply(target, thisArg, [
        args[0],
        args[1] === 10_000 ? 10 : args[1],
        ...args.slice(2),
      ]),
  });
  return spyOn(globalThis, 'setTimeout').mockImplementation(fast);
}

describe('a child stop that meets its settlement', () => {
  for (const mode of ['stopChildren', 'interruptChild'] as const) {
    test(`${mode}: a child its host finishes while being stopped keeps finished and its result`, async () => {
      const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
      try {
        await expectStopKeepsFinishedResult(owner, mode);
      } finally {
        await owner.close();
      }
    });
  }
});

test('a result that arrived before the stop returned wins even when its record is slower', async () => {
  const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  let transactions = 0;
  // The third write transaction is the settlement's (after the spawn and
  // `running`): held back, so the stop's record would otherwise land first.
  const slowSettlement: AgentCompanionHost = {
    dialect: owner.host.dialect,
    tables: owner.host.tables,
    read: (work) => owner.host.read(work),
    transaction: async (conversationId, work) => {
      transactions += 1;
      if (transactions === 3) await Bun.sleep(50);
      return owner.host.transaction(conversationId, work);
    },
  };
  try {
    await expectStopKeepsFinishedResult(
      { store: owner.store, host: slowSettlement },
      'interruptChild',
    );
  } finally {
    await owner.close();
  }
});

test("a child's last step reported after it finished is counted and keeps it finished", async () => {
  const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  const result = Promise.withResolvers<{ resultReference?: string }>();
  try {
    const manager = createAgentChildManager({
      remainingBudget: () => ({}),
      maxActiveChildren: 8,
      store: owner.store,
      host: owner.host,
      spawn: () => ({ result: result.promise, stopPolicy: () => undefined }),
    });
    await manager.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: {},
      budget: { tokens: 100 },
    });
    result.resolve({ resultReference: 'final-answer' });
    await manager.waitChild('child');
    await manager.recordStepUsage({
      childConversationId: 'child',
      usage: {
        inputTokens: { value: 3, provenance: 'provider-reported' },
        outputTokens: { value: 4, provenance: 'provider-reported' },
      },
      elapsedMs: 1,
    });
    const [row] = await manager.listChildren('parent');
    expect([row?.state, row?.usage.tokens]).toEqual(['finished', 7]);
    for (const conversationId of ['parent', 'child']) {
      const states = (await owner.store.readEvents({ conversationId, limit: 50 })).items
        .filter((event) => event.kind === 'child/state')
        .map((event) => Reflect.get(Object(event.payload), 'state'));
      expect(states).toEqual(['running', 'finished', 'finished']);
    }
  } finally {
    await owner.close();
  }
});

describe('a child host that never answers a stop', () => {
  test('interruptChild ends at the bound and records lost', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const timer = fastStopBound();
    try {
      const manager = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: () => ({
          result: new Promise(() => undefined),
          stopPolicy: () => new Promise(() => undefined),
        }),
      });
      await manager.spawnChild({
        parentConversationId: 'parent',
        childConversationId: 'child',
        childInput: {},
        budget: { tokens: 10 },
      });
      const outcome = await Promise.race([
        manager.interruptChild('parent', 'child').then(() => 'ended' as const),
        Bun.sleep(2_000).then(() => 'hung' as const),
      ]);
      expect(outcome).toBe('ended');
      expect((await manager.listChildren('parent')).map((row) => row.state)).toEqual(['lost']);
      const last = (
        await owner.store.readEvents({ conversationId: 'parent', limit: 20 })
      ).items
        .filter((event) => event.kind === 'child/state')
        .at(-1);
      expect(last?.payload).toMatchObject({ state: 'lost', policyName: 'parent-interrupt' });
      // The child is lost: waiting for it does not wait for a host that never answers.
      expect(
        await Promise.race([
          manager.waitChild('child').then(() => 'settled' as const),
          Bun.sleep(500).then(() => 'hung' as const),
        ]),
      ).toBe('settled');
    } finally {
      timer.mockRestore();
      await owner.close();
    }
  });

  test('interruptChild records lost when stopPolicy throws synchronously', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    try {
      const manager = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: () => ({
          result: new Promise(() => undefined),
          stopPolicy: () => {
            throw new Error('host refused the stop');
          },
        }),
      });
      await manager.spawnChild({
        parentConversationId: 'parent',
        childConversationId: 'child',
        childInput: {},
        budget: { tokens: 10 },
      });
      await manager.interruptChild('parent', 'child');
      expect((await manager.listChildren('parent')).map((row) => row.state)).toEqual(['lost']);
    } finally {
      await owner.close();
    }
  });

  /**
   * The spawn is recorded, then the `running` record fails: the manager stops
   * the child again, and a host that never answers must not hold the spawn.
   */
  test('a spawn whose record fails ends at the bound, records lost and reports both failures', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const timer = fastStopBound();
    let transactions = 0;
    const failingSecondWrite: AgentCompanionHost = {
      dialect: owner.host.dialect,
      tables: owner.host.tables,
      read: (work) => owner.host.read(work),
      transaction: (conversationId, work) => {
        transactions += 1;
        if (transactions === 2) return Promise.reject(new Error('disk full'));
        return owner.host.transaction(conversationId, work);
      },
    };
    try {
      const manager = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: failingSecondWrite,
        spawn: () => ({
          result: new Promise(() => undefined),
          stopPolicy: () => new Promise(() => undefined),
        }),
      });
      const outcome = await Promise.race([
        manager
          .spawnChild({
            parentConversationId: 'parent',
            childConversationId: 'child',
            childInput: {},
            budget: { tokens: 10 },
          })
          .then(
            () => 'spawned' as const,
            (error: unknown) => error,
          ),
        Bun.sleep(2_000).then(() => 'hung' as const),
      ]);
      expect(outcome).toBeInstanceOf(AggregateError);
      const failures =
        outcome instanceof AggregateError ? outcome.errors.map((error) => String(error)) : [];
      expect(failures[0]).toContain('disk full');
      expect(failures[1]).toContain('did not answer the stop');
      expect((await manager.listChildren('parent')).map((row) => row.state)).toEqual(['lost']);
    } finally {
      timer.mockRestore();
      await owner.close();
    }
  });

  test('a spawn whose first record fails ends at the bound with no row', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const timer = fastStopBound();
    const failingWrite: AgentCompanionHost = {
      dialect: owner.host.dialect,
      tables: owner.host.tables,
      read: (work) => owner.host.read(work),
      transaction: () => Promise.reject(new Error('disk full')),
    };
    try {
      const manager = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: failingWrite,
        spawn: () => ({
          result: new Promise(() => undefined),
          stopPolicy: () => new Promise(() => undefined),
        }),
      });
      const outcome = await Promise.race([
        manager
          .spawnChild({
            parentConversationId: 'parent',
            childConversationId: 'child',
            childInput: {},
            budget: { tokens: 10 },
          })
          .then(
            () => 'spawned' as const,
            (error: unknown) => error,
          ),
        Bun.sleep(2_000).then(() => 'hung' as const),
      ]);
      expect(outcome).toBeInstanceOf(AggregateError);
      expect(await manager.listChildren('parent')).toEqual([]);
    } finally {
      timer.mockRestore();
      await owner.close();
    }
  });
});

describe('a parent stopped while a child is being spawned', () => {
  /** A manager whose host spawns children that run until stopped, counting the stops. */
  function spawning(host: AgentCompanionHost, store: AgentRuntimeStore, gate?: Promise<void>) {
    const stops: string[] = [];
    const manager = createAgentChildManager({
      remainingBudget: () => ({}),
      maxActiveChildren: 8,
      store,
      host,
      spawn: async ({ childConversationId }) => {
        await gate;
        return {
          result: new Promise(() => undefined),
          stopPolicy: (policy) => {
            stops.push(`${childConversationId}:${policy}`);
          },
        };
      },
    });
    return { manager, stops };
  }

  test('a stop between the record and the handle stops the child and records stopped', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    let transactions = 0;
    const recorded = Promise.withResolvers<void>();
    // The second write transaction moves the new row to `running`: held back,
    // so the stop lands after the row exists and before the spawn returns.
    const slowRunning: AgentCompanionHost = {
      dialect: owner.host.dialect,
      tables: owner.host.tables,
      read: (work) => owner.host.read(work),
      transaction: async (conversationId, work) => {
        transactions += 1;
        if (transactions === 2) {
          recorded.resolve();
          await Bun.sleep(50);
        }
        return owner.host.transaction(conversationId, work);
      },
    };
    try {
      const { manager, stops } = spawning(slowRunning, owner.store);
      const spawned = manager.spawnChild({
        parentConversationId: 'p',
        childConversationId: 'c',
        childInput: {},
        budget: { tokens: 10 },
      });
      await recorded.promise;
      await manager.stopChildren('p');
      expect((await spawned).state).toBe('stopped');
      expect(stops).toEqual(['c:parent-stopped']);
      expect((await manager.listChildren('p')).map((row) => row.state)).toEqual(['stopped']);
      const states = (await owner.store.readEvents({ conversationId: 'p', limit: 50 })).items
        .filter((event) => event.kind === 'child/state')
        .map((event) => Reflect.get(Object(event.payload), 'state'));
      expect(states).toEqual(['running', 'stopped']);
    } finally {
      await owner.close();
    }
  });

  test('a stop while the host is still starting the child stops it once it exists', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const started = Promise.withResolvers<void>();
    try {
      const { manager, stops } = spawning(owner.host, owner.store, started.promise);
      const spawned = manager.spawnChild({
        parentConversationId: 'p',
        childConversationId: 'c',
        childInput: {},
        budget: { tokens: 10 },
      });
      await Bun.sleep(5);
      const stopping = manager.stopChildren('p');
      started.resolve();
      await stopping;
      expect(stops).toEqual(['c:parent-stopped']);
      expect((await spawned).state).toBe('stopped');
      expect((await manager.listChildren('p')).map((row) => row.state)).toEqual(['stopped']);
    } finally {
      await owner.close();
    }
  });
});

describe('a child its budget stops', () => {
  const step = (tokens: number) => ({
    childConversationId: 'c1',
    usage: {
      inputTokens: { value: tokens, provenance: 'provider-reported' as const },
      outputTokens: { value: 0, provenance: 'provider-reported' as const },
    },
    elapsedMs: 1,
  });

  async function budgetStop(report: (manager: AgentChildManager) => Promise<unknown>) {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const stops: string[] = [];
    try {
      const manager = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 1,
        store: owner.store,
        host: owner.host,
        spawn: () => ({
          result: new Promise(() => undefined),
          stopPolicy: (policy) => {
            stops.push(policy);
          },
        }),
      });
      await manager.spawnChild({
        parentConversationId: 'p',
        childConversationId: 'c1',
        childInput: {},
        budget: { tokens: 10 },
      });
      await report(manager);
      expect(stops).toEqual(['child-budget']);
      expect((await manager.listChildren('p')).map((row) => row.state)).toEqual(['stopped']);
      // The stopped child no longer holds the parent's one place.
      await manager.spawnChild({
        parentConversationId: 'p',
        childConversationId: 'c2',
        childInput: {},
        budget: { tokens: 10 },
      });
      const stopped = (await owner.store.readEvents({ conversationId: 'c1', limit: 50 })).items
        .filter((event) => event.kind === 'child/state')
        .map((event) => Reflect.get(Object(event.payload), 'state'));
      expect(stopped.at(-1)).toBe('stopped');
    } finally {
      await owner.close();
    }
  }

  test('a confirmed stop decided before the usage record moves the row to stopped', async () => {
    await budgetStop(async (manager) => {
      expect(await manager.recordStepUsage(step(20))).toMatchObject({
        stop: true,
        enforced: true,
      });
    });
  });

  test('a confirmed stop decided inside the usage record moves the row to stopped', async () => {
    await budgetStop(async (manager) => {
      // Both read the total under the budget; the second record takes it over.
      const outcomes = await Promise.all([
        manager.recordStepUsage(step(6)),
        manager.recordStepUsage(step(6)),
      ]);
      expect(outcomes.map((outcome) => [outcome.stop, outcome.enforced])).toEqual([
        [false, false],
        [true, true],
      ]);
    });
  });
});

describe('round 6: every window of a spawn and every wait on a stopped child', () => {
  test('a stop before the spawn reads its budget or history refuses the spawn and starts no child', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<{ tokens: number }>();
    let spawns = 0;
    try {
      const manager = createAgentChildManager({
        // The application's callback is slow: the parent is stopped meanwhile.
        remainingBudget: () => {
          asked.resolve();
          return answer.promise;
        },
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: () => {
          spawns += 1;
          return { result: new Promise(() => undefined), stopPolicy: () => undefined };
        },
      });
      const spawned = manager
        .spawnChild({
          parentConversationId: 'p',
          childConversationId: 'c',
          childInput: {},
          budget: { tokens: 10 },
        })
        .then(
          (child) => child.state,
          (error: unknown) => String(error),
        );
      await asked.promise;
      const stopping = manager.stopChildren('p');
      answer.resolve({ tokens: 100 });
      await stopping;
      expect(await spawned).toContain('was stopped before child c started');
      expect(spawns).toBe(0);
      expect(await manager.listChildren('p')).toEqual([]);
    } finally {
      await owner.close();
    }
  });

  for (const [label, stop] of [
    ['interruptChild', (manager: AgentChildManager) => manager.interruptChild('p', 'c')],
    ['stopChildren', (manager: AgentChildManager) => manager.stopChildren('p')],
    [
      'a budget stop',
      (manager: AgentChildManager) =>
        manager.recordStepUsage({
          childConversationId: 'c',
          usage: {
            inputTokens: { value: 20, provenance: 'provider-reported' },
            outputTokens: { value: 0, provenance: 'provider-reported' },
          },
          elapsedMs: 1,
        }),
    ],
  ] as const) {
    test(`waitChild started before ${label} ends when the row does, not when the host reports`, async () => {
      const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
      try {
        // The host confirms the stop and never settles the child's result.
        const manager = createAgentChildManager({
          remainingBudget: () => ({}),
          maxActiveChildren: 8,
          store: owner.store,
          host: owner.host,
          spawn: () => ({ result: new Promise(() => undefined), stopPolicy: () => undefined }),
        });
        await manager.spawnChild({
          parentConversationId: 'p',
          childConversationId: 'c',
          childInput: {},
          budget: { tokens: 10 },
        });
        const waited = manager.waitChild('c').then(() => 'ended');
        await stop(manager);
        expect(
          await Promise.race([waited, Bun.sleep(1_000).then(() => 'still waiting')]),
        ).toBe('ended');
        expect((await manager.listChildren('p')).map((row) => row.state)).toEqual(['stopped']);
      } finally {
        await owner.close();
      }
    });
  }

  test('the subagent tool ends with lost when the child host cannot be reached', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const spawned = Promise.withResolvers<void>();
    try {
      const manager = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: () => {
          spawned.resolve();
          return {
            result: new Promise(() => undefined),
            stopPolicy: () => undefined,
            reachable: () => false,
          };
        },
      });
      const [subagent] = createAgentChildTools({ manager, run: issuedRunContext('p') });
      if (!subagent) throw new Error('expected the subagent tool');
      const answered = Promise.resolve(
        subagent.handler({ input: { childInput: {}, budget: { tokens: 10 } } }),
      );
      await spawned.promise;
      // The spawn records the child before the tool waits on it.
      await Bun.sleep(20);
      await manager.stopChildren('p');
      expect(
        await Promise.race([answered, Bun.sleep(1_000).then(() => 'still waiting')]),
      ).toMatchObject({ state: 'lost' });
    } finally {
      await owner.close();
    }
  });

  test('the subagent tool of a run already stopped starts no child', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    let spawns = 0;
    try {
      const manager = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: () => {
          spawns += 1;
          return { result: new Promise(() => undefined), stopPolicy: () => undefined };
        },
      });
      const controller = new AbortController();
      controller.abort(new Error('the run was interrupted'));
      const run = issuedRunContext('p', controller.signal);
      const [subagent] = createAgentChildTools({ manager, run });
      if (!subagent) throw new Error('expected the subagent tool');
      const answered = Promise.resolve(
        subagent.handler({ input: { childInput: {}, budget: { tokens: 10 } } }),
      ).then(
        () => 'answered',
        (error: unknown) => String(error),
      );
      expect(
        await Promise.race([answered, Bun.sleep(1_000).then(() => 'still waiting')]),
      ).toContain('the run was interrupted');
      expect(spawns).toBe(0);
    } finally {
      await owner.close();
    }
  });
});

describe('round 7: one stop per child', () => {
  /** A host whose first stop confirms slowly and every later one fails at once. */
  function slowFirstStop() {
    const policies: string[] = [];
    return {
      policies,
      handle: () => ({
        result: new Promise<{ resultReference?: string }>(() => undefined),
        stopPolicy: async (policy: string) => {
          policies.push(policy);
          if (policies.length > 1) throw new Error('already stopping');
          await Bun.sleep(150);
        },
      }),
    };
  }

  for (const readDelayMs of [100, 250])
    test(`a spawn that ends while stopChildren reads the rows is stopped once and recorded stopped (read answers after ${readDelayMs} ms)`, async () => {
      const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
      const host = slowFirstStop();
      let transactions = 0;
      let holdNextRead = false;
      const recorded = Promise.withResolvers<void>();
      // The second write moves the new row to `running`, held back so the stop
      // reads the row first; that read answers late, after the spawn has stopped
      // the child itself and left `spawning`.
      const slow: AgentCompanionHost = {
        dialect: owner.host.dialect,
        tables: owner.host.tables,
        read: async (work) => {
          const hold = holdNextRead;
          holdNextRead = false;
          const rows = await owner.host.read(work);
          if (hold) await Bun.sleep(readDelayMs);
          return rows;
        },
        transaction: async (conversationId, work) => {
          transactions += 1;
          if (transactions === 2) {
            recorded.resolve();
            await Bun.sleep(50);
          }
          return owner.host.transaction(conversationId, work);
        },
      };
      try {
        const manager = createAgentChildManager({
          remainingBudget: () => ({}),
          maxActiveChildren: 8,
          store: owner.store,
          host: slow,
          spawn: host.handle,
        });
        const spawned = manager.spawnChild({
          parentConversationId: 'p',
          childConversationId: 'c',
          childInput: {},
          budget: { tokens: 10 },
        });
        await recorded.promise;
        holdNextRead = true;
        await manager.stopChildren('p');
        await spawned;
        expect(host.policies).toEqual(['parent-stopped']);
        expect((await manager.listChildren('p')).map((row) => row.state)).toEqual(['stopped']);
      } finally {
        await owner.close();
      }
    });

  test('an interrupt and a cascade that meet on one child ask its host once', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const host = slowFirstStop();
    try {
      const manager = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: host.handle,
      });
      await manager.spawnChild({
        parentConversationId: 'p',
        childConversationId: 'c',
        childInput: {},
        budget: { tokens: 10 },
      });
      await Promise.all([manager.interruptChild('p', 'c'), manager.stopChildren('p')]);
      expect(host.policies).toHaveLength(1);
      expect((await manager.listChildren('p')).map((row) => row.state)).toEqual(['stopped']);
    } finally {
      await owner.close();
    }
  });
});
