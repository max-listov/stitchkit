import type { ToolSet } from 'ai';
import type {
  AgentRuntimeRecoverOptions,
  AgentRuntimeRecoveryInput,
  AgentRuntimeRecoveryOutcome,
} from './runtime';
import { closedError, refuse } from './runtime-admission-gate';
import type { AgentRuntimeResult } from './runtime-result';
import type { AgentRuntimeState } from './runtime-state';
import type { AgentRecoverableDescriptor } from './store';
import { AgentRuntimeConflictError } from './terminal-commit';

export function resumeAgentRun<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  rawInput: AgentRuntimeRecoveryInput,
): { accepted: Promise<void>; result: Promise<AgentRuntimeResult> } {
  const { config, coordinator } = state;
  if (state.gate.closed) return refuse<AgentRuntimeResult>();
  const context = config.protocol.parseContext(rawInput.context);
  const accepted = Promise.withResolvers<void>();
  const result = Promise.withResolvers<AgentRuntimeResult>();
  let acquisitionSettled = false;
  const resolveAcquisition = (): void => {
    acquisitionSettled = true;
    accepted.resolve();
  };
  const rejectAcquisition = (error: unknown): void => {
    if (!acquisitionSettled) accepted.reject(error);
  };
  const handedOff = state.gate.begin();
  void (async () => {
    try {
      const recovered = await config.store.loadRun({
        conversationId: rawInput.conversationId,
        runId: rawInput.runId,
      });
      if (!recovered) throw new AgentRuntimeConflictError('run lookup');
      const recoveredRun = recovered.run;
      if (recoveredRun.state !== 'queued') {
        throw new Error('Only a queued recovered agent run can be resumed');
      }
      const ticket = coordinator.submit({
        key: rawInput.conversationKey ?? rawInput.conversationId,
        policy: 'queue',
        create: (signal) => ({
          runId: recoveredRun.id,
          execute: () =>
            state.executeRun({
              acceptedRun: recoveredRun,
              context,
              signal,
              key: rawInput.conversationKey ?? rawInput.conversationId,
              onAcquired: resolveAcquisition,
            }),
        }),
      });
      void ticket.accepted.catch(() => undefined);
      void ticket.result.then(result.resolve, (error) => {
        rejectAcquisition(error);
        result.reject(error);
      });
    } catch (error) {
      rejectAcquisition(error);
      result.reject(error);
    } finally {
      handedOff();
    }
  })();
  return { accepted: accepted.promise, result: result.promise };
}

export async function recoverAgentRuns<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  options: AgentRuntimeRecoverOptions<CONTEXT>,
): Promise<readonly AgentRuntimeRecoveryOutcome[]> {
  if (state.gate.closed) throw closedError();
  const pageSize = options.pageSize ?? 100;
  const maxRuns = options.maxRuns ?? 1_000;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new TypeError('Recovery pageSize must be an integer between 1 and 1000');
  }
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) {
    throw new TypeError('Recovery maxRuns must be a positive safe integer');
  }
  const ordered = await collectRecoverable(state, options, pageSize, maxRuns);

  const outcomes: AgentRuntimeRecoveryOutcome[] = [];
  const scheduledRuns = new Map<string, Set<string>>();
  for (const item of ordered) {
    if (options.signal?.aborted) break;
    // Per ITEM, not per page: a close arriving in the middle of a page
    // used to leave the rest of it to be recovered afterwards.
    if (state.gate.closed) break;
    // One item's mutating slice, inside the same barrier admission uses.
    //
    // The gate at the top of `recover` and the one in the loop condition
    // stop what has not started; neither stops what is between
    // `decide()` and the durable write it leads to. A close arriving
    // inside that user callback used to return `settled: true` and then
    // watch `recoverRun` commit — a write after the runtime said it had
    // stopped writing. Held until the item reaches `resume`, which owns
    // the handoff from there.
    const releaseAdmission = state.gate.begin();
    try {
      outcomes.push(await recoverItem(state, options, item, scheduledRuns));
    } catch (error) {
      outcomes.push({
        conversationId: item.conversationId,
        runId: item.run.id,
        outcome: 'failed',
        error,
      });
    } finally {
      releaseAdmission();
    }
  }
  return outcomes;
}

