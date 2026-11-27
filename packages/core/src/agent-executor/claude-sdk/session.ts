import { randomUUID } from 'node:crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { abortReason } from '../../internal/abort-race';
import { newClaudeTurnState } from '../claude/classify';
import { claudeUserContent } from '../claude/protocol';
import { claudeTranscriptExists, claudeTranscriptPath } from '../claude/transcript';
import type { AgentEngineSession, AgentEngineTurn } from '../engine';
import { loseEngineTurn } from '../engine-requests';
import type { PlanLimits } from '../hello';
import { imageTurnStarter } from '../image-input';
import { planLimitsReadFailed } from '../plan-limits';
import { engineEnvironment, engineProfile } from '../profile';
import { createTurnDeltaChannel, sessionAbort } from '../session-primitives';
import { type ClaudeSdkFlagSettings, createClaudeSdkControls } from './controls';
import type { ClaudeSdkDriverConfig, ClaudeSdkOpenInput, ClaudeSdkSession } from './driver';
import {
  createSdkCanUseTool,
  type RunningQueryHandle,
  type SdkTurnSlot,
  sdkTurnHandle,
  stoppedPermission,
} from './query-loop';
import { createSdkQueryManager } from './query-manager';
import { hasDelegationVerification, validateClaudeSdkOpenInput } from './query-options';

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
  ensureAlive: () => void;
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
      input.ensureAlive();
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
      input.ensureAlive();
      if (input.getTurn() !== undefined)
        throw new Error('A turn is already running in this Claude session');
      const turn: SdkTurnSlot = {
        state: newClaudeTurnState(turnInput.turnId),
        channel: createTurnDeltaChannel(),
        pending: new Map(),
        settled: false,
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
        return sdkTurnHandle(turn, active.query, input.ensureAlive);
      } catch (error) {
        turn.settled = true;
        if (input.getTurn() === turn) input.setTurn(undefined);
        throw error;
      }
    },
  });
}

function recordSdkPlanLimitsFailure(
  limits: Map<string, PlanLimits>,
  profileId: string,
  error: unknown,
): void {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const boundedMessage =
    rawMessage.trim().length > 0 ? rawMessage.slice(0, 4096) : 'Plan limits read failed';
  limits.set(
    profileId,
    planLimitsReadFailed({
      previous: limits.get(profileId),
      error: boundedMessage,
      now: new Date(),
    }),
  );
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
  input: ClaudeSdkOpenInput,
): Promise<ClaudeSdkSession> {
  validateClaudeSdkOpenInput(input);
  const ambient = config.ambient ?? process.env;
  const profile = engineProfile('claude-sdk', input.profile, ambient);
  input.signal?.throwIfAborted();
  const env = engineEnvironment(profile, ambient);
  const sessionId = input.nativeThreadId ?? randomUUID();
  const transcript = claudeTranscriptPath({ home: profile.home, cwd: input.cwd, sessionId });
  const transcriptExists =
    input.nativeThreadId !== undefined && (await claudeTranscriptExists(transcript));
  let resume = transcriptExists || input.resumeSessionAt !== undefined;
  let pendingResumeSessionAt = input.resumeSessionAt;
  let pendingResumeDropsTurn = input.resumeDropsTurn;
  let current: SdkTurnSlot | undefined;
  let startingTurn = false;
  let opened = false;
  let closing = false;
  let closed = false;
  let closeReason: unknown;
  let providerPid: number | undefined;
  let activeModel = config.model;
  let activePermissionMode: NonNullable<Options['permissionMode']> =
    config.permissionMode ?? 'default';
  let flagSettingsOverlay: ClaudeSdkFlagSettings | undefined;
  let running: RunningQueryHandle | undefined;
  let inFlightClose: (() => void) | undefined;

  const linked = sessionAbort(input.signal);
  const isClosed = () =>
    closing || closed || input.signal?.aborted === true || linked.signal.aborted;
  const ensureSessionAlive = () => {
    if (closing) throw new Error('The Claude SDK session is closed');
    if (input.signal?.aborted) throw abortReason(input.signal);
    if (linked.signal.aborted) throw abortReason(linked.signal);
    if (closed) throw closeReason ?? new Error('The Claude SDK session is closed');
  };
  const shutdown = (reason: unknown) => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    providerPid = undefined;
    const turn = current;
    current = undefined;
    if (turn !== undefined) turn.settled = true;
    loseEngineTurn(turn, stoppedPermission('The session was closed'), reason);
    const pendingClose = inFlightClose;
    inFlightClose = undefined;
    pendingClose?.();
    const active = running;
    running = undefined;
    active?.close();
  };
  linked.signal.addEventListener('abort', () => shutdown(abortReason(linked.signal)), {
    once: true,
  });
  const canUseTool = createSdkCanUseTool({
    getTurn: () => current,
    isClosed,
    ...(config.onPermissionRequest !== undefined && {
      onPermissionRequest: config.onPermissionRequest,
    }),
  });
  const ensureQuery = createSdkQueryManager({
    config,
    cwd: input.cwd,
    env,
    profileId: profile.profileId,
    limits,
    sessionId,
    signal: linked.signal,
    canUseTool,
    ...(input.onStartupPhase !== undefined && { onStartupPhase: input.onStartupPhase }),
    isOpened: () => opened,
    isClosed,
    ensureAlive: ensureSessionAlive,
    getResume: () => ({
      resume,
      ...(pendingResumeSessionAt !== undefined && { resumeSessionAt: pendingResumeSessionAt }),
      ...(pendingResumeDropsTurn !== undefined && { resumeDropsTurn: pendingResumeDropsTurn }),
    }),
    getLiveConfig: () => ({ activeModel, activePermissionMode, flagSettingsOverlay }),
    getTurn: () => current,
    clearTurn: () => {
      current = undefined;
    },
    getRunning: () => running,
    setRunning: (handle) => {
      running = handle;
    },
    getInFlightClose: () => inFlightClose,
    setInFlightClose: (fn) => {
      inFlightClose = fn;
    },
    recordPid: (pid) => {
      providerPid = pid;
    },
    onPidExit: (exitedPid) => {
      if (providerPid === exitedPid) providerPid = undefined;
    },
  });

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
    ensureAlive: ensureSessionAlive,
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
      pendingResumeSessionAt = undefined;
      pendingResumeDropsTurn = undefined;
    },
    ensureQuery,
  });

  const controls = createClaudeSdkControls({
    signal: linked.signal,
    isClosed,
    ensureAlive: ensureSessionAlive,
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
    recordPlanLimits: (next) => {
      limits.set(profile.profileId, next);
    },
    recordPlanLimitsFailure: (error) =>
      recordSdkPlanLimitsFailure(limits, profile.profileId, error),
  });

  opened = true;
  return {
    nativeThreadId: sessionId,
    get providerPid() {
      return providerPid;
    },
    startTurn,
    ...controls,
    async close() {
      closing = true;
      shutdown(new Error('The Claude SDK session is closed'));
      linked.abort();
      linked.release();
    },
  };
}
