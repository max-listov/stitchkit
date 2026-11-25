import { randomUUID } from 'node:crypto';
import type {
  CanUseTool,
  PermissionResult,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { abortReason } from '../../internal/abort-race';
import {
  type ClaudeTurnState,
  classifyClaudeRecord,
  newClaudeTurnState,
} from '../claude/classify';
import { claudePlanWindows } from '../claude/limits';
import { claudeTranscriptExists, claudeTranscriptPath } from '../claude/transcript';
import type { AgentEngineDriver, AgentEngineSession, AgentEngineTurn } from '../engine';
import {
  answerEngineRequest,
  drainEngineRequests,
  type EngineRequestTurn,
  endEngineTurn,
  holdEngineRequest,
  loseEngineTurn,
} from '../engine-requests';
import { InteractionReplySchema } from '../executor-contract';
import type { PlanLimits } from '../hello';
import { mergeRateLimitEvent } from '../plan-limits';
import { engineEnvironment, engineProfile } from '../profile';
import {
  createTurnDeltaChannel,
  extractTextOnlyInput,
  nonEmptyString,
  offerTurnDelta,
  safeJsonValue,
  sessionAbort,
} from '../session-primitives';
import type { ClaudeSdkDriverConfig, ClaudeSdkRun } from './driver';

type Uuid = `${string}-${string}-${string}-${string}-${string}`;
/** The SDK keys a user message by a UUID; a client id of another form is refused, not coerced. */
function isUuid(value: string): value is Uuid {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** A running turn: its state, its deltas and the `canUseTool` calls it holds, with their input. */
interface SdkTurnSlot
  extends EngineRequestTurn<PermissionResult, { input: Record<string, unknown> }> {
  readonly state: ClaudeTurnState;
}

const SDK_ANSWER = { source: 'claude-sdk', type: 'PermissionResult' };

/** The answer to every `canUseTool` call a stopped turn still holds: deny, and interrupt the SDK's turn. */
const stoppedPermission = (message: string) => (): PermissionResult => ({
  behavior: 'deny',
  message,
  interrupt: true,
});

/** Invoke `query.close?.()` while containing synchronous throws and async rejections. */
function closeQuerySafely(query: ClaudeSdkRun | undefined): void {
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
function pushablePrompt() {
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
function createSdkCanUseTool(state: {
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
      // Only a request still held has an answer the tool's abort can give; one refused at
      // once, or one whose delta could not be built, holds no listener.
      if (turn.pending.has(interactionId))
        options.signal.addEventListener('abort', onToolAbort, { once: true });
    });
}

/** The turn as the executor steers it: interrupt through the query, answer permissions. */
function sdkTurnHandle(turn: SdkTurnSlot, query: ClaudeSdkRun): AgentEngineTurn {
  return {
    deltas: turn.channel,
    async interrupt() {
      turn.state.interruptRequested = true;
      // A permission the SDK still waits on would hold the interrupt back.
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

/**
 * One Claude session over Agent SDK queries. A query lives until it breaks;
 * a broken one fails its turn, and the next turn opens a new query that
 * resumes the session.
 */
export async function openClaudeSdkSession(
  config: ClaudeSdkDriverConfig,
  limits: Map<string, PlanLimits>,
  input: Parameters<AgentEngineDriver['open']>[0],
): Promise<AgentEngineSession> {
  const ambient = config.ambient ?? process.env;
  const profile = engineProfile('claude-sdk', input.profile);
  input.signal?.throwIfAborted();
  const sessionId = input.nativeThreadId ?? randomUUID();
  const transcript = claudeTranscriptPath({ home: profile.home, cwd: input.cwd, sessionId });
  let resume =
    input.nativeThreadId !== undefined && (await claudeTranscriptExists(transcript));
  let current: SdkTurnSlot | undefined;
  let closed = false;
  let running:
    | { query: ClaudeSdkRun; send(message: SDKUserMessage): void; close(): void }
    | undefined;
  const shutdown = (reason: unknown) => {
    closed = true;
    const turn = current;
    current = undefined;
    loseEngineTurn(turn, stoppedPermission('The session was closed'), reason);
    const active = running;
    running = undefined;
    active?.close();
  };
  const linked = sessionAbort(input.signal);
  // The caller's abort ends the session with the caller's reason; `close()` detaches first.
  linked.signal.addEventListener('abort', () => shutdown(abortReason(linked.signal)), {
    once: true,
  });
  const canUseTool = createSdkCanUseTool({
    getTurn: () => current,
    isClosed: () => closed,
  });
  const start = () => {
    const pushed = pushablePrompt();
    const query = config.query({
      prompt: pushed.prompt,
      options: {
        cwd: input.cwd,
        env: engineEnvironment(profile, ambient),
        includePartialMessages: true,
        permissionMode: config.permissionMode ?? 'default',
        canUseTool,
        ...(config.model !== undefined && { model: config.model }),
        ...(resume ? { resume: sessionId } : { sessionId }),
      },
    });
    let closedOnce = false;
    const closeHandle = () => {
      if (closedOnce) return;
      closedOnce = true;
      pushed.end();
      closeQuerySafely(query);
    };
    const handle = { query, send: pushed.send, close: closeHandle };
    running = handle;
    resume = true;
    void (async () => {
      try {
        for await (const record of query) {
          const turn = current;
          const verdict = classifyClaudeRecord(
            record,
            turn?.state ?? newClaudeTurnState('between-turns'),
          );
          if (verdict.kind === 'limits') {
            limits.set(
              profile.profileId,
              mergeRateLimitEvent({
                previous: limits.get(profile.profileId),
                windows: claudePlanWindows(verdict.info),
                now: new Date(),
              }),
            );
          } else if (verdict.kind === 'deltas') {
            for (const delta of verdict.deltas) offerTurnDelta(turn?.channel, delta);
          } else if (verdict.kind === 'end') {
            endEngineTurn(turn, stoppedPermission('The turn ended'), verdict.deltas);
            current = undefined;
          } else if (verdict.kind === 'unhandled') {
            offerTurnDelta(turn?.channel, verdict.delta);
          }
        }
        throw new Error('The Agent SDK query ended during the turn');
      } catch (error) {
        const ownsSession = running === handle;
        const turn = ownsSession ? current : undefined;
        if (ownsSession) {
          running = undefined;
          current = undefined;
        }
        loseEngineTurn(turn, stoppedPermission('The Claude SDK query ended'), error);
        closeHandle();
      }
    })();
    return handle;
  };
  return {
    nativeThreadId: sessionId,
    async startTurn(turnInput): Promise<AgentEngineTurn> {
      if (closed) throw new Error('The Claude SDK session is closed');
      if (current !== undefined)
        throw new Error('A turn is already running in this Claude session');
      const text = extractTextOnlyInput(turnInput.input, 'The Agent SDK driver');
      const clientId = turnInput.clientId;
      if (!isUuid(clientId))
        throw new TypeError('The Agent SDK driver needs a UUID client id');
      const turn: SdkTurnSlot = {
        state: newClaudeTurnState(turnInput.turnId),
        channel: createTurnDeltaChannel(),
        pending: new Map(),
      };
      current = turn;
      try {
        // A broken query is not reused: the next turn reinitializes and resumes the session.
        const active = running ?? start();
        active.send({
          type: 'user',
          message: { role: 'user', content: text },
          parent_tool_use_id: null,
          uuid: clientId,
          session_id: sessionId,
        });
        return sdkTurnHandle(turn, active.query);
      } catch (error) {
        if (current === turn) current = undefined;
        throw error;
      }
    },
    async close() {
      linked.release();
      shutdown(new Error('The Claude SDK session closed'));
    },
  };
}
