import { randomUUID } from 'node:crypto';
import { abortReason } from '../../internal/abort-race';
import type { AgentEngineSession, AgentEngineTurn } from '../engine';
import { ENGINE_LINE_BYTES, type EngineProcess, spawnEngineProcess } from '../engine-process';
import {
  answerEngineRequest,
  drainEngineRequests,
  type EngineRequestTurn,
  endEngineTurn,
  holdEngineRequest,
  loseEngineTurn,
} from '../engine-requests';
import type { PlanLimits } from '../hello';
import {
  assertImageFrameBytes,
  CLAUDE_CLI_MAX_LINE_BYTES,
  type DriverImageOptions,
  imageTurnStarter,
} from '../image-input';
import { mergeRateLimitEvent } from '../plan-limits';
import { type ExecutorProfileConfig, engineEnvironment, engineProfile } from '../profile';
import {
  createTurnDeltaChannel,
  emitStartupPhase,
  offerTurnDelta,
  sessionAbort,
  stopConnection,
} from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import { type ClaudeTurnState, classifyClaudeRecord, newClaudeTurnState } from './classify';
import { claudePlanWindows } from './limits';
import {
  type ClaudePendingPermissionDetail,
  type ClaudePermissionDecision,
  claudeControlError,
  claudeInterrupt,
  claudePermissionResponse,
  claudeUserContent,
  claudeUserMessage,
  resolveClaudePermissionReply,
} from './protocol';
import { claudeTranscriptExists, claudeTranscriptPath } from './transcript';

/** A running turn: its state, its deltas and the permission requests it holds, with their input. */
interface ClaudeTurnSlot
  extends EngineRequestTurn<ClaudePermissionDecision, ClaudePendingPermissionDetail> {
  readonly state: ClaudeTurnState;
  settled: boolean;
}

const INTERRUPTED: ClaudePermissionDecision = {
  behavior: 'deny',
  message: 'The turn was interrupted',
};
const ENDED: ClaudePermissionDecision = { behavior: 'deny', message: 'The turn ended' };
const LOST: ClaudePermissionDecision = {
  behavior: 'deny',
  message: 'The Claude CLI was lost',
};

function claudeTurnHandle(
  turn: ClaudeTurnSlot,
  send: (line: string) => void,
  ensureAlive: () => void,
): AgentEngineTurn {
  return {
    deltas: turn.channel,
    async interrupt() {
      if (turn.settled) return;
      try {
        ensureAlive();
      } catch {
        return;
      }
      turn.state.interruptRequested = true;
      drainEngineRequests(turn, () => INTERRUPTED);
      send(JSON.stringify(claudeInterrupt(randomUUID())));
    },
    async respond(interactionId, rawReply) {
      ensureAlive();
      const waiting = turn.pending.get(interactionId);
      if (waiting === undefined) {
        throw new TypeError(`Unknown interaction ${interactionId} for this turn`);
      }
      answerEngineRequest(
        turn,
        interactionId,
        resolveClaudePermissionReply(waiting.detail, rawReply),
      );
    },
  };
}