async function collectRecoverable<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  options: AgentRuntimeRecoverOptions<CONTEXT>,
  pageSize: number,
  maxRuns: number,
): Promise<AgentRecoverableDescriptor[]> {
  const { store } = state.config;
  const recoverable: AgentRecoverableDescriptor[] = [];
  let cursor: string | undefined;
  while (recoverable.length < maxRuns && !options.signal?.aborted && !state.gate.closed) {
    const page = await store.scanRecoverable({
      ...(cursor && { cursor }),
      limit: Math.min(pageSize, maxRuns - recoverable.length),
    });
    recoverable.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor || page.items.length === 0) break;
  }

  // A recovery cursor is an identity cursor, not a queue. Buffering remains
  // bounded by `maxRuns`, then each conversation is put back into the
  // store's canonical causal order before anything can acquire. Grouping
  // after the complete bounded scan is what makes a page boundary
  // semantically invisible.
  const grouped = new Map<string, AgentRecoverableDescriptor[]>();
  for (const item of recoverable) {
    const items = grouped.get(item.conversationId) ?? [];
    items.push(item);
    grouped.set(item.conversationId, items);
  }
  const ordered: AgentRecoverableDescriptor[] = [];
  for (const [conversationId, items] of grouped) {
    const active = await store.listActiveRuns(conversationId);
    const position = new Map(active.map((run, index) => [run.id, index]));
    ordered.push(
      ...items.sort((left, right) => {
        const leftPosition = position.get(left.run.id);
        const rightPosition = position.get(right.run.id);
        if (leftPosition === undefined && rightPosition === undefined) return 0;
        if (leftPosition === undefined) return 1;
        if (rightPosition === undefined) return -1;
        return leftPosition - rightPosition;
      }),
    );
  }
  return ordered;
}

async function recoverItem<CONTEXT, TOOLS extends ToolSet>(
  state: AgentRuntimeState<CONTEXT, TOOLS>,
  options: AgentRuntimeRecoverOptions<CONTEXT>,
  item: AgentRecoverableDescriptor,
  scheduledRuns: Map<string, Set<string>>,
): Promise<AgentRuntimeRecoveryOutcome> {
  const { store } = state.config;
  const active = await store.listActiveRuns(item.conversationId);
  const position = active.findIndex((run) => run.id === item.run.id);
  const scheduled = scheduledRuns.get(item.conversationId) ?? new Set<string>();
  const blockedByUnscheduledPredecessor =
    position > 0 && active.slice(0, position).some((run) => !scheduled.has(run.id));
  if (blockedByUnscheduledPredecessor) {
    return { conversationId: item.conversationId, runId: item.run.id, outcome: 'skipped' };
  }
  const decision =
    (await options.decide?.(item)) ??
    (item.run.state === 'queued' ? { action: 'resume' } : { action: 'skip' });
  // Re-read AFTER the callback: this is the last point before the
  // first durable write, and the callback is where a close fits.
  if (state.gate.closed) throw closedError();
  if (decision.action === 'skip') {
    return { conversationId: item.conversationId, runId: item.run.id, outcome: 'skipped' };
  }
  if (decision.action === 'abandon') {
    const abandoned = await store.recoverRun({
      conversationId: item.conversationId,
      runId: item.run.id,
      expectedRevision: item.run.revision,
      action: 'abandon',
    });
    if (abandoned.outcome !== 'applied') {
      throw new AgentRuntimeConflictError('recovery abandon');
    }
    return { conversationId: item.conversationId, runId: item.run.id, outcome: 'abandoned' };
  }
  if (decision.action === 'requeue') {
    const requeued = await store.recoverRun({
      conversationId: item.conversationId,
      runId: item.run.id,
      expectedRevision: item.run.revision,
      action: 'requeue',
      replaySafe: true,
    });
    if (requeued.outcome !== 'applied') {
      throw new AgentRuntimeConflictError('recovery requeue');
    }
  }
  const context = await options.resolveContext(item);
  const resumed = resumeAgentRun(state, {
    conversationId: item.conversationId,
    runId: item.run.id,
    context,
  });
  void resumed.result.catch(() => undefined);
  await resumed.accepted;
  scheduled.add(item.run.id);
  scheduledRuns.set(item.conversationId, scheduled);
  return {
    conversationId: item.conversationId,
    runId: item.run.id,
    outcome: decision.action === 'requeue' ? 'requeued' : 'resumed',
    result: resumed.result,
  };
}
