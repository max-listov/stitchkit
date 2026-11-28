import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';
import {
  createAgentHarnessControlServer,
  createHeadlessAgentHarness,
} from '../src/entrypoints/agent-runtime/harness';
import { createScriptedModelDriver } from '../src/entrypoints/agent-runtime/testing';

function fixtureHarness() {
  return createHeadlessAgentHarness({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: createMemoryAgentRuntimeStore(),
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'fixture',
          modelId: 'm',
          contextWindow: 8_000,
          capabilities: [],
        },
        driver: createScriptedModelDriver({ provider: 'fixture', modelId: 'm', steps: [] }),
      }),
    },
    resources: { load: () => ({ resources: [], diagnostics: [] }) },
    promptBudget: ({ contextWindow }) => ({
      contextWindow,
      reservedOutput: 100,
      toolSchemas: { value: 0, provenance: 'measured' },
      attachments: { value: 0, provenance: 'measured' },
      providerOverhead: { provenance: 'unavailable' },
    }),
    tools: () => ({}),
  });
}

test('a control submit whose run result rejects leaves no unhandled rejection behind', async () => {
  const harness = fixtureHarness();
  const rejecting = new Proxy(harness, {
    get(target, property, receiver) {
      if (property !== 'submit') return Reflect.get(target, property, receiver);
      return () => ({
        admission: Promise.resolve({ runId: 'run-1' }),
        result: Promise.reject(new Error('the run failed after admission')),
      });
    },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const server = createAgentHarnessControlServer(rejecting);
    const connection = server.connect({
      id: 'c',
      deliver: () => undefined,
      onOverflow: () => undefined,
    });
    await connection.request({
      schemaVersion: 1,
      requestId: 'attach',
      operation: 'attach',
      conversationId: 'one',
      access: 'control',
    });
    expect(
      await connection.request({
        schemaVersion: 1,
        requestId: 'submit',
        operation: 'submit',
        conversationId: 'one',
        idempotencyKey: 'k',
        context: {},
        parts: [{ type: 'text', text: 'run' }],
      }),
    ).toMatchObject({ outcome: 'ok', runId: 'run-1' });
    await Bun.sleep(20);
    expect(unhandled).toEqual([]);
    connection.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a rejected control request answers with a safe code and hands its cause to onError', async () => {
  const cause = new Error('the store is unreachable');
  const failing = new Proxy(fixtureHarness(), {
    get(target, property, receiver) {
      if (property !== 'snapshot') return Reflect.get(target, property, receiver);
      return () => Promise.reject(cause);
    },
  });
  const observed: unknown[] = [];
  const attach = async (onError?: (error: unknown) => void) => {
    const server = createAgentHarnessControlServer(failing, onError ? { onError } : {});
    const connection = server.connect({
      id: 'c',
      deliver: () => undefined,
      onOverflow: () => undefined,
    });
    try {
      return await connection.request({
        schemaVersion: 1,
        requestId: 'attach',
        operation: 'attach',
        conversationId: 'one',
        access: 'observe',
      });
    } finally {
      connection.close();
      server.close();
    }
  };
  const response = await attach((error) => observed.push(error));
  expect(response).toMatchObject({ outcome: 'error', error: { code: 'REQUEST_REJECTED' } });
  expect(JSON.stringify(response)).not.toContain('unreachable');
  expect(observed).toEqual([cause]);
  // An observer that throws changes nothing the client sees.
  expect(
    await attach(() => {
      throw new Error('observer failed');
    }),
  ).toMatchObject({ outcome: 'error', error: { code: 'REQUEST_REJECTED' } });
});