function startClaudeReadingLoop(state: {
  readonly engine: EngineProcess;
  readonly profileId: string;
  readonly limits: Map<string, PlanLimits>;
  readonly isStopped: () => boolean;
  readonly getDead: () => Error | undefined;
  readonly getTurn: () => ClaudeTurnSlot | undefined;
  readonly clearTurn: (turn: ClaudeTurnSlot | undefined) => void;
  readonly onExit: (error: unknown) => void;
}): Promise<void> {
  const { engine, profileId, limits } = state;
  // One reader for the life of the process: records between turns
  // (limits, the session's own) are applied, a turn's go to its channel.
  return (async () => {
    try {
      for await (const line of engine.lines) {
        if (state.isStopped()) continue;
        const turn = state.getTurn();
        const verdict = classifyClaudeRecord(
          JSON.parse(line),
          turn?.state ?? newClaudeTurnState('between-turns'),
        );
        switch (verdict.kind) {
          case 'limits':
            limits.set(
              profileId,
              mergeRateLimitEvent({
                previous: limits.get(profileId),
                windows: claudePlanWindows(verdict.info),
                now: new Date(),
              }),
            );
            break;
          case 'deltas':
            for (const delta of verdict.deltas) offerTurnDelta(turn?.channel, delta);
            break;
          case 'request': {
            const { delta, input, toolName, suppressSessionRule } = verdict;
            // A lost or stopped CLI reads nothing: the answer a drain gives it is not written.
            const answer = (decision: ClaudePermissionDecision) => {
              if (!state.isStopped() && state.getDead() === undefined)
                engine.send(
                  JSON.stringify(claudePermissionResponse(delta.interactionId, decision)),
                );
            };
            // Between turns nobody can be asked; the CLI is not left waiting either way.
            if (turn === undefined)
              answer({ behavior: 'deny', message: 'No turn is running to ask' });
            else
              holdEngineRequest(turn, {
                interactionId: delta.interactionId,
                detail: { input, toolName, suppressSessionRule },
                answeredBy: { source: 'claude', type: 'control_response' },
                delta: () => delta,
                refusal: INTERRUPTED,
                resolve: answer,
              });
            break;
          }
          case 'unhandled':
            offerTurnDelta(turn?.channel, verdict.delta);
            if (verdict.refuse !== undefined && !state.isStopped())
              engine.send(
                JSON.stringify(
                  claudeControlError(verdict.refuse.requestId, verdict.refuse.message),
                ),
              );
            break;
          case 'end':
            if (turn !== undefined) turn.settled = true;
            endEngineTurn(turn, () => ENDED, verdict.deltas);
            state.clearTurn(turn);
            break;
          case 'event':
          case 'session':
          case 'ignore':
            break;
        }
      }
      state.onExit(
        new Error(
          `The Claude CLI exited during the turn: ${engine.stderrTail().slice(-2000)}`,
        ),
      );
    } catch (error) {
      state.onExit(error);
      await engine.stop().catch(() => undefined);
    }
  })();
}

function createClaudeSessionClose(state: {
  readonly engine: EngineProcess;
  readonly reading: Promise<void>;
  readonly markClosing: () => void;
  readonly settleTurn: (reason: unknown) => void;
  readonly abortLinked: () => void;
  readonly releaseLinked: () => void;
}): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    if (closePromise !== undefined) return closePromise;
    state.markClosing();
    state.settleTurn(new Error('The Claude CLI session is closed'));
    state.abortLinked();
    closePromise = stopConnection({ engine: state.engine, reading: state.reading }).finally(
      () => {
        state.releaseLinked();
      },
    );
    return closePromise;
  };
}

/**
 * One Claude Code process for one connection: spawned with the session's
 * flags, read by one loop for its whole life, each turn's records routed to
 * the turn running at the time.
 */
