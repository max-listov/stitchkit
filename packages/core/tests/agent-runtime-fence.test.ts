import { describe, expect, test } from 'bun:test';
import { createAgentToolFenceLifecycle } from '../src/agent-runtime';
import { ToolExecutionControlError } from '../src/tools';

describe('managed agent tool fence', () => {
  test('uses an internal control outcome before a stale tool effect', async () => {
    const lifecycle = createAgentToolFenceLifecycle({
      runId: 'run-1',
      assertCurrent: () => 'stale_run',
    });
    const before = lifecycle.beforeHandle;
    if (!before) throw new Error('beforeHandle missing');
    await expect(
      before(
        { source: 'agent', params: undefined, input: undefined },
        { serviceName: 'service', key: 'action', method: 'POST', desc: 'action' },
      ),
    ).rejects.toBeInstanceOf(ToolExecutionControlError);
  });
});
