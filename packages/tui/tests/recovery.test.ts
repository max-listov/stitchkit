import { describe, expect, test } from 'bun:test';
import { AgentRecoverableDescriptorSchema } from 'stitchkit/agent-runtime';
import { defaultAgentTuiRecoveryDecision } from '../src/run';

describe('Agent TUI recovery policy', () => {
  test('resumes queued work but never invents replay safety for an acquired run', () => {
    const base = {
      conversationId: 'main',
      run: {
        schemaVersion: 1,
        id: 'run-1',
        conversationId: 'main',
        inputMessageIds: ['input-1'],
        assistantMessageId: 'assistant-1',
        revision: 1,
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
      },
    };
    const queued = AgentRecoverableDescriptorSchema.parse({
      ...base,
      run: { ...base.run, state: 'queued' },
    });
    const acquired = AgentRecoverableDescriptorSchema.parse({
      ...base,
      run: { ...base.run, state: 'running', ownerId: 'dead-owner', fencingToken: 1 },
    });
    expect(defaultAgentTuiRecoveryDecision(queued)).toEqual({ action: 'resume' });
    expect(defaultAgentTuiRecoveryDecision(acquired)).toEqual({ action: 'skip' });
  });
});
