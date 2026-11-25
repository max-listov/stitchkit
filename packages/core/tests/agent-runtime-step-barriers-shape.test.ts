/**
 * A tool's result does not depend on whether its call waited for another.
 *
 * Under dependency order a call either runs at once or waits for the earlier
 * calls of its entity. An `async *execute` streams either way. An `execute`
 * that is not an async generator function — an arrow returning an async
 * iterable, or a promise of one — ends in one final result, its last value,
 * whether it waited or not.
 */
import { describe, expect, test } from 'bun:test';
import { type Tool, tool } from 'ai';
import { createToolDependencyResolver } from '../src/entrypoints/agent-runtime';
import {
  answer,
  call,
  finish,
  harness,
  idOf,
  noInput,
  partsOf,
  round,
} from './support/step-barriers-harness';

/** What the conversation and the event stream hold for call `c-w2`. */
async function observeCall(w2: Tool, waits: boolean) {
  const w1 = tool({ inputSchema: noInput, execute: async () => 'w1-done' });
  const calls = waits
    ? [call('c-w1', 'w1', { id: 'e1' }), call('c-w2', 'w2', { id: 'e1' })]
    : [call('c-w2', 'w2', { id: 'e1' }), call('c-w1', 'w1', { id: 'e2' })];
  const h = harness(
    [round([...calls, finish('tool-calls')]), answer()],
    { w1, w2 },
    {
      toolDependencies: createToolDependencyResolver({
        effects: { w1: 'write', w2: 'write' },
        entityOf: (_name, input) => idOf(input),
      }),
    },
  );
  await h.say('k');
  const after = await h.store.loadSnapshot('c');
  await h.runtime.close();
  return {
    results: partsOf(after).flatMap((part) =>
      part.type === 'tool-result' && part.callId === 'c-w2'
        ? [{ outcome: part.outcome, output: part.output }]
        : [],
    ),
    statuses: h.events.flatMap((event) =>
      event.type === 'tool-status' && event.callId === 'c-w2' ? [event.status] : [],
    ),
  };
}

const iterate = async function* () {
  yield 'w2-partial';
  yield 'w2-done';
};

describe('a tool keeps one result shape under dependency order', () => {
  const shapes: Record<string, Tool> = {
    'an arrow returning an async iterable': tool({
      inputSchema: noInput,
      execute: () => iterate(),
    }),
    'an async function returning an async iterable': tool({
      inputSchema: noInput,
      execute: async () => iterate(),
    }),
  };
  for (const [shape, w2] of Object.entries(shapes)) {
    test(`${shape}: one final result, its last value, with or without waiting`, async () => {
      const alone = await observeCall(w2, false);
      const waited = await observeCall(w2, true);
      expect(alone.results).toEqual([{ outcome: 'success', output: 'w2-done' }]);
      expect(waited).toEqual(alone);
    });
  }

  test('an async *execute streams with or without waiting', async () => {
    const w2 = tool({
      inputSchema: noInput,
      async *execute() {
        yield 'w2-partial';
        yield 'w2-done';
      },
    });
    const alone = await observeCall(w2, false);
    const waited = await observeCall(w2, true);
    expect(alone.results).toEqual([{ outcome: 'success', output: 'w2-done' }]);
    expect(waited).toEqual(alone);
  });

  test('a streaming tool records its final value once, its intermediate values never', async () => {
    const streaming = tool({
      inputSchema: noInput,
      async *execute() {
        yield 'partial';
        yield 'done';
      },
    });
    const h = harness(
      [round([call('s', 'streaming'), finish('tool-calls')]), answer()],
      { streaming },
      {},
    );
    await h.say('k');
    const after = await h.store.loadSnapshot('c');
    await h.runtime.close();
    expect(
      partsOf(after).flatMap((part) => (part.type === 'tool-result' ? [part.output] : [])),
    ).toEqual(['done']);
    expect(
      h.events.flatMap((event) =>
        event.type === 'tool-status' && event.status === 'completed' ? [event.callId] : [],
      ),
    ).toEqual(['s']);
  });
});
