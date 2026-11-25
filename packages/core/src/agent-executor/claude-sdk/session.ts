import { randomUUID } from 'node:crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { abortReason } from '../../internal/abort-race';
import { newClaudeTurnState } from '../claude/classify';
import { claudeUserContent } from '../claude/protocol';
import { claudeTranscriptExists, claudeTranscriptPath } from '../claude/transcript';
import type { AgentEngineDriver, AgentEngineSession, AgentEngineTurn } from '../engine';
import { loseEngineTurn } from '../engine-requests';
import type { PlanLimits } from '../hello';
import { imageTurnStarter } from '../image-input';
import { engineEnvironment, engineProfile } from '../profile';
import { createTurnDeltaChannel, sessionAbort } from '../session-primitives';
import { type ClaudeSdkFlagSettings, createClaudeSdkControls } from './controls';
import type { ClaudeSdkDriverConfig, ClaudeSdkRun, ClaudeSdkSession } from './driver';
import {
  closeQuerySafely,
  createSdkCanUseTool,
  pushablePrompt,
  type RunningQueryHandle,
  runSdkQueryLoop,
  type SdkTurnSlot,
  sdkTurnHandle,
  stoppedPermission,
} from './query-loop';
import {
  buildClaudeSdkQueryOptions,
  hasDelegationVerification,
  replayClaudeSdkFlagSettings,
  verifyClaudeSdkDelegation,
} from './query-options';

