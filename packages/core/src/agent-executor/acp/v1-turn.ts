import { z } from 'zod';
import type { AgentMessagePart } from '../../agent-parts/parts';
import type { AgentEngineTurn } from '../engine';
import {
  abandonEngineTurn,
  type EngineRequestTurn,
  type EngineTurnLiveness,
  endEngineTurn,
  interruptEngineTurn,
  loseEngineTurn,
} from '../engine-requests';
import { guardedTurnStarter } from '../image-input';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import {
  createTurnDeltaChannel,
  offerTurnDelta,
  type SessionLiveness,
} from '../session-primitives';
import {
  type ExecutorDelta,
  ExecutorErrorKindSchema,
  ExecutorThreadDispositionSchema,
  type ExecutorTokenUsage,
} from '../vocabulary';
import type { AcpDriverConfig, AcpPromptOutcomeOverride } from './v1-connect';
import {
  type AcpPromptLimits,
  type AcpUpdateTrack,
  acpOutcome,
  acpPromptBlocks,
  addAcpTokenUsage,
  classifyAcpRpcRefusal,
  normalizeAcpUsage,
} from './v1-map';
import {
  ACP_CANCELLED,
  type AcpPermissionDetail,
  answerActiveAcpTurnRequest,
} from './v1-permission';
import { type AcpPromptResult, AcpPromptResultSchema } from './v1-protocol';

const AcpPromptOutcomeOverrideSchema = z.strictObject({
  outcome: z.literal('failed').optional(),
  errorKind: ExecutorErrorKindSchema,
  message: z.string().min(1),
  threadDisposition: ExecutorThreadDispositionSchema.optional(),
});

/** Checker returned by `watchPromptOutcome` before `session/prompt` and consulted after it settles. */
export type AcpCheckPromptOutcome = (
  result: AcpPromptResult,
) => Promise<AcpPromptOutcomeOverride | undefined> | AcpPromptOutcomeOverride | undefined;

/** One running ACP turn (possibly spanning multiple steered `session/prompt` generations). */
export interface AcpTurnSlot extends EngineRequestTurn<JsonRpcValue, AcpPermissionDetail> {
  chunk: number;
  track: AcpUpdateTrack;
  /** Monotonic generation of the latest `session/prompt` sent for this turn (1 for initial, 2+ for steers). */
  promptGeneration: number;
  /** Normalized token counters summed across all prompt generations of this turn. */
  accumulatedUsage: ExecutorTokenUsage | undefined;
  /** Generations whose `session/prompt` the agent has not answered yet. */
  readonly openGenerations: Set<number>;
  /** Endings of prompts a newer steer superseded, kept until that steer is accepted or refused. */
  readonly supersededResults: Map<number, () => void>;
}

export function newAcpTurn(turnId: string): AcpTurnSlot {
  return {
    state: { turnId, interruptRequested: false },
    channel: createTurnDeltaChannel(),
    pending: new Map(),
    chunk: 0,
    track: { segment: 0, toolNames: new Map() },
    promptGeneration: 1,
    accumulatedUsage: undefined,
    settled: false,
    openGenerations: new Set(),
    supersededResults: new Map(),
  };
}

/**
 * Fail a turn's delta stream. When `sendCancelled` is `true`, pending permission requests are
 * drained with `ACP_CANCELLED`; when `false`, the agent no longer reads and they are dropped.
 */
export function settleAcpTurn(
  turn: AcpTurnSlot | undefined,
  reason: unknown,
  sendCancelled: boolean,
): void {
  if (sendCancelled) loseEngineTurn(turn, () => ACP_CANCELLED, reason);
  else abandonEngineTurn(turn, reason);
}

/** Hand a refused steer's turn back to `previous` and tell the refusal as a non-terminal error. */
function refusedSteer(
  turn: AcpTurnSlot,
  error: unknown,
  generation: number,
  previous: number,
): void {
  const kind = classifyAcpRpcRefusal(error) ?? 'unhandled';
  turn.promptGeneration = previous;
  offerTurnDelta(turn.channel, {
    type: 'error',
    turnId: turn.state.turnId,
    itemId: `steer-refused:${generation}`,
    raw: { source: 'acp', type: 'session/prompt' },
    kind,
    message: `The ACP agent refused the steer prompt: ${error instanceof Error ? error.message : String(error)}`,
  });
}

/**
 * Send one `session/prompt` generation and settle the turn once the latest generation completes:
 * accumulated usage, optional `watchPromptOutcome` override (`errorKind`, `threadDisposition`),
 * failure by kind, and `turn-end`. Earlier steered prompt generations fold their usage into the
 * turn without closing `turn.channel`.
 */
