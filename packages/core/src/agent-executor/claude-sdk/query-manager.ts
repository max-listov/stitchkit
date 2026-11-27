import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { loseEngineTurn } from '../engine-requests';
import type { PlanLimits } from '../hello';
import {
  emitStartupPhase,
  invokeObserver,
  type ObserverErrorHandler,
} from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import type { ClaudeSdkFlagSettings } from './controls';
import type { ClaudeSdkDriverConfig, ClaudeSdkQueryExitContext, ClaudeSdkRun } from './driver';
import {
  closeQuerySafely,
  pushablePrompt,
  type RunningQueryHandle,
  runSdkQueryLoop,
  type SdkTurnSlot,
  stoppedPermission,
} from './query-loop';
import {
  buildClaudeSdkQueryOptions,
  hasDelegationVerification,
  replayClaudeSdkFlagSettings,
  verifyClaudeSdkDelegation,
} from './query-options';

/** Launch, verify, and replay live settings for one Claude SDK query handle. */
async function launchSingleSdkQuery(input: {
  config: ClaudeSdkDriverConfig;
  cwd: string;
  env: Record<string, string>;
  profileId: string;
  limits: Map<string, PlanLimits>;
  sessionId: string;
  resume: boolean;
  resumeSessionAt?: Options['resumeSessionAt'];
  resumeDropsTurn?: Options['resumeDropsTurn'];
  activeModel: string | undefined;
  activePermissionMode: NonNullable<Options['permissionMode']>;
  flagSettingsOverlay: ClaudeSdkFlagSettings | undefined;
  signal: AbortSignal;
  canUseTool: NonNullable<Options['canUseTool']>;
  isClosed: () => boolean;
  ensureAlive: () => void;
  getTurn: () => SdkTurnSlot | undefined;
  clearTurn: () => void;
  setInFlightClose: (fn: (() => void) | undefined) => void;
  recordPid: (pid: number | undefined) => void;
  onPidExit: (pid: number) => void;
  trackExit: (exited: Promise<void>) => void;
  onStartupPhase?: (phase: ExecutorStartupPhase) => void;
  onExit: (handle: RunningQueryHandle, error: unknown) => void;
}): Promise<RunningQueryHandle> {
  input.ensureAlive();
  emitStartupPhase(input.onStartupPhase, 'spawning', input.config.onObserverError);
  input.ensureAlive();
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
        ...(input.resumeSessionAt !== undefined && {
          resumeSessionAt: input.resumeSessionAt,
        }),
        ...(input.resumeDropsTurn !== undefined && {
          resumeDropsTurn: input.resumeDropsTurn,
        }),
        activeModel: input.activeModel,
        activePermissionMode: input.activePermissionMode,
        recordPid: input.recordPid,
        onPidExit: input.onPidExit,
        trackExit: input.trackExit,
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
    closeQuerySafely(query, input.config.onObserverError);
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
        isClosed: input.isClosed,
        getTurn: input.getTurn,
        clearTurn: input.clearTurn,
        ...(input.config.onEvent !== undefined && { onEvent: input.config.onEvent }),
        ...(input.config.onTurnUsage !== undefined && {
          onTurnUsage: input.config.onTurnUsage,
        }),
        ...(input.config.onObserverError !== undefined && {
          onObserverError: input.config.onObserverError,
        }),
        onExit: input.onExit,
      });
    },
    close: closeHandle,
  };
  input.setInFlightClose(closeHandle);
  try {
    if (hasDelegationVerification(input.config.verifyDelegation)) {
      emitStartupPhase(input.onStartupPhase, 'verifying', input.config.onObserverError);
      await verifyClaudeSdkDelegation(query, input.config.verifyDelegation, input.signal);
    }
    if (input.flagSettingsOverlay !== undefined) {
      await replayClaudeSdkFlagSettings(query, input.flagSettingsOverlay, input.signal);
    }
    input.ensureAlive();
  } catch (error) {
    input.setInFlightClose(undefined);
    input.recordPid(undefined);
    closeHandle();
    throw error;
  }
  return handle;
}

function notifyQueryExit(
  callback: ClaudeSdkDriverConfig['onQueryExit'],
  error: unknown,
  context: ClaudeSdkQueryExitContext,
  onObserverError: ObserverErrorHandler | undefined,
): void {
  if (callback === undefined) return;
  invokeObserver(onObserverError, 'onQueryExit', () => callback(error, context));
}

