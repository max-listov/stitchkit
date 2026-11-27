import { randomUUID } from 'node:crypto';
import { abortReason } from '../../internal/abort-race';
import type { AgentEngineSession, AgentEngineTurn } from '../engine';
import { ENGINE_LINE_BYTES, type EngineProcess, spawnEngineProcess } from '../engine-process';
import {
  holdEngineRequest,
  interruptEngineTurn,
  loseEngineTurn,
  respondToEngineRequest,
} from '../engine-requests';
import type { PlanLimits } from '../hello';
import {
  assertImageFrameBytes,
  CLAUDE_CLI_MAX_LINE_BYTES,
  type DriverImageOptions,
  imageTurnStarter,
} from '../image-input';
import { type ExecutorProfileConfig, engineEnvironment, engineProfile } from '../profile';
import {
  createTurnDeltaChannel,
  emitStartupPhase,
  type ObserverErrorHandler,
  type SessionLiveness,
  sessionAbort,
  sessionLiveness,
  stopConnection,
} from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import { newClaudeTurnState } from './classify';
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
import { type ClaudeRoutedTurn, routeClaudeRecord } from './record-router';
import { claudeTranscriptExists, claudeTranscriptPath } from './transcript';

/** A running turn: its state, its deltas and the permission requests it holds, with their input. */
type ClaudeTurnSlot = ClaudeRoutedTurn<
  ClaudePermissionDecision,
  ClaudePendingPermissionDetail
>;

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
  liveness: SessionLiveness,
): AgentEngineTurn {
  return {
    deltas: turn.channel,
    interrupt: () =>
      interruptEngineTurn(turn, liveness, {
        refusal: () => INTERRUPTED,
        tell: () => send(JSON.stringify(claudeInterrupt(randomUUID()))),
      }),
    async respond(interactionId, rawReply) {
      respondToEngineRequest(turn, liveness, interactionId, (detail) =>
        resolveClaudePermissionReply(detail, rawReply),
      );
    },
  };
}

function startClaudeReadingLoop(state: {
  readonly engine: EngineProcess;
  readonly profileId: string;
  readonly limits: Map<string, PlanLimits>;
  readonly liveness: SessionLiveness;
  readonly getTurn: () => ClaudeTurnSlot | undefined;
  readonly clearTurn: (turn: ClaudeTurnSlot | undefined) => void;
  readonly onExit: (error: unknown) => void;
}): Promise<void> {
  const { engine, profileId, limits, liveness } = state;
  // A lost or stopped CLI reads nothing: nothing is written to it.
  const send = (record: unknown) => {
    if (liveness.isAlive()) engine.send(JSON.stringify(record));
  };
  // One reader for the life of the process: records between turns
  // (limits, the session's own) are applied, a turn's go to its channel.
  return (async () => {
    try {
      for await (const line of engine.lines) {
        if (!liveness.isAlive()) continue;
        routeClaudeRecord(JSON.parse(line), {
          turn: state.getTurn(),
          profileId,
          limits,
          ended: () => ENDED,
          clearTurn: state.clearTurn,
          onRequest(turn, { delta, input, toolName, suppressSessionRule }) {
            const answer = (decision: ClaudePermissionDecision) =>
              send(claudePermissionResponse(delta.interactionId, decision));
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
          },
          onRefuse: (refuse) => send(claudeControlError(refuse.requestId, refuse.message)),
        });
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
    onObserverError?: ObserverErrorHandler;
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
  emitStartupPhase(input.onStartupPhase, 'spawning', config.onObserverError);
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
  const liveness = sessionLiveness({
    closedMessage: 'The Claude CLI session is closed',
    caller: input.signal,
    linked: linked.signal,
  });
  const settleTurn = (reason: unknown) => {
    const turn = current;
    current = undefined;
    loseEngineTurn(turn, () => LOST, reason);
  };
  linked.signal.addEventListener(
    'abort',
    () => {
      if (liveness.closing || liveness.lost !== undefined) return;
      settleTurn(abortReason(linked.signal));
    },
    { once: true },
  );
  const reading = startClaudeReadingLoop({
    engine,
    profileId: profile.profileId,
    limits,
    liveness,
    getTurn: () => current,
    clearTurn: (turn) => {
      if (current === turn) current = undefined;
    },
    onExit: (error) => {
      // A session already closing or aborted by its caller ended for that reason, not this one.
      const stop =
        liveness.closing || liveness.abortedByCaller ? liveness.stopped() : undefined;
      if (stop !== undefined) {
        settleTurn(stop.reason);
        return;
      }
      const failed = error instanceof Error ? error : new Error(String(error));
      liveness.markLost(failed);
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
      liveness.ensureAlive();
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
        if (current === turn) current = undefined;
        throw error;
      }
      return claudeTurnHandle(turn, (line) => engine.send(line), liveness);
    },
  });
  const close = createClaudeSessionClose({
    engine,
    reading,
    markClosing: () => liveness.markClosing(),
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
