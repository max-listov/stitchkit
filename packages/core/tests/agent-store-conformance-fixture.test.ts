import { describe, expect, test } from 'bun:test';
import { type AgentRuntimeStore, createMemoryAgentRuntimeStore } from '../src/agent-runtime';
import { runAgentStoreConformance } from '../src/testing';

/**
 * A store whose runtime rows hang off an application-owned conversation row.
 *
 * This is the adapter class the kit exists to certify and could not run: every
 * mutation refuses until somebody has provisioned the parent, and before the
 * fixture lifecycle nobody could, because the kit chose its identities after
 * the store was built.
 */
function foreignKeyStore(parents: ReadonlySet<string>): AgentRuntimeStore {
  const inner = createMemoryAgentRuntimeStore();
  const guard = (conversationId: string): void => {
    if (parents.has(conversationId)) return;
    throw new Error(`foreign key violation: no conversation row for ${conversationId}`);
  };
  return {
    ...inner,
    acceptInputAndAssignRun: (input) => {
      guard(input.input.conversationId);
      return inner.acceptInputAndAssignRun(input);
    },
    acquireRun: (input) => {
      guard(input.conversationId);
      return inner.acquireRun(input);
    },
    checkpointRunAssistant: (input) => {
      guard(input.conversationId);
      return inner.checkpointRunAssistant(input);
    },
    requestRunInterrupt: (input) => {
      guard(input.conversationId);
      return inner.requestRunInterrupt(input);
    },
    recoverRun: (input) => {
      guard(input.conversationId);
      return inner.recoverRun(input);
    },
    commitRunTerminal: (input) => {
      guard(input.conversationId);
      return inner.commitRunTerminal(input);
    },
    replaceCompactedRange: (input) => {
      guard(input.conversationId);
      return inner.replaceCompactedRange(input);
    },
  };
}

describe('the conformance kit can be given a fixture', () => {
  test('a store that needs a parent row passes the whole kit', async () => {
    const parents = new Set<string>();
    let created = 0;
    let cleaned = 0;
    let announced: readonly string[] = [];
    await runAgentStoreConformance({
      createStore: (context) => {
        created += 1;
        announced = context.conversationIds;
        for (const id of context.conversationIds) parents.add(id);
        return foreignKeyStore(parents);
      },
      cleanup: (context) => {
        cleaned += 1;
        for (const id of context.conversationIds) parents.delete(id);
      },
    });
    expect(created).toBe(1);
    expect(cleaned).toBe(1);
    // Nothing left behind, and nothing preselected: the kit chose the ids and
    // said so, rather than the adapter having to guess a global fixture name.
    expect(parents.size).toBe(0);
    expect(announced.length).toBe(6);
    expect(new Set(announced).size).toBe(6);
    for (const id of announced) expect(id).toStartWith('conformance-');
  });

  test('the fixture is load-bearing — ignore the context and the kit fails', async () => {
    // The proof that the previous test proves something: the same kit, the same
    // store, the only difference being that nobody provisioned the parent.
    await expect(
      runAgentStoreConformance({
        createStore: () => foreignKeyStore(new Set<string>()),
      }),
    ).rejects.toThrow('foreign key violation');
  });

  test('cleanup runs after a failure, and the failure is what surfaces', async () => {
    const parents = new Set<string>();
    let cleaned = 0;
    await expect(
      runAgentStoreConformance({
        createStore: (context) => {
          for (const id of context.conversationIds) parents.add(id);
          const store = foreignKeyStore(parents);
          return {
            ...store,
            acquireRun: () => {
              throw new Error('adapter exploded mid-scenario');
            },
          };
        },
        cleanup: (context) => {
          cleaned += 1;
          for (const id of context.conversationIds) parents.delete(id);
        },
      }),
    ).rejects.toThrow('adapter exploded mid-scenario');
    // A kit that only tears down on success leaks a row per red run, which is
    // what makes a failing suite un-rerunnable.
    expect(cleaned).toBe(1);
    expect(parents.size).toBe(0);
  });

  test('a teardown failure never replaces the scenario failure', async () => {
    await expect(
      runAgentStoreConformance({
        createStore: () => {
          const store = createMemoryAgentRuntimeStore();
          return {
            ...store,
            acquireRun: () => {
              throw new Error('adapter exploded mid-scenario');
            },
          };
        },
        cleanup: () => {
          throw new Error('teardown exploded too');
        },
      }),
    ).rejects.toThrow('adapter exploded mid-scenario');
  });

  test('a teardown failure on a green scenario is reported', async () => {
    await expect(
      runAgentStoreConformance({
        createStore: () => createMemoryAgentRuntimeStore(),
        cleanup: () => {
          throw new Error('teardown exploded');
        },
      }),
    ).rejects.toThrow('teardown exploded');
  });

  test('a zero-argument factory still works, with no wrapper', async () => {
    // The shape every existing caller has. It must keep compiling and passing:
    // a lifecycle that forces every adapter to care about fixtures would be a
    // migration for people who have no fixtures.
    await runAgentStoreConformance({ createStore: () => createMemoryAgentRuntimeStore() });
  });
});