export function runAcpPrompt(input: {
  peer: JsonRpcPeer;
  sessionId: string;
  prompt: readonly JsonRpcValue[];
  turn: AcpTurnSlot;
  generation: number;
  liveness: SessionLiveness;
  usageInputIncludesCachedRead?: boolean;
  checkOutcome?: AcpCheckPromptOutcome;
  done: () => void;
}): void {
  const { peer, sessionId, prompt, turn, generation, liveness, checkOutcome, done } = input;
  const settle = async (parsed: AcpPromptResult): Promise<void> => {
    const rawOverride =
      !turn.state.interruptRequested && checkOutcome !== undefined
        ? await checkOutcome(parsed)
        : undefined;
    if (turn.settled || generation !== turn.promptGeneration) return;
    liveness.ensureAlive();
    const override =
      rawOverride !== undefined
        ? AcpPromptOutcomeOverrideSchema.parse(rawOverride)
        : undefined;
    const outcome =
      override !== undefined
        ? 'failed'
        : acpOutcome(parsed.stopReason, turn.state.interruptRequested);
    const raw = { source: 'acp', type: `session/prompt/${parsed.stopReason}` };
    const last: ExecutorDelta[] = [];
    if (turn.accumulatedUsage !== undefined) {
      last.push({
        type: 'usage',
        turnId: turn.state.turnId,
        itemId: 'usage',
        raw,
        ...turn.accumulatedUsage,
      });
    }
    if (override !== undefined) {
      last.push({
        type: 'error',
        turnId: turn.state.turnId,
        itemId: 'failure',
        raw,
        kind: override.errorKind,
        message: override.message,
      });
    } else if (outcome === 'failed') {
      last.push({
        type: 'error',
        turnId: turn.state.turnId,
        itemId: 'failure',
        raw,
        kind: 'restartRecommended',
        message: `The ACP agent stopped: ${parsed.stopReason}`,
      });
    }
    last.push({
      type: 'turn-end',
      turnId: turn.state.turnId,
      itemId: 'end',
      raw,
      outcome,
      ...(override?.threadDisposition !== undefined && {
        threadDisposition: override.threadDisposition,
      }),
    });
    // A permission the agent still waits on is answered before the turn's end is told.
    endEngineTurn(turn, () => ACP_CANCELLED, last);
    done();
  };
  const fail = (error: unknown): void => {
    turn.openGenerations.delete(generation);
    if (turn.settled || generation !== turn.promptGeneration) return;
    // ACP has no acknowledgement of a prompt: an error while an earlier prompt of this turn is
    // still running — or ended while superseded — is the agent refusing the steer, not the turn
    // failing. The turn goes back to the newest earlier prompt, and the refusal is told without
    // ending it; an earlier prompt that already ended settles the turn now.
    const earlier = [...turn.openGenerations, ...turn.supersededResults.keys()].filter(
      (other) => other < generation,
    );
    if (earlier.length > 0) {
      const previous = Math.max(...earlier);
      refusedSteer(turn, error, generation, previous);
      const ended = turn.supersededResults.get(previous);
      turn.supersededResults.delete(previous);
      ended?.();
      return;
    }
    // A session that stopped fails the turn for its own reason, and its agent reads no answer.
    const stop = liveness.stopped();
    if (stop !== undefined) {
      abandonEngineTurn(turn, stop.reason);
      done();
      return;
    }
    const failure = error;
    const kind = classifyAcpRpcRefusal(failure);
    if (kind !== undefined && failure instanceof Error) {
      const raw = { source: 'acp', type: 'session/prompt' };
      endEngineTurn(turn, () => ACP_CANCELLED, [
        {
          type: 'error',
          turnId: turn.state.turnId,
          itemId: 'failure',
          raw,
          kind,
          message: failure.message,
        },
        {
          type: 'turn-end',
          turnId: turn.state.turnId,
          itemId: 'end',
          raw,
          outcome: 'failed',
        },
      ]);
    } else {
      loseEngineTurn(turn, () => ACP_CANCELLED, failure);
    }
    done();
  };
  turn.openGenerations.add(generation);
  // `session/prompt` stays open for the entire turn (streaming updates, tools, human approvals).
  void peer
    .request('session/prompt', { sessionId, prompt: [...prompt] }, { timeoutMs: null })
    .then(async (result) => {
      turn.openGenerations.delete(generation);
      if (turn.settled) return;
      liveness.ensureAlive();
      const parsed = AcpPromptResultSchema.parse(result);
      if (parsed.usage !== undefined && parsed.usage !== null) {
        turn.accumulatedUsage = addAcpTokenUsage(
          turn.accumulatedUsage,
          normalizeAcpUsage(parsed.usage, {
            ...(input.usageInputIncludesCachedRead !== undefined && {
              usageInputIncludesCachedRead: input.usageInputIncludesCachedRead,
            }),
          }),
        );
      }
      if (generation !== turn.promptGeneration) {
        // A newer steer owns the turn; this ending is kept in case the agent refuses that steer.
        turn.supersededResults.set(generation, () => {
          settle(parsed).catch(fail);
        });
        return;
      }
      await settle(parsed);
    })
    .catch(fail);
}

