import {
  type EngineRequestTurn,
  endEngineTurn,
  type PendingEngineRequest,
} from '../engine-requests';
import type { PlanLimits } from '../hello';
import { mergeRateLimitEvent } from '../plan-limits';
import { offerTurnDelta } from '../session-primitives';
import {
  type ClaudeTurnState,
  type ClaudeVerdict,
  classifyClaudeRecord,
  newClaudeTurnState,
} from './classify';
import { claudePlanWindows } from './limits';

/** A running Claude turn as the router sees it: the classifier's state and the requests it holds. */
export interface ClaudeRoutedTurn<A, D> extends EngineRequestTurn<A, D> {
  readonly state: ClaudeTurnState;
}

/** Where one Claude record goes, for the CLI's lines and the Agent SDK's messages alike. */
export interface ClaudeRecordRoute<A, D, T extends ClaudeRoutedTurn<A, D>> {
  /** The turn running as the record arrived; `undefined` between turns. */
  readonly turn: T | undefined;
  readonly profileId: string;
  readonly limits: Map<string, PlanLimits>;
  /** The answer to a request the turn still holds when the engine ends it. */
  readonly ended: (request: PendingEngineRequest<A, D>) => A;
  /** The engine ended the turn: the session lets go of it. */
  clearTurn(turn: T | undefined): void;
  /** The engine ended the turn; called before its stream closes. */
  onEnd?(turn: T | undefined, end: Extract<ClaudeVerdict, { kind: 'end' }>): void;
  /** A permission the engine asks in-band. A transport that asks another way leaves it out. */
  onRequest?(turn: T | undefined, request: Extract<ClaudeVerdict, { kind: 'request' }>): void;
  /** A control request the driver does not know and the engine waits on. */
  onRefuse?(refuse: { requestId: string; message: string }): void;
  onEvent?(event: Extract<ClaudeVerdict, { kind: 'event' }>['event']): void;
  onSession?(session: Extract<ClaudeVerdict, { kind: 'session' }>): void;
}

/**
 * Classify one Claude record and apply it: limits to the profile, deltas to the running turn, an
 * end to that turn's stream. The one router of the CLI driver and the Agent SDK leaf — what
 * differs between them (how a permission is asked, which observers exist) is the route's hooks.
 */
export function routeClaudeRecord<A, D, T extends ClaudeRoutedTurn<A, D>>(
  record: unknown,
  route: ClaudeRecordRoute<A, D, T>,
): void {
  const { turn } = route;
  const verdict = classifyClaudeRecord(
    record,
    turn?.state ?? newClaudeTurnState('between-turns'),
  );
  switch (verdict.kind) {
    case 'limits':
      route.limits.set(
        route.profileId,
        mergeRateLimitEvent({
          previous: route.limits.get(route.profileId),
          windows: claudePlanWindows(verdict.info),
          now: new Date(),
        }),
      );
      return;
    case 'deltas':
      for (const delta of verdict.deltas) offerTurnDelta(turn?.channel, delta);
      return;
    case 'request':
      route.onRequest?.(turn, verdict);
      return;
    case 'unhandled':
      offerTurnDelta(turn?.channel, verdict.delta);
      if (verdict.refuse !== undefined) route.onRefuse?.(verdict.refuse);
      return;
    case 'end':
      route.onEnd?.(turn, verdict);
      endEngineTurn(turn, route.ended, verdict.deltas);
      route.clearTurn(turn);
      return;
    case 'event':
      route.onEvent?.(verdict.event);
      return;
    case 'session':
      route.onSession?.(verdict);
      return;
    case 'ignore':
      return;
  }
}
