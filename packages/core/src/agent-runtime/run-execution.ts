import type { ToolSet } from 'ai';
import { acquireRun } from './run-acquisition';
import type { RunExecutionInput, RunExecutorDependencies } from './run-execution-state';
import { classifyRunFailure } from './run-failure';
import { runModelAttempts } from './run-model-attempts';
import { commitRunTerminal, settleStreamOutcome } from './run-terminal';
import { prepareTurn } from './run-turn-preparation';
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
 */
export function createRunExecutor<CONTEXT, TOOLS extends ToolSet>(
  dependencies: RunExecutorDependencies<CONTEXT, TOOLS>,
) {
  return async function executeRun(
    input: RunExecutionInput<CONTEXT>,
  ): Promise<AgentRuntimeResult> {
    const acquisition = await acquireRun(dependencies, input);
    if (acquisition.kind === 'absorbed') return acquisition.result;
    const { execution } = acquisition;
    try {
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
    return commitRunTerminal(execution);
  };
}
