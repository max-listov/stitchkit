import type { AgentEngineTurn } from '../engine';
import {
  answerEngineRequest,
  drainEngineRequests,
  type EngineRequestTurn,
  endEngineTurn,
  loseEngineTurn,
} from '../engine-requests';
import { InteractionReplySchema } from '../executor-contract';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import { createTurnDeltaChannel } from '../session-primitives';
import type { ExecutorDelta } from '../vocabulary';
import { type AcpUpdateTrack, acpOutcome, classifyAcpRpcRefusal } from './v1-map';
import { AcpPromptResultSchema } from './v1-protocol';

/** The answer to a permission request nobody will choose an option for. */
export const ACP_CANCELLED: JsonRpcValue = { outcome: { outcome: 'cancelled' } };

/** One running `session/prompt`: its deltas and the permission requests it waits on, with their options. */
export interface AcpTurnSlot
  extends EngineRequestTurn<JsonRpcValue, { options: { optionId: string; kind: string }[] }> {
  chunk: number;
  track: AcpUpdateTrack;
}

export function newAcpTurn(turnId: string): AcpTurnSlot {
  return {
    state: { turnId, interruptRequested: false },
    channel: createTurnDeltaChannel(),
    pending: new Map(),
    chunk: 0,
    track: { segment: 0, toolNames: new Map() },
  };
}

/**
 * Send the prompt and end the turn with its answer: usage, a failure by
 * kind, the outcome. `done` releases the active turn slot.
 */
export function runAcpPrompt(
  peer: JsonRpcPeer,
  sessionId: string,
  prompt: readonly JsonRpcValue[],
  turn: AcpTurnSlot,
  done: () => void,
): void {
  // `session/prompt` stays open for the entire turn (streaming updates, tools, human approvals).
  void peer
    .request('session/prompt', { sessionId, prompt: [...prompt] }, { timeoutMs: null })
    .then((result) => {
      const { stopReason, usage } = AcpPromptResultSchema.parse(result);
      const outcome = acpOutcome(stopReason, turn.state.interruptRequested);
      const raw = { source: 'acp', type: `session/prompt/${stopReason}` };
      const last: ExecutorDelta[] = [];
      if (usage !== undefined && usage !== null) {
        last.push({
          type: 'usage',
          turnId: turn.state.turnId,
          itemId: 'usage',
          raw,
          ...(usage.inputTokens != null && { inputTokens: usage.inputTokens }),
          ...(usage.outputTokens != null && { outputTokens: usage.outputTokens }),
          ...(usage.cachedReadTokens != null && {
            cachedInputTokens: usage.cachedReadTokens,
          }),
        });
      }
      if (outcome === 'failed') {
        last.push({
          type: 'error',
          turnId: turn.state.turnId,
          itemId: 'failure',
          raw,
          kind: 'restartRecommended',
          message: `The ACP agent stopped: ${stopReason}`,
        });
      }
      last.push({ type: 'turn-end', turnId: turn.state.turnId, itemId: 'end', raw, outcome });
      // A permission the agent still waits on is answered before the turn's end is told.
      endEngineTurn(turn, () => ACP_CANCELLED, last);
      done();
    })
    .catch((error: unknown) => {
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
      const reply = InteractionReplySchema.shape.reply.parse(rawReply);
      const waiting = turn.pending.get(interactionId);
      if (waiting === undefined)
        throw new TypeError(`Unknown interaction ${interactionId} for this turn`);
      if (reply.kind === 'input') {
        throw new TypeError(
          'An ACP permission request is approved or denied, not answered with input',
        );
      }
      const wanted = reply.kind === 'approve' ? 'allow' : 'reject';
      const { options } = waiting.detail;
      const option =
        options.find((candidate) => candidate.kind === `${wanted}_once`) ??
        options.find((candidate) => candidate.kind.startsWith(wanted));
      if (option === undefined) throw new TypeError(`The agent offered no ${wanted} option`);
      answerEngineRequest(turn, interactionId, {
        outcome: { outcome: 'selected', optionId: option.optionId },
      });
    },
  };
}
