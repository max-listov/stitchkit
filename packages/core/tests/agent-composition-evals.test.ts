import { expect, test } from 'bun:test';
import type { AgentSnapshot } from '../src/agent-runtime/schemas';
import { inspectAgentRun } from '../src/entrypoints/agent-runtime/testing';
import { compositionHarness } from './support/agent-composition';

test('run inspection distinguishes exact run, requested tool, successful result and pending approval', async () => {
  const harness = compositionHarness();
  try {
    const ticket = harness.submit({
      conversationId: 'eval',
      idempotencyKey: 'first',
      context: { owner: 'alice' },
      parts: [{ type: 'text', text: 'hello' }],
    });
    await ticket.result;
    const snapshot = await harness.snapshot('eval');
    const runId = snapshot.runs[0]?.id;
    if (!runId) throw new Error('Missing admitted run');
    const evaluated = inspectAgentRun(snapshot, runId);
    evaluated.completed();
    evaluated.notCalledTool('search');
    expect(() => evaluated.calledTool('search')).toThrow('expected tool call search');
    expect(() => inspectAgentRun(snapshot, 'other')).toThrow('absent');
    const withParts = (parts: AgentSnapshot['messages'][number]['parts']): AgentSnapshot => ({
      ...snapshot,
      messages: snapshot.messages.map((message) =>
        message.role === 'assistant' ? { ...message, parts } : message,
      ),
    });
    const call = {
      type: 'tool-call',
      callId: 'call',
      toolName: 'search',
      input: {},
    } satisfies AgentSnapshot['messages'][number]['parts'][number];
    const requested = inspectAgentRun(withParts([call]), runId);
    requested.calledTool('search');
    expect(() => requested.toolSucceeded('search')).toThrow('expected successful result');
    expect(() => requested.notCalledTool('search')).toThrow('unexpected tool call');
    for (const outcome of ['error', 'interrupted'] satisfies Array<'error' | 'interrupted'>) {
      expect(() =>
        inspectAgentRun(
          withParts([
            call,
            { type: 'tool-result', callId: 'call', toolName: 'search', outcome },
          ]),
          runId,
        ).toolSucceeded('search'),
      ).toThrow('expected successful result');
    }
    inspectAgentRun(
      withParts([
        call,
        {
          type: 'tool-result',
          callId: 'call',
          toolName: 'search',
          outcome: 'success',
          output: { found: true },
        },
      ]),
      runId,
    ).toolSucceeded('search');
    expect(() =>
      inspectAgentRun(
        withParts([
          call,
          { type: 'tool-result', callId: 'other', toolName: 'search', outcome: 'success' },
        ]),
        runId,
      ).toolSucceeded('search'),
    ).toThrow('expected successful result');
    expect(() =>
      inspectAgentRun(
        withParts([
          call,
          { type: 'tool-approval-request', callId: 'call', approvalId: 'approval' },
        ]),
        runId,
      ).completed(),
    ).toThrow('pending approval');
    for (const terminalReason of ['provider_stop', 'policy_stop'] satisfies Array<
      'provider_stop' | 'policy_stop'
    >) {
      const stopped: AgentSnapshot = {
        ...snapshot,
        runs: snapshot.runs.map((run) => ({
          ...run,
          terminalReason,
          terminalPolicyName: 'repeated-error',
        })),
      };
      expect(() => inspectAgentRun(stopped, runId).completed()).toThrow(
        'expected completed output',
      );
    }
    const oldEvidence = withParts([call]);
    oldEvidence.messages = oldEvidence.messages.map((message) =>
      message.role === 'assistant' ? { ...message, runId: 'previous' } : message,
    );
    expect(() => inspectAgentRun(oldEvidence, runId).calledTool('search')).toThrow(
      'expected tool call',
    );
    for (const state of ['queued', 'running', 'failed'] satisfies Array<
      'queued' | 'running' | 'failed'
    >) {
      const negative: AgentSnapshot = {
        ...snapshot,
        runs: snapshot.runs.map((run) => ({
          ...run,
          state,
          terminalReason: state === 'failed' ? 'output_rejected' : undefined,
        })),
      };
      expect(() => inspectAgentRun(negative, runId).completed()).toThrow(
        'expected completed output',
      );
    }
  } finally {
    await harness.close();
  }
});
