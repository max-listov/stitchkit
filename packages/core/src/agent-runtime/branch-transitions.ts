import { z } from 'zod';
import type { BranchIdentities } from './branch-identities';
import { branchMessage, branchRun } from './branch-messages';
import { AgentStoreTransitionSchema } from './store-events';
import type { StoreOperation } from './store-reduce-shared';

export function rekeyBranchTransition(
  ids: BranchIdentities,
  source: string,
  operation: StoreOperation,
): StoreOperation {
  const message = (value: Parameters<typeof branchMessage>[2]) =>
    branchMessage(ids, source, value);
  const input = operation.input;
  switch (operation.type) {
    case 'accept':
      return {
        type: operation.type,
        input: {
          ...operation.input,
          idempotencyKey: ids.define('key', operation.input.idempotencyKey),
          input: message(operation.input.input),
          run: branchRun(ids, source, operation.input.run, false),
          ...(operation.input.coalesceIntoRunId && {
            coalesceIntoRunId: ids.reference('run', operation.input.coalesceIntoRunId),
          }),
        },
      };
    case 'seed':
      return {
        type: operation.type,
        input: {
          ...operation.input,
          conversationId: ids.conversationId,
          seedKey: ids.define('key', operation.input.seedKey),
          inputs: operation.input.inputs.map(message),
        },
      };
    case 'compact':
      return {
        type: operation.type,
        input: {
          ...operation.input,
          conversationId: ids.conversationId,
          replacedMessageIds: operation.input.replacedMessageIds.map((id) =>
            ids.reference('message', id),
          ),
          summary: message(operation.input.summary),
        },
      };
    default: {
      if (!('runId' in input)) throw new TypeError('Branch transition has no run identity');
      const common = {
        ...input,
        conversationId: ids.conversationId,
        runId: ids.reference('run', input.runId),
        ...('ownerId' in input && { ownerId: ids.define('owner', input.ownerId) }),
      };
      return AgentStoreTransitionSchema.parse({
        type: operation.type,
        ...(operation.type === 'recover' &&
          operation.assistant && { assistant: message(operation.assistant) }),
        input: {
          ...common,
          ...(operation.type === 'checkpoint' || operation.type === 'terminal'
            ? { assistant: message(operation.input.assistant) }
            : {}),
          ...(operation.type === 'operation' && {
            operation: {
              ...operation.input.operation,
              operationId: ids.reference('operation', operation.input.operation.operationId),
            },
          }),
          ...(operation.type === 'terminal' &&
            operation.input.absorb && {
              absorb: operation.input.absorb.map((entry) => ({
                runId: ids.reference('run', entry.runId),
                inputMessageIds: entry.inputMessageIds.map((id) =>
                  ids.reference('message', id),
                ),
              })),
            }),
        },
      });
    }
  }
}

export function branchJson(value: unknown) {
  return z.json().parse(value);
}
