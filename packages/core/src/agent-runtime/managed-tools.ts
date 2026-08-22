import type { RuntimeContext } from '../contract';
import type { OperationIdentity } from '../server/types';
import {
  ToolExecutionControlError,
  type ToolExecutionControlReason,
  type ToolLifecycle,
} from '../tools/execute';

export interface AgentToolFenceContext {
  runId: string;
  stepId?: string;
  callId?: string;
  idempotencyKey?: string;
}

export interface AgentToolFenceConfig {
  runId: string;
  assertCurrent(
    input: AgentToolFenceContext,
  ):
    | void
    | ToolExecutionControlReason
    | Promise<void>
    | Promise<ToolExecutionControlReason | undefined>;
  context?(ctx: RuntimeContext, endpoint: OperationIdentity): Partial<AgentToolFenceContext>;
  onSettled?(input: AgentToolFenceContext): void | Promise<void>;
}

async function assertFence(
  config: AgentToolFenceConfig,
  input: AgentToolFenceContext,
): Promise<void> {
  const rejected = await config.assertCurrent(input);
  if (rejected) throw new ToolExecutionControlError(rejected);
}

/** Compose beside auth/application lifecycles with `composeToolLifecycle`. */
export function createAgentToolFenceLifecycle(config: AgentToolFenceConfig): ToolLifecycle {
  const callContext = (
    ctx: RuntimeContext,
    endpoint: OperationIdentity,
  ): AgentToolFenceContext => ({
    runId: config.runId,
    ...config.context?.(ctx, endpoint),
  });

  return {
    async beforeHandle(ctx, endpoint) {
      await assertFence(config, callContext(ctx, endpoint));
    },
    async afterHandle(ctx, result, endpoint) {
      const current = callContext(ctx, endpoint);
      await assertFence(config, current);
      await config.onSettled?.(current);
      return result;
    },
  };
}
