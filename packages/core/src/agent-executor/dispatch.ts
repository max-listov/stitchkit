import { randomUUID } from 'node:crypto';
import type { AgentMessagePart } from '../agent-parts/parts';
import type { LocalStepDurability } from '../durability/contract';
import type { AgentEngineDriver, AgentEngineSession, AgentEngineTurn } from './engine';
import type { ExecutorProfileConfig } from './profile';

/**
 * How a dispatch ended. `sent` carries the running turn; `delivered` means
 * a restarted executor found the input at the engine and has no stream for
 * it; `unknown_after_restart` means the engine has no record and cannot be
 * asked again — nothing is resent.
 */
export type DispatchOutcome =
  | { phase: 'sent'; clientId: string; turn: AgentEngineTurn }
  | { phase: 'delivered'; clientId: string }
  | { phase: 'unknown_after_restart'; clientId: string };

/**
 * Send a turn's input to the engine at most once.
 *
 * The client id is recorded first, as a step; the send is an effect whose
 * intent is recorded before it runs. A process that dies between the two
 * finds the intent on its next try and asks the engine whether it holds the
 * id — `findInput` for a `client-id` engine — instead of sending: found is
 * `delivered`, not found or not askable is `unknown_after_restart`, and
 * both are final.
 */
export async function dispatchTurn(input: {
  durability: LocalStepDurability;
  driver: AgentEngineDriver;
  session: AgentEngineSession;
  profile: ExecutorProfileConfig;
  cwd: string;
  turnId: string;
  input: readonly AgentMessagePart[];
}): Promise<DispatchOutcome> {
  const { durability, driver, session } = input;
  const clientId = await durability.step(`turn:${input.turnId}:client-id`, () => randomUUID());
  let started: AgentEngineTurn | undefined;
  const outcome = await durability.effect<{ clientId: string }>(
    `turn:${input.turnId}:dispatch`,
    {
      async run() {
        started = await session.startTurn({
          turnId: input.turnId,
          clientId,
          input: input.input,
        });
        return { clientId };
      },
      async reconcile() {
        if (driver.reconcile === 'none' || driver.findInput === undefined) return null;
        const found = await driver.findInput({
          profile: input.profile,
          cwd: input.cwd,
          nativeThreadId: session.nativeThreadId,
          clientId,
        });
        return found ? { clientId } : null;
      },
    },
  );
  if (outcome.outcome === 'uncertain') return { phase: 'unknown_after_restart', clientId };
  return started === undefined
    ? { phase: 'delivered', clientId }
    : { phase: 'sent', clientId, turn: started };
}
