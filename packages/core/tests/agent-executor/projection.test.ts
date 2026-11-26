/** Deltas fold into the message parts the runtime stores, one item one part, every block kind. */
import { expect, test } from 'bun:test';
import {
  type ExecutorDelta,
  projectExecutorDeltas,
} from '../../src/entrypoints/agent-executor';

const at = (itemId: string) => ({ turnId: 't', itemId, raw: { source: 'test', type: 'x' } });

test('every block kind folds into its part, in the order items appeared', () => {
  const deltas: ExecutorDelta[] = [
    { type: 'reasoning', text: 'thinking ', ...at('r') },
    { type: 'text', text: 'Hello', ...at('a') },
    { type: 'reasoning', text: 'more', ...at('r') },
    { type: 'text', text: ', world', ...at('a') },
    { type: 'tool-call', callId: 'c1', toolName: 'read', input: { path: 'x' }, ...at('call') },
    {
      type: 'request',
      kind: 'approval',
      interactionId: 'q1',
      callId: 'c1',
      toolName: 'read',
      ...at('ask'),
    },
    { type: 'request-resolved', interactionId: 'q1', ...at('ask-done') },
    {
      type: 'tool-result',
      callId: 'c1',
      toolName: 'read',
      outcome: 'success',
      output: 'bytes',
      ...at('result'),
    },
    { type: 'status', phase: 'initializing', ...at('status') },
    { type: 'usage', inputTokens: 10, outputTokens: 2, ...at('usage') },
    { type: 'turn-end', outcome: 'completed', threadDisposition: 'reusable', ...at('end') },
  ];
  expect(projectExecutorDeltas(deltas)).toEqual([
    { type: 'reasoning', text: 'thinking more' },
    { type: 'text', text: 'Hello, world' },
    { type: 'tool-call', callId: 'c1', toolName: 'read', input: { path: 'x' } },
    { type: 'tool-approval-request', approvalId: 'q1', callId: 'c1' },
    {
      type: 'tool-result',
      callId: 'c1',
      toolName: 'read',
      outcome: 'success',
      output: 'bytes',
    },
  ]);
});

test('a window reset discards what was folded before it', () => {
  expect(
    projectExecutorDeltas([
      { type: 'text', text: 'stale', ...at('a') },
      { type: 'window', reset: 'generation', ...at('w') },
      { type: 'text', text: 'fresh', ...at('b') },
    ]),
  ).toEqual([{ type: 'text', text: 'fresh' }]);
});
