import {
  type EngineRequestTurn,
  endEngineTurn,
  holdEngineRequest,
  loseEngineTurn,
} from '../engine-requests';
import type { InteractionReply } from '../executor-contract';
import type { ExecutorEngine, PlanLimits } from '../hello';
import { mergeRateLimitEvent } from '../plan-limits';
import { offerTurnDelta } from '../session-primitives';
import type { ReplayGate } from './replay-gate';
import type { ExecutorReplayStep, ExecutorReplayTranscript } from './replay-transcript';

const DENY_ENDED: InteractionReply['reply'] = { kind: 'deny', message: 'The turn ended' };
const DENY_FAILED: InteractionReply['reply'] = {
  kind: 'deny',
  message: 'The replay engine failed',
};

export interface ReplayTurnSlot
  extends EngineRequestTurn<InteractionReply['reply'], { readonly interactionId: string }> {
  readonly turnId: string;
  readonly hostAnswered: Set<string>;
  readonly interruptWaiters: Array<() => void>;
  readonly replyPromises: Map<string, Promise<InteractionReply['reply']>>;
}

function emitSimpleStep(
  step: Extract<ExecutorReplayStep, { kind: 'emit' }>,
  turn: ReplayTurnSlot,
  stepIndex: number,
  source: string,
): boolean {
  const raw = { source, type: `replay/${step.block}` };
  const itemId = step.itemId ?? `${step.block}:${stepIndex}`;
  switch (step.block) {
    case 'text':
      offerTurnDelta(turn.channel, {
        type: 'text',
        text: step.text,
        turnId: turn.turnId,
        itemId,
        raw,
      });
      return false;
    case 'reasoning':
      offerTurnDelta(turn.channel, {
        type: 'reasoning',
        text: step.text,
        turnId: turn.turnId,
        itemId,
        raw,
      });
      return false;
    case 'tool-call':
      offerTurnDelta(turn.channel, {
        type: 'tool-call',
        callId: step.callId,
        toolName: step.toolName,
        input: step.input,
        turnId: turn.turnId,
        itemId,
        raw,
      });
      return false;
    case 'tool-result':
      offerTurnDelta(turn.channel, {
        type: 'tool-result',
        callId: step.callId,
        toolName: step.toolName,
        outcome: step.outcome,
        ...(step.output !== undefined && { output: step.output }),
        turnId: turn.turnId,
        itemId,
        raw,
      });
      return false;
    case 'status':
      offerTurnDelta(turn.channel, {
        type: 'status',
        phase: step.phase,
        turnId: turn.turnId,
        itemId,
        raw,
      });
      return false;
    case 'window':
      offerTurnDelta(turn.channel, {
        type: 'window',
        reset: step.reset,
        turnId: turn.turnId,
        itemId,
        raw,
      });
      return false;
    case 'error':
      offerTurnDelta(turn.channel, {
        type: 'error',
        kind: step.errorKind,
        message: step.message,
        turnId: turn.turnId,
        itemId,
        raw,
      });
      return false;
    case 'turn-end': {
      const outcome = turn.state.interruptRequested ? 'interrupted' : step.outcome;
      endEngineTurn(turn, () => DENY_ENDED, [
        {
          type: 'turn-end',
          outcome,
          ...(step.threadDisposition !== undefined && {
            threadDisposition: step.threadDisposition,
          }),
          turnId: turn.turnId,
          itemId,
          raw,
        },
      ]);
      return true;
    }
  }
}

