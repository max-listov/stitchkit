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

  test('rejects a late non-cooperative result after ownership changes', async () => {
    let current = true;
    let settled = 0;
    const lifecycle = createAgentToolFenceLifecycle({
      runId: 'run-1',
      context: () => ({ callId: 'call-1', fencingToken: 4 }),
      assertCurrent: (input) => {
        expect(input.fencingToken).toBe(4);
        return current ? undefined : 'stale_run';
      },
      onSettled: () => {
        settled += 1;
      },
    });
    const before = lifecycle.beforeHandle;
    const after = lifecycle.afterHandle;
    if (!before || !after) throw new Error('fence lifecycle incomplete');
    const context = { source: 'agent', params: undefined, input: undefined };
    const endpoint = {
      serviceName: 'service',
      key: 'action',
      method: 'POST',
      desc: 'action',
    } satisfies Parameters<NonNullable<typeof before>>[1];
    await before(context, endpoint);
    current = false;

    await expect(after(context, { changed: true }, endpoint)).rejects.toBeInstanceOf(
      ToolExecutionControlError,
    );
    expect(settled).toBe(0);
  });
});
