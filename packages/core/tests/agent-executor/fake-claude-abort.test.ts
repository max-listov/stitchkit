import { expect, test } from 'bun:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createFakeClaudeSdkQuery } from '../../src/entrypoints/agent-executor/testing';

const message: SDKUserMessage = {
  type: 'user',
  message: { role: 'user', content: 'hello' },
  parent_tool_use_id: null,
  session_id: 's',
};

test('aborted Claude fake runs release the prompt iterator and leave the first scripted turn for a live run', async () => {
  let callbacks = 0;
  const harness = createFakeClaudeSdkQuery({
    turns: [
      (_message, controller) => {
        callbacks++;
        controller.emit('first reply');
        controller.end();
      },
    ],
  });
  const pre = new AbortController();
  pre.abort();
  let reads = 0;
  const immediate = {
    async *[Symbol.asyncIterator]() {
      reads++;
      yield message;
    },
  };
  const preRun = harness.query({ prompt: immediate, options: { abortController: pre } });
  expect(await Array.fromAsync(preRun)).toEqual([]);
  expect(reads).toBe(0);
  const pending = Promise.withResolvers<IteratorResult<SDKUserMessage>>();
  const reading = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const during = new AbortController();
  const waiting = harness.query({
    prompt: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            reading.resolve();
            return pending.promise;
          },
          async return() {
            returned.resolve();
            return { done: true, value: undefined } as const;
          },
        };
      },
    },
    options: { abortController: during },
  });
  await reading.promise;
  during.abort();
  expect(await Array.fromAsync(waiting)).toEqual([]);
  await returned.promise;
  pending.resolve({ done: false, value: message });
  await Promise.resolve();
  expect(harness.promptMessages).toHaveLength(0);
  expect(callbacks).toBe(0);
  const live = harness.query({ prompt: immediate });
  expect(await Array.fromAsync(live)).toEqual(['first reply']);
  expect(reads).toBe(1);
  expect(callbacks).toBe(1);
  expect(harness.promptMessages).toEqual([message]);
});