/** Yield turn-loop ticks so consumer `for await` drains buffered deltas before a terminal crash fails the channel. */
async function flushQueuedDeltasBeforeFailure(
  turn: ReplayTurnSlot,
  signal: AbortSignal,
): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    if (signal.aborted || turn.channel.getSnapshot().queuedItems === 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export interface ReplayTurnRunnerContext {
  readonly script: ExecutorReplayTranscript;
  readonly turn: ReplayTurnSlot;
  readonly engine: ExecutorEngine;
  readonly profileId: string;
  readonly limits: Map<string, PlanLimits>;
  readonly answeredIds: Set<string>;
  readonly consumedReplies: Set<ExecutorReplayStep>;
  readonly gate?: ReplayGate;
  readonly signal: AbortSignal;
  readonly onTurnCompleted: () => void;
  readonly clearActiveTurn: () => void;
}

export async function runReplayTurnScript(context: ReplayTurnRunnerContext): Promise<void> {
  const { script, turn, engine, signal } = context;
  let ended = false;
  try {
    // Allow `startTurn()` to return and the consumer's `for await` reader to attach first.
    await Promise.resolve();
    for (let index = 0; index < script.steps.length; index += 1) {
      const step = script.steps[index];
      if (step === undefined) continue;
      if (signal.aborted) throw new Error('Replay session aborted');
      if (step.kind === 'emit') {
        ended = emitSimpleStep(step, turn, index, engine);
        if (ended) break;
        continue;
      }
      if (step.kind === 'gate') {
        await context.gate?.beforeEmit(step.label, signal);
        continue;
      }
      if (step.kind === 'waitInterrupt') {
        if (!turn.state.interruptRequested) {
          await new Promise<void>((resolve) => {
            const onAbort = () => resolve();
            signal.addEventListener('abort', onAbort, { once: true });
            turn.interruptWaiters.push(() => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            });
          });
        }
        continue;
      }
      if (step.kind === 'request') {
        turn.hostAnswered.delete(step.interactionId);
        const replyPromise = new Promise<InteractionReply['reply']>((resolve) => {
          holdEngineRequest(turn, {
            interactionId: step.interactionId,
            detail: { interactionId: step.interactionId },
            answeredBy: { source: engine, type: 'replay/request' },
            delta: () => ({
              type: 'request',
              turnId: turn.turnId,
              itemId: step.itemId ?? `request:${step.interactionId}`,
              raw: { source: engine, type: 'replay/request' },
              interactionId: step.interactionId,
              kind: step.requestKind,
              ...(step.callId !== undefined && { callId: step.callId }),
              ...(step.toolName !== undefined && { toolName: step.toolName }),
              ...(step.input !== undefined && { input: step.input }),
              ...(step.prompt !== undefined && { prompt: step.prompt }),
            }),
            refusal: { kind: 'deny', message: 'The turn was interrupted' },
            resolve: (reply) => {
              context.answeredIds.add(step.interactionId);
              resolve(reply);
            },
          });
        });
        turn.replyPromises.set(step.interactionId, replyPromise);
        continue;
      }
      if (step.kind === 'expectReply') {
        const pendingReply = turn.replyPromises.get(step.interactionId);
        if (pendingReply === undefined) {
          throw new Error(
            `Replay expectReply(${step.interactionId}) has no matching preceding request`,
          );
        }
        const reply = await pendingReply;
        turn.replyPromises.delete(step.interactionId);
        if (signal.aborted) throw new Error('Replay session aborted');
        if (
          !turn.state.interruptRequested &&
          step.replyKind !== undefined &&
          reply.kind !== step.replyKind
        ) {
          throw new Error(
            `Replay expectReply(${step.interactionId}) expected ${step.replyKind}, got ${reply.kind}`,
          );
        }
        if (
          !turn.state.interruptRequested &&
          step.scope !== undefined &&
          (reply.kind !== 'approve' || reply.scope !== step.scope)
        ) {
          throw new Error(
            `Replay expectReply(${step.interactionId}) expected scope ${step.scope}`,
          );
        }
        if (turn.hostAnswered.delete(step.interactionId)) context.consumedReplies.add(step);
        continue;
      }
      if (step.kind === 'usage') {
        offerTurnDelta(turn.channel, {
          type: 'usage',
          turnId: turn.turnId,
          itemId: step.itemId ?? `usage:${index}`,
          raw: { source: engine, type: 'replay/usage' },
          ...(step.inputTokens !== undefined && { inputTokens: step.inputTokens }),
          ...(step.outputTokens !== undefined && { outputTokens: step.outputTokens }),
          ...(step.cachedInputTokens !== undefined && {
            cachedInputTokens: step.cachedInputTokens,
          }),
          ...(step.cacheCreationInputTokens !== undefined && {
            cacheCreationInputTokens: step.cacheCreationInputTokens,
          }),
          ...(step.thinkingTokens !== undefined && { thinkingTokens: step.thinkingTokens }),
          ...(step.totalTokens !== undefined && { totalTokens: step.totalTokens }),
          ...(step.costUsd !== undefined && { costUsd: step.costUsd }),
        });
        continue;
      }
      if (step.kind === 'contextUsage') {
        offerTurnDelta(turn.channel, {
          type: 'context-usage',
          turnId: turn.turnId,
          itemId: step.itemId ?? `context-usage:${index}`,
          raw: { source: engine, type: 'replay/context-usage' },
          usedTokens: step.usedTokens,
          windowTokens: step.windowTokens,
        });
        continue;
      }
      if (step.kind === 'rateLimit') {
        context.limits.set(
          context.profileId,
          mergeRateLimitEvent({
            previous: context.limits.get(context.profileId),
            windows: step.windows,
            now: new Date(),
          }),
        );
        continue;
      }
      if (step.kind === 'unknownRecord') {
        offerTurnDelta(turn.channel, {
          type: 'error',
          turnId: turn.turnId,
          itemId: `unhandled:${index}`,
          raw: { source: engine, type: step.recordType ?? 'replay/unknown' },
          kind: 'unhandled',
          message: step.message ?? 'Unknown replay record',
        });
        continue;
      }
      await flushQueuedDeltasBeforeFailure(turn, signal);
      if (step.kind === 'invalidLine') {
        throw new Error(`Invalid replay line: ${step.rawLine ?? '<malformed>'}`);
      }
      if (step.kind === 'eofWithoutResult') {
        throw new Error('Replay engine reached EOF without a turn-end result');
      }
      throw new Error(step.message ?? 'Replay engine crashed');
    }
    if (!ended) {
      await flushQueuedDeltasBeforeFailure(turn, signal);
      throw new Error('Replay transcript ended without emitting turn-end');
    }
    context.onTurnCompleted();
  } catch (error) {
    const failed = error instanceof Error ? error : new Error(String(error));
    loseEngineTurn(turn, () => DENY_FAILED, failed);
  } finally {
    context.clearActiveTurn();
  }
}
