import { randomUUID } from 'node:crypto';
import type {
  CanUseTool,
  PermissionResult,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  type ClaudeTurnState,
  classifyClaudeRecord,
  newClaudeTurnState,
} from '../claude/classify';
import { claudePlanWindows } from '../claude/limits';
import type { AgentEngineTurn } from '../engine';
import {
  answerEngineRequest,
  drainEngineRequests,
  type EngineRequestTurn,
  endEngineTurn,
  holdEngineRequest,
} from '../engine-requests';
import { InteractionReplySchema } from '../executor-contract';
import type { PlanLimits } from '../hello';
import { mergeRateLimitEvent } from '../plan-limits';
import { nonEmptyString, offerTurnDelta, safeJsonValue } from '../session-primitives';
import type { ClaudeSdkRun } from './driver';

/** A running turn: its state, its deltas and the `canUseTool` calls it holds, with their input. */
export interface SdkTurnSlot
  extends EngineRequestTurn<PermissionResult, { input: Record<string, unknown> }> {
  readonly state: ClaudeTurnState;
}

/** One active Agent SDK query handle managed by a session. */
export interface RunningQueryHandle {
  readonly query: ClaudeSdkRun;
  send(message: SDKUserMessage): void;
  startLoop(): void;
  close(): void;
}

const SDK_ANSWER = { source: 'claude-sdk', type: 'PermissionResult' };

/** The answer to every `canUseTool` call a stopped turn still holds: deny, and interrupt the SDK's turn. */
export const stoppedPermission = (message: string) => (): PermissionResult => ({
  behavior: 'deny',
  message,
  interrupt: true,
});

/** Invoke `query.close?.()` while containing synchronous throws and async rejections. */
export function closeQuerySafely(query: ClaudeSdkRun | undefined): void {
  try {
    const closing: unknown = query?.close?.();
    if (
      typeof closing === 'object' &&
      closing !== null &&
      'then' in closing &&
      typeof closing.then === 'function'
    ) {
      void Promise.resolve(closing).catch(() => undefined);
    }
  } catch {
    // Closing a broken or already-closed query must not mask the primary error.
  }
}

/** The prompt a query reads: user messages pushed one at a time, ended on close. */
export function pushablePrompt() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    prompt: prompt(),
    send(message: SDKUserMessage) {
      queue.push(message);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

/** Bridge SDK `canUseTool` callbacks into turn `request` deltas with bounded JSON input. */
export function createSdkCanUseTool(state: {
  getTurn: () => SdkTurnSlot | undefined;
  isClosed: () => boolean;
}): CanUseTool {
  return (toolName, toolInput, options) =>
    new Promise<PermissionResult>((resolve) => {
      const turn = state.getTurn();
      if (turn === undefined || state.isClosed() || options.signal.aborted) {
        resolve({ behavior: 'deny', message: 'No turn is running to ask' });
        return;
      }
      const interactionId = randomUUID();
      const finish = (result: PermissionResult) => {
        options.signal.removeEventListener('abort', onToolAbort);
        resolve(result);
      };
      const onToolAbort = () => {
        answerEngineRequest(turn, interactionId, {
          behavior: 'deny',
          message: 'The tool request was aborted',
          interrupt: true,
        });
      };
      const callId = nonEmptyString(options.toolUseID);
      holdEngineRequest(turn, {
        interactionId,
        detail: { input: toolInput },
        answeredBy: SDK_ANSWER,
        delta: () => ({
          type: 'request',
          turnId: turn.state.turnId,
          itemId: `request:${interactionId}`,
          raw: { source: 'claude-sdk', type: 'canUseTool' },
          interactionId,
          kind: 'approval',
          toolName: nonEmptyString(toolName) ?? 'tool',
          ...(callId !== undefined && { callId }),
          input: safeJsonValue(toolInput),
        }),
        refusal: { behavior: 'deny', message: 'The turn was interrupted', interrupt: true },
        resolve: finish,
      });
      if (turn.pending.has(interactionId))
        options.signal.addEventListener('abort', onToolAbort, { once: true });
    });
}

/** The turn as the executor steers it: interrupt through the query, answer permissions. */
export function sdkTurnHandle(turn: SdkTurnSlot, query: ClaudeSdkRun): AgentEngineTurn {
  return {
    deltas: turn.channel,
    async interrupt() {
      turn.state.interruptRequested = true;
      drainEngineRequests(turn, stoppedPermission('The turn was interrupted'));
      await query.interrupt();
    },
    async respond(interactionId, rawReply) {
      const reply = InteractionReplySchema.shape.reply.parse(rawReply);
      const waiting = turn.pending.get(interactionId);
      if (waiting === undefined)
        throw new TypeError(`Unknown interaction ${interactionId} for this turn`);
      if (reply.kind === 'input') {
        throw new TypeError(
          'A Claude permission request is approved or denied, not answered with input',
        );
      }
      answerEngineRequest(
        turn,
        interactionId,
        reply.kind === 'approve'
          ? { behavior: 'allow', updatedInput: waiting.detail.input }
          : { behavior: 'deny', message: reply.message },
      );
    },
  };
}

/** Background drain loop routing one query's records to the active turn and limits map. */
export function runSdkQueryLoop(input: {
  handle: RunningQueryHandle;
  profileId: string;
  limits: Map<string, PlanLimits>;
  getTurn: () => SdkTurnSlot | undefined;
  clearTurn: () => void;
  onExit: (handle: RunningQueryHandle, error: unknown) => void;
}): void {
  void (async () => {
    try {
      for await (const record of input.handle.query) {
        const turn = input.getTurn();
        const verdict = classifyClaudeRecord(
          record,
          turn?.state ?? newClaudeTurnState('between-turns'),
        );
        if (verdict.kind === 'limits') {
          input.limits.set(
            input.profileId,
            mergeRateLimitEvent({
              previous: input.limits.get(input.profileId),
              windows: claudePlanWindows(verdict.info),
              now: new Date(),
            }),
          );
        } else if (verdict.kind === 'deltas') {
          for (const delta of verdict.deltas) offerTurnDelta(turn?.channel, delta);
        } else if (verdict.kind === 'end') {
          endEngineTurn(turn, stoppedPermission('The turn ended'), verdict.deltas);
          input.clearTurn();
        } else if (verdict.kind === 'unhandled') {
          offerTurnDelta(turn?.channel, verdict.delta);
        }
      }
      throw new Error('The Agent SDK query ended during the turn');
    } catch (error) {
      input.onExit(input.handle, error);
    }
  })();
}