export async function openClaudeSession(
  config: DriverImageOptions & {
    executable: string;
    prefix: readonly string[];
    model?: string;
    permissionMode: string;
    ambient: Readonly<Record<string, string | undefined>>;
    limits: Map<string, PlanLimits>;
  },
  input: {
    profile: ExecutorProfileConfig;
    cwd: string;
    nativeThreadId?: string | undefined;
    onStartupPhase?: ((phase: ExecutorStartupPhase) => void) | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<AgentEngineSession> {
  const { executable, prefix, ambient, limits } = config;
  const profile = engineProfile('claude-cli', input.profile, ambient);
  input.signal?.throwIfAborted();
  const env = engineEnvironment(profile, ambient);
  const sessionId = input.nativeThreadId ?? randomUUID();
  const transcript = claudeTranscriptPath({ home: profile.home, cwd: input.cwd, sessionId });
  const resume =
    input.nativeThreadId !== undefined && (await claudeTranscriptExists(transcript));
  const linked = sessionAbort(input.signal);
  let engine: EngineProcess;
  emitStartupPhase(input.onStartupPhase, 'spawning');
  try {
    linked.signal.throwIfAborted();
    engine = spawnEngineProcess({
      executable,
      args: [
        ...prefix,
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--replay-user-messages',
        '--verbose',
        '--permission-prompts',
        'host',
        '--permission-prompt-tool',
        'stdio',
        '--permission-mode',
        config.permissionMode,
        ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
        ...(config.model !== undefined ? ['--model', config.model] : []),
      ],
      cwd: input.cwd,
      env,
      signal: linked.signal,
      maxLineBytes: CLAUDE_CLI_MAX_LINE_BYTES,
    });
  } catch (error) {
    linked.release();
    throw error;
  }
  let current: ClaudeTurnSlot | undefined;
  let dead: Error | undefined;
  let closing = false;
  const isStopped = () => closing || input.signal?.aborted === true || linked.signal.aborted;
  const ensureAlive = () => {
    if (closing) throw new Error('The Claude CLI session is closed');
    if (dead !== undefined) throw dead;
    if (input.signal?.aborted) throw abortReason(input.signal);
    if (linked.signal.aborted) throw abortReason(linked.signal);
  };
  const settleTurn = (reason: unknown) => {
    const turn = current;
    current = undefined;
    if (turn !== undefined) turn.settled = true;
    loseEngineTurn(turn, () => LOST, reason);
  };
  linked.signal.addEventListener(
    'abort',
    () => {
      if (closing || dead !== undefined) return;
      settleTurn(abortReason(linked.signal));
    },
    { once: true },
  );
  const reading = startClaudeReadingLoop({
    engine,
    profileId: profile.profileId,
    limits,
    isStopped,
    getDead: () => dead,
    getTurn: () => current,
    clearTurn: (turn) => {
      if (current === turn) current = undefined;
    },
    onExit: (error) => {
      if (closing) {
        settleTurn(new Error('The Claude CLI session is closed'));
        return;
      }
      if (input.signal?.aborted) {
        settleTurn(abortReason(input.signal));
        return;
      }
      const failed = error instanceof Error ? error : new Error(String(error));
      dead = failed;
      settleTurn(failed);
      // The session is over: nothing follows the caller's signal any more.
      linked.abort();
    },
  });
  const startTurn = imageTurnStarter<
    Parameters<AgentEngineSession['startTurn']>[0],
    AgentEngineTurn
  >({
    driverLabel: 'The Claude CLI driver',
    busyMessage: 'A turn is already running in this Claude session',
    imageOptions: config,
    signal: linked.signal,
    check() {
      ensureAlive();
      if (current !== undefined)
        throw new Error('A turn is already running in this Claude session');
    },
    dispatch(turnInput, parts) {
      // Total outgoing JSON frame is capped at ENGINE_LINE_BYTES (8 MiB), even if maxImageBytes is higher;
      // stdout uses CLAUDE_CLI_MAX_LINE_BYTES (16 MiB) for `--replay-user-messages` echo headroom.
      const serialized = JSON.stringify(
        claudeUserMessage({
          clientId: turnInput.clientId,
          content: claudeUserContent(parts),
          sessionId,
        }),
      );
      assertImageFrameBytes(serialized, ENGINE_LINE_BYTES);
      const turn: ClaudeTurnSlot = {
        state: newClaudeTurnState(turnInput.turnId),
        channel: createTurnDeltaChannel(),
        pending: new Map(),
        settled: false,
      };
      current = turn;
      try {
        engine.send(serialized);
      } catch (error) {
        turn.settled = true;
        if (current === turn) current = undefined;
        throw error;
      }
      return claudeTurnHandle(turn, (line) => engine.send(line), ensureAlive);
    },
  });
  const close = createClaudeSessionClose({
    engine,
    reading,
    markClosing: () => {
      closing = true;
    },
    settleTurn,
    abortLinked: () => linked.abort(),
    releaseLinked: () => linked.release(),
  });
  return {
    nativeThreadId: sessionId,
    startTurn,
    close,
  };
}
