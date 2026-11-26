import { z } from 'zod';
import type { AgentMessagePart } from '../../agent-parts/parts';
import type { AgentEngineTurn } from '../engine';
import {
  drainEngineRequests,
  type EngineRequestTurn,
  endEngineTurn,
  loseEngineTurn,
} from '../engine-requests';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import { createTurnDeltaChannel } from '../session-primitives';
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
  /** True once `turn-end` or channel failure has settled this turn. */
  settled: boolean;
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
  };
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
  usageInputIncludesCachedRead?: boolean;
  checkOutcome?: AcpCheckPromptOutcome;
  done: () => void;
}): void {
  const { peer, sessionId, prompt, turn, generation, checkOutcome, done } = input;
  // `session/prompt` stays open for the entire turn (streaming updates, tools, human approvals).
  void peer
    .request('session/prompt', { sessionId, prompt: [...prompt] }, { timeoutMs: null })
    .then(async (result) => {
      if (turn.settled) return;
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
      // A newer steer generation now owns the turn: keep the channel open until the final prompt settles.
      if (generation !== turn.promptGeneration) return;
      const rawOverride =
        !turn.state.interruptRequested && checkOutcome !== undefined
          ? await checkOutcome(parsed)
          : undefined;
      if (turn.settled || generation !== turn.promptGeneration) return;
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
      turn.settled = true;
      // A permission the agent still waits on is answered before the turn's end is told.
      endEngineTurn(turn, () => ACP_CANCELLED, last);
      done();
    })
    .catch((error: unknown) => {
      if (turn.settled || generation !== turn.promptGeneration) return;
      turn.settled = true;
      const kind = classifyAcpRpcRefusal(error);
      if (kind !== undefined && error instanceof Error) {
        const raw = { source: 'acp', type: 'session/prompt' };
        endEngineTurn(turn, () => ACP_CANCELLED, [
          {
            type: 'error',
            turnId: turn.state.turnId,
            itemId: 'failure',
            raw,
            kind,
            message: error.message,
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
        loseEngineTurn(turn, () => ACP_CANCELLED, error);
      }
      done();
    });
}

/** The turn as the executor steers it: interrupt with `session/cancel`, answer permission requests. */
export function acpTurnHandle(
  peer: JsonRpcPeer,
  sessionId: string,
  turn: AcpTurnSlot,
): AgentEngineTurn {
  return {
    deltas: turn.channel,
    async interrupt() {
      turn.state.interruptRequested = true;
      peer.notify('session/cancel', { sessionId });
      // A permission request the agent is still waiting on would hold the cancel back.
      drainEngineRequests(turn, () => ACP_CANCELLED);
    },
    async respond(interactionId, rawReply) {
      answerActiveAcpTurnRequest(turn, interactionId, rawReply);
    },
  };
}

/** Build `startTurn` and `steerTurn` for an open ACP session. */
export function createAcpTurnControls(input: {
  config: AcpDriverConfig;
  peer: JsonRpcPeer;
  sessionId: string;
  limits: AcpPromptLimits;
  ensureAlive(): void;
  getTurn(): AcpTurnSlot | undefined;
  setTurn(turn: AcpTurnSlot | undefined): void;
}) {
  let turnOpening = false;
  let steering = false;
  const releaseTurn = (turn: AcpTurnSlot) => {
    if (input.getTurn() === turn) input.setTurn(undefined);
  };
  return {
    async startTurn(turnInput: {
      turnId: string;
      clientId: string;
      input: readonly AgentMessagePart[];
    }): Promise<AgentEngineTurn> {
      input.ensureAlive();
      if (input.getTurn() !== undefined || turnOpening) {
        throw new Error('A turn is already running in this ACP session');
      }
      turnOpening = true;
      let prompt: readonly { type: string; [key: string]: string }[];
      let checkOutcome: AcpCheckPromptOutcome | undefined;
      try {
        prompt = await acpPromptBlocks(turnInput.input, input.limits);
        if (input.config.watchPromptOutcome !== undefined) {
          checkOutcome = await input.config.watchPromptOutcome({
            sessionId: input.sessionId,
            turnId: turnInput.turnId,
            generation: 1,
          });
        }
      } finally {
        turnOpening = false;
      }
      input.ensureAlive();
      const turn = newAcpTurn(turnInput.turnId);
      input.setTurn(turn);
      runAcpPrompt({
        peer: input.peer,
        sessionId: input.sessionId,
        prompt,
        turn,
        generation: 1,
        ...(input.config.usageInputIncludesCachedRead !== undefined && {
          usageInputIncludesCachedRead: input.config.usageInputIncludesCachedRead,
        }),
        ...(checkOutcome !== undefined && { checkOutcome }),
        done: () => releaseTurn(turn),
      });
      return acpTurnHandle(input.peer, input.sessionId, turn);
    },
    async steerTurn(steerInput: {
      readonly input: readonly AgentMessagePart[];
    }): Promise<{ readonly turnId: string }> {
      if ((input.config.steerMode ?? 'none') !== 'prompt') {
        throw new TypeError(
          'The ACP driver does not support steering unless steerMode is "prompt"',
        );
      }
      input.ensureAlive();
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
        input.ensureAlive();
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
        input.ensureAlive();
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