/** The turn as the executor steers it: interrupt with `session/cancel`, answer permission requests. */
export function acpTurnHandle(
  peer: JsonRpcPeer,
  sessionId: string,
  turn: AcpTurnSlot,
  liveness: EngineTurnLiveness,
): AgentEngineTurn {
  return {
    deltas: turn.channel,
    // A permission request the agent still waits on would hold the cancel back: it is answered first.
    interrupt: () =>
      interruptEngineTurn(turn, liveness, {
        refusal: () => ACP_CANCELLED,
        tell: () => peer.notify('session/cancel', { sessionId }),
      }),
    async respond(interactionId, rawReply) {
      answerActiveAcpTurnRequest(turn, liveness, interactionId, rawReply);
    },
  };
}

/** Build `startTurn` and `steerTurn` for an open ACP session. */
export function createAcpTurnControls(input: {
  config: AcpDriverConfig;
  peer: JsonRpcPeer;
  sessionId: string;
  limits: AcpPromptLimits;
  liveness: SessionLiveness;
  getTurn(): AcpTurnSlot | undefined;
  setTurn(turn: AcpTurnSlot | undefined): void;
}) {
  let steering = false;
  const releaseTurn = (turn: AcpTurnSlot) => {
    if (input.getTurn() === turn) input.setTurn(undefined);
  };
  const { liveness } = input;
  const startTurn = guardedTurnStarter({
    busyMessage: 'A turn is already running in this ACP session',
    check() {
      liveness.ensureAlive();
      if (input.getTurn() !== undefined) {
        throw new Error('A turn is already running in this ACP session');
      }
    },
    async inline(turnInput: {
      turnId: string;
      clientId: string;
      input: readonly AgentMessagePart[];
    }) {
      const prompt = await acpPromptBlocks(turnInput.input, input.limits);
      liveness.ensureAlive();
      const checkOutcome: AcpCheckPromptOutcome | undefined =
        input.config.watchPromptOutcome !== undefined
          ? await input.config.watchPromptOutcome({
              sessionId: input.sessionId,
              turnId: turnInput.turnId,
              generation: 1,
            })
          : undefined;
      return { prompt, checkOutcome };
    },
    dispatch(turnInput, { prompt, checkOutcome }): AgentEngineTurn {
      const turn = newAcpTurn(turnInput.turnId);
      input.setTurn(turn);
      runAcpPrompt({
        peer: input.peer,
        sessionId: input.sessionId,
        prompt,
        turn,
        generation: 1,
        liveness,
        ...(input.config.usageInputIncludesCachedRead !== undefined && {
          usageInputIncludesCachedRead: input.config.usageInputIncludesCachedRead,
        }),
        ...(checkOutcome !== undefined && { checkOutcome }),
        done: () => releaseTurn(turn),
      });
      return acpTurnHandle(input.peer, input.sessionId, turn, liveness);
    },
  });
  return {
    startTurn,
    async steerTurn(steerInput: {
      readonly input: readonly AgentMessagePart[];
    }): Promise<{ readonly turnId: string }> {
      if ((input.config.steerMode ?? 'none') !== 'prompt') {
        throw new TypeError(
          'The ACP driver does not support steering unless steerMode is "prompt"',
        );
      }
      liveness.ensureAlive();
      const turn = input.getTurn();
      if (turn === undefined || turn.settled) {
        throw new Error('Cannot steer turn: no ACP turn is currently running');
      }
      if (turn.state.interruptRequested) {
        throw new Error('Cannot steer turn: the active ACP turn was interrupted');
      }
      if (steering) {
        throw new Error('A steer request is already being dispatched for this ACP turn');
      }
      steering = true;
      let prompt: readonly { type: string; [key: string]: string }[];
      let checkOutcome: AcpCheckPromptOutcome | undefined;
      let nextGeneration: number;
      try {
        prompt = await acpPromptBlocks(steerInput.input, input.limits);
        liveness.ensureAlive();
        if (input.getTurn() !== turn || turn.settled || turn.state.interruptRequested) {
          throw new Error(
            'Cannot steer turn: the active ACP turn ended before steering was sent',
          );
        }
        nextGeneration = turn.promptGeneration + 1;
        if (input.config.watchPromptOutcome !== undefined) {
          checkOutcome = await input.config.watchPromptOutcome({
            sessionId: input.sessionId,
            turnId: turn.state.turnId,
            generation: nextGeneration,
          });
        }
        liveness.ensureAlive();
        if (input.getTurn() !== turn || turn.settled || turn.state.interruptRequested) {
          throw new Error(
            'Cannot steer turn: the active ACP turn ended before steering was sent',
          );
        }
        // Bump generation BEFORE sending the second prompt so the first prompt's `end_turn`
        // does not close `turn.channel` or emit a premature `turn-end`.
        turn.promptGeneration = nextGeneration;
      } finally {
        steering = false;
      }
      runAcpPrompt({
        peer: input.peer,
        sessionId: input.sessionId,
        prompt,
        turn,
        generation: nextGeneration,
        liveness,
        ...(input.config.usageInputIncludesCachedRead !== undefined && {
          usageInputIncludesCachedRead: input.config.usageInputIncludesCachedRead,
        }),
        ...(checkOutcome !== undefined && { checkOutcome }),
        done: () => releaseTurn(turn),
      });
      return { turnId: turn.state.turnId };
    },
  };
}
