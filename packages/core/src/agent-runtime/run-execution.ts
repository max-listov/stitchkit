import type { ToolSet } from 'ai';
import { beginAgentInvocation } from './invocations';
import { acquireRun, beginRunExecution, type RunAcquisition } from './run-acquisition';
import type { RunExecutionInput, RunExecutorDependencies } from './run-execution-state';
import { classifyRunFailure } from './run-failure';
import { runModelAttempts } from './run-model-attempts';
import { commitRunTerminal, settleStreamOutcome } from './run-terminal';
import { prepareTurn } from './run-turn-preparation';
import { closeUnacquiredRun } from './run-unacquired';
import type { AgentRuntimeResult } from './runtime-result';

/**
 * One acquired run, executed to a terminal commit.
 *
 * Extracted from `createAgentRuntime` because it is a different job: the
 * factory wires dependencies and owns process-local admission, this owns the
 * stream loop, checkpoints, fencing and the terminal transition for exactly one
 * run. Dependencies arrive as parameters rather than as a closure over the
 * whole factory, so what a run can touch is visible in one place.
 *
 * The phases live in their own modules and share one `RunExecution` — the
 * run's state as an explicit object rather than the locals of one closure — so
 * the order below is the whole lifecycle: acquire, prepare the turn, run the
 * provider attempts, settle the outcome (or classify the failure), commit.
 * No failure of the store leaves that record active in silence: before
 * ownership the run is closed from outside, after it the terminal is committed,
 * and a store that never answers either rejects with `AgentRunUnsettledError`.
 */
export function createRunExecutor<CONTEXT, TOOLS extends ToolSet>(
  dependencies: RunExecutorDependencies<CONTEXT, TOOLS>,
) {
  /**
   * The runs this process is executing. The record cannot say it: a run with this
   * process's owner may have an executor on another lane, or none at all because
   * the reply to its acquisition was lost.
   */
  const executing = new Set<string>();
  return async function executeRun(
    input: RunExecutionInput<CONTEXT>,
  ): Promise<AgentRuntimeResult> {
    let acquisition: RunAcquisition<CONTEXT, TOOLS>;
    try {
      acquisition = await acquireRun(dependencies, input);
    } catch (error) {
      return closeUnacquiredRun(dependencies, input, error, executing);
    }
    if (acquisition.kind === 'absorbed') return acquisition.result;
    const { execution } = acquisition;
    const runId = execution.state.run.id;
    executing.add(runId);
    try {
      await beginRunExecution(execution);
      const invocations = dependencies.config.invocations;
      if (invocations) {
        const trace = await invocations.trace({
          context: input.context,
          conversationId: execution.state.run.conversationId,
          run: execution.state.run,
        });
        execution.invocation = await beginAgentInvocation(
          invocations.ledger,
          dependencies.config.store,
          { run: execution.state.run, trace },
          input.context,
        );
      }
      const turn = await prepareTurn(execution);
      await runModelAttempts(execution, turn);
      await settleStreamOutcome(execution);
    } catch (error) {
      await classifyRunFailure(execution, error);
    } finally {
      // In a `finally` because the `catch` above does its own I/O: a
      // `loadSnapshot` that throws used to skip this line and leave the idle
      // timer armed for the rest of the process's life.
      execution.idleDeadline.dispose();
    }
    const result = await commitRunTerminal(execution).finally(() => executing.delete(runId));
    await execution.invocation?.finish(
      result.reason === 'success'
        ? 'succeeded'
        : ['interrupted', 'cancelled', 'timeout', 'shutdown'].includes(result.reason)
          ? 'cancelled'
          : 'failed',
    );
    return result;
  };
}