type Uuid = `${string}-${string}-${string}-${string}-${string}`;
/** The SDK keys a user message by a UUID; a client id of another form is refused, not coerced. */
function isUuid(value: string): value is Uuid {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Build the `startTurn` dispatcher for one Claude SDK session, enforcing single-turn concurrency. */
function createSdkStartTurn(input: {
  config: ClaudeSdkDriverConfig;
  sessionId: string;
  signal: AbortSignal;
  isClosed: () => boolean;
  getTurn: () => SdkTurnSlot | undefined;
  setTurn: (turn: SdkTurnSlot | undefined) => void;
  isStarting: () => boolean;
  setStarting: (value: boolean) => void;
  markResumable: () => void;
  ensureQuery: (startLoopImmediately: boolean) => Promise<RunningQueryHandle>;
}) {
  return imageTurnStarter<Parameters<AgentEngineSession['startTurn']>[0], AgentEngineTurn>({
    driverLabel: 'The Agent SDK driver',
    busyMessage: 'A turn is already running in this Claude session',
    imageOptions: input.config,
    signal: input.signal,
    check(turnInput) {
      if (input.isClosed()) throw new Error('The Claude SDK session is closed');
      if (input.getTurn() !== undefined || input.isStarting())
        throw new Error('A turn is already running in this Claude session');
      if (!isUuid(turnInput.clientId))
        throw new TypeError('The Agent SDK driver needs a UUID client id');
    },
    async dispatch(turnInput, parts) {
      const clientId = turnInput.clientId;
      if (!isUuid(clientId))
        throw new TypeError('The Agent SDK driver needs a UUID client id');
      input.setStarting(true);
      let active: RunningQueryHandle;
      try {
        // Defer loop start until `current` is bound so a query calling `canUseTool` on its first
        // step always sees the active turn.
        active = await input.ensureQuery(false);
      } finally {
        input.setStarting(false);
      }
      if (input.isClosed()) throw new Error('The Claude SDK session is closed');
      if (input.getTurn() !== undefined)
        throw new Error('A turn is already running in this Claude session');
      const turn: SdkTurnSlot = {
        state: newClaudeTurnState(turnInput.turnId),
        channel: createTurnDeltaChannel(),
        pending: new Map(),
      };
      input.setTurn(turn);
      try {
        active.send({
          type: 'user',
          message: { role: 'user', content: claudeUserContent(parts) },
          parent_tool_use_id: null,
          uuid: clientId,
          session_id: input.sessionId,
        });
        input.markResumable();
        active.startLoop();
        return sdkTurnHandle(turn, active.query);
      } catch (error) {
        if (input.getTurn() === turn) input.setTurn(undefined);
        throw error;
      }
    },
  });
}

/** Launch, verify, and replay live settings for one Claude SDK query handle. */
async function launchSingleSdkQuery(input: {
  config: ClaudeSdkDriverConfig;
  cwd: string;
  env: Record<string, string>;
  profileId: string;
  limits: Map<string, PlanLimits>;
  sessionId: string;
  resume: boolean;
  activeModel: string | undefined;
  activePermissionMode: NonNullable<Options['permissionMode']>;
  flagSettingsOverlay: ClaudeSdkFlagSettings | undefined;
  signal: AbortSignal;
  canUseTool: NonNullable<Options['canUseTool']>;
  isClosed: () => boolean;
  getTurn: () => SdkTurnSlot | undefined;
  clearTurn: () => void;
  setInFlightClose: (fn: (() => void) | undefined) => void;
  recordPid: (pid: number | undefined) => void;
  onPidExit: (pid: number) => void;
  onExit: (handle: RunningQueryHandle, error: unknown) => void;
}): Promise<RunningQueryHandle> {
  if (input.isClosed()) throw new Error('The Claude SDK session is closed');
  input.signal.throwIfAborted();
  const pushed = pushablePrompt();
  let query: ClaudeSdkRun;
  try {
    query = input.config.query({
      prompt: pushed.prompt,
      options: buildClaudeSdkQueryOptions({
        config: input.config,
        cwd: input.cwd,
        env: input.env,
        canUseTool: input.canUseTool,
        sessionId: input.sessionId,
        resume: input.resume,
        activeModel: input.activeModel,
        activePermissionMode: input.activePermissionMode,
        recordPid: input.recordPid,
        onPidExit: input.onPidExit,
      }),
    });
  } catch (error) {
    input.recordPid(undefined);
    pushed.end();
    throw error;
  }
  let closedOnce = false;
  let loopStarted = false;
  const closeHandle = () => {
    if (closedOnce) return;
    closedOnce = true;
    pushed.end();
    closeQuerySafely(query);
  };
  const handle: RunningQueryHandle = {
    query,
    send: pushed.send,
    startLoop() {
      if (loopStarted || closedOnce) return;
      loopStarted = true;
      runSdkQueryLoop({
        handle,
        profileId: input.profileId,
        limits: input.limits,
        getTurn: input.getTurn,
        clearTurn: input.clearTurn,
        onExit: input.onExit,
      });
    },
    close: closeHandle,
  };
  input.setInFlightClose(closeHandle);
  try {
    if (hasDelegationVerification(input.config.verifyDelegation)) {
      await verifyClaudeSdkDelegation(query, input.config.verifyDelegation, input.signal);
    }
    if (input.flagSettingsOverlay !== undefined) {
      await replayClaudeSdkFlagSettings(query, input.flagSettingsOverlay, input.signal);
    }
    if (input.isClosed() || input.signal.aborted) {
      throw input.isClosed()
        ? new Error('The Claude SDK session is closed')
        : abortReason(input.signal);
    }
  } catch (error) {
    input.setInFlightClose(undefined);
    input.recordPid(undefined);
    closeHandle();
    throw error;
  }
  input.setInFlightClose(undefined);
  return handle;
}

/**
 * One Claude session over Agent SDK queries. A query lives until it breaks;
 * a broken one fails its turn (or clears its handle when idle), and the next
 * turn or control opens a new query that resumes the session with live model,
 * permissionMode and flag settings re-applied.
 */
export async function openClaudeSdkSession(
  config: ClaudeSdkDriverConfig,
  limits: Map<string, PlanLimits>,
  input: Parameters<AgentEngineDriver['open']>[0],
): Promise<ClaudeSdkSession> {
  const ambient = config.ambient ?? process.env;
  const profile = engineProfile('claude-sdk', input.profile);
  input.signal?.throwIfAborted();
  const sessionId = input.nativeThreadId ?? randomUUID();
  const transcript = claudeTranscriptPath({ home: profile.home, cwd: input.cwd, sessionId });
  let resume =
    input.nativeThreadId !== undefined && (await claudeTranscriptExists(transcript));
  let current: SdkTurnSlot | undefined;
  let startingTurn = false;
  let closed = false;
  let providerPid: number | undefined;
  let activeModel = config.model;
  let activePermissionMode: NonNullable<Options['permissionMode']> =
    config.permissionMode ?? 'default';
  let flagSettingsOverlay: ClaudeSdkFlagSettings | undefined;
  let running: RunningQueryHandle | undefined;
  let opening: Promise<RunningQueryHandle> | undefined;
  let inFlightClose: (() => void) | undefined;

  const shutdown = (reason: unknown) => {
    if (closed) return;
    closed = true;
    providerPid = undefined;
    const turn = current;
    current = undefined;
    loseEngineTurn(turn, stoppedPermission('The session was closed'), reason);
    const pendingClose = inFlightClose;
    inFlightClose = undefined;
    pendingClose?.();
    const active = running;
    running = undefined;
    active?.close();
  };
  const linked = sessionAbort(input.signal);
  linked.signal.addEventListener('abort', () => shutdown(abortReason(linked.signal)), {
    once: true,
  });
  const canUseTool = createSdkCanUseTool({
    getTurn: () => current,
    isClosed: () => closed,
  });

  const ensureQuery = async (startLoopImmediately: boolean): Promise<RunningQueryHandle> => {
    if (closed) throw new Error('The Claude SDK session is closed');
    if (running !== undefined) {
      if (startLoopImmediately) running.startLoop();
      return running;
    }
    if (opening === undefined) {
      const promise = launchSingleSdkQuery({
        config,
        cwd: input.cwd,
        env: engineEnvironment(profile, ambient),
        profileId: profile.profileId,
        limits,
        sessionId,
        resume,
        activeModel,
        activePermissionMode,
        flagSettingsOverlay,
        signal: linked.signal,
        canUseTool,
        isClosed: () => closed,
        getTurn: () => current,
        clearTurn: () => {
          current = undefined;
        },
        setInFlightClose: (fn) => {
          inFlightClose = fn;
        },
        recordPid: (pid) => {
          providerPid = pid;
        },
        onPidExit: (exitedPid) => {
          if (providerPid === exitedPid) providerPid = undefined;
        },
        onExit: (exited, error) => {
          const ownsSession = running === exited;
          const turn = ownsSession ? current : undefined;
          if (ownsSession) {
            running = undefined;
            current = undefined;
            providerPid = undefined;
          }
          loseEngineTurn(turn, stoppedPermission('The Claude SDK query ended'), error);
          exited.close();
        },
      })
        .then((handle) => {
          running = handle;
          return handle;
        })
        .finally(() => {
          if (opening === promise) opening = undefined;
        });
      opening = promise;
    }
    const handle = await opening;
    if (startLoopImmediately) handle.startLoop();
    return handle;
  };

  if (hasDelegationVerification(config.verifyDelegation)) {
    try {
      await ensureQuery(true);
    } catch (error) {
      shutdown(error);
      linked.abort();
      linked.release();
      throw error;
    }
  }

  const startTurn = createSdkStartTurn({
    config,
    sessionId,
    signal: linked.signal,
    isClosed: () => closed,
    getTurn: () => current,
    setTurn: (turn) => {
      current = turn;
    },
    isStarting: () => startingTurn,
    setStarting: (value) => {
      startingTurn = value;
    },
    markResumable: () => {
      resume = true;
    },
    ensureQuery,
  });

  const controls = createClaudeSdkControls({
    signal: linked.signal,
    isClosed: () => closed,
    ensureQuery: () => ensureQuery(true),
    setActiveModel: (model) => {
      activeModel = model;
    },
    setActivePermissionMode: (mode) => {
      activePermissionMode = mode;
    },
    recordFlagSettings: (settings) => {
      flagSettingsOverlay = { ...flagSettingsOverlay, ...settings };
    },
  });

  return {
    nativeThreadId: sessionId,
    get providerPid() {
      return providerPid;
    },
    startTurn,
    ...controls,
    async close() {
      shutdown(new Error('The Claude SDK session closed'));
      linked.abort();
      linked.release();
    },
  };
}
