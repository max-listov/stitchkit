import type { TurnPhase } from './executor-contract';

/** The phases a turn may move to from each phase; a terminal phase moves nowhere. */
const NEXT: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  leased: ['dispatching', 'failed'],
  dispatching: ['delivered', 'failed', 'unknown', 'unknown_after_restart'],
  delivered: ['completed', 'interrupted', 'failed', 'unknown', 'unknown_after_restart'],
  completed: [],
  interrupted: [],
  failed: [],
  unknown: [],
  unknown_after_restart: [],
};

/** Whether a turn phase is final and admits no further transitions. */
export function isTerminalTurnPhase(phase: TurnPhase): boolean {
  return NEXT[phase].length === 0;
}

/**
 * Whether a turn may move from `from` to `to`. Reporting the phase it is
 * already in is allowed — a resent report — and nothing leaves a terminal
 * phase: a late `completed` cannot overwrite an `interrupted`.
 */
export function canAdvanceTurnPhase(from: TurnPhase, to: TurnPhase): boolean {
  return from === to || NEXT[from].includes(to);
}