/** Own query startup, ownership handoff, and unexpected query exit for one Claude SDK session. */
export function createSdkQueryManager(state: {
  readonly config: ClaudeSdkDriverConfig;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly profileId: string;
  readonly limits: Map<string, PlanLimits>;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly canUseTool: NonNullable<Options['canUseTool']>;
  readonly onStartupPhase?: (phase: ExecutorStartupPhase) => void;
  readonly isOpened: () => boolean;
  readonly isClosed: () => boolean;
  readonly ensureAlive: () => void;
  /** Read at every launch: whether to resume is a fact on disk, not a memory of having sent. */
  readonly getResume: () => Promise<{
    readonly resume: boolean;
    readonly resumeSessionAt?: Options['resumeSessionAt'];
    readonly resumeDropsTurn?: Options['resumeDropsTurn'];
  }>;
  readonly getLiveConfig: () => {
    readonly activeModel: string | undefined;
    readonly activePermissionMode: NonNullable<Options['permissionMode']>;
    readonly flagSettingsOverlay: ClaudeSdkFlagSettings | undefined;
  };
  readonly getTurn: () => SdkTurnSlot | undefined;
  readonly clearTurn: () => void;
  readonly getRunning: () => RunningQueryHandle | undefined;
  readonly setRunning: (handle: RunningQueryHandle | undefined) => void;
  readonly getInFlightClose: () => (() => void) | undefined;
  readonly setInFlightClose: (fn: (() => void) | undefined) => void;
  readonly recordPid: (pid: number | undefined) => void;
  readonly onPidExit: (pid: number) => void;
  readonly trackExit: (exited: Promise<void>) => void;
}): (startLoopImmediately: boolean) => Promise<RunningQueryHandle> {
  let opening: Promise<RunningQueryHandle> | undefined;
  const onExit = (exited: RunningQueryHandle, error: unknown) => {
    const ownsSession = state.getRunning() === exited;
    const shouldNotify = ownsSession && state.isOpened() && !state.isClosed();
    const turn = ownsSession ? state.getTurn() : undefined;
    const duringTurn = turn !== undefined;
    if (ownsSession) {
      state.setRunning(undefined);
      state.clearTurn();
      state.recordPid(undefined);
    }
    loseEngineTurn(turn, stoppedPermission('The Claude SDK query ended'), error);
    exited.close();
    if (shouldNotify) {
      notifyQueryExit(
        state.config.onQueryExit,
        error,
        { duringTurn, nativeThreadId: state.sessionId },
        state.config.onObserverError,
      );
    }
  };
  return async (startLoopImmediately: boolean): Promise<RunningQueryHandle> => {
    state.ensureAlive();
    const active = state.getRunning();
    if (active !== undefined) {
      if (startLoopImmediately) active.startLoop();
      return active;
    }
    if (opening === undefined) {
      const liveConfig = state.getLiveConfig();
      const promise = state
        .getResume()
        .then((resumeState) =>
          launchSingleSdkQuery({
            config: state.config,
            cwd: state.cwd,
            env: { ...state.env },
            profileId: state.profileId,
            limits: state.limits,
            sessionId: state.sessionId,
            resume: resumeState.resume,
            ...(resumeState.resumeSessionAt !== undefined && {
              resumeSessionAt: resumeState.resumeSessionAt,
            }),
            ...(resumeState.resumeDropsTurn !== undefined && {
              resumeDropsTurn: resumeState.resumeDropsTurn,
            }),
            activeModel: liveConfig.activeModel,
            activePermissionMode: liveConfig.activePermissionMode,
            flagSettingsOverlay: liveConfig.flagSettingsOverlay,
            signal: state.signal,
            canUseTool: state.canUseTool,
            isClosed: state.isClosed,
            ensureAlive: state.ensureAlive,
            getTurn: state.getTurn,
            clearTurn: state.clearTurn,
            setInFlightClose: state.setInFlightClose,
            recordPid: state.recordPid,
            onPidExit: state.onPidExit,
            trackExit: state.trackExit,
            ...(state.onStartupPhase !== undefined && {
              onStartupPhase: state.onStartupPhase,
            }),
            onExit,
          }),
        )
        .then((handle) => {
          if (state.isClosed()) {
            if (state.getInFlightClose() === handle.close) state.setInFlightClose(undefined);
            state.recordPid(undefined);
            handle.close();
            state.ensureAlive();
            throw new Error('The Claude SDK session is closed');
          }
          state.setRunning(handle);
          if (state.getInFlightClose() === handle.close) state.setInFlightClose(undefined);
          return handle;
        })
        .finally(() => {
          if (opening === promise) opening = undefined;
        });
      opening = promise;
    }
    const handle = await opening;
    state.ensureAlive();
    if (startLoopImmediately) handle.startLoop();
    return handle;
  };
}
