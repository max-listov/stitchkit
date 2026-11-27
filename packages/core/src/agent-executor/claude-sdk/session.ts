import { randomUUID } from 'node:crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { abortReason, raceAbort } from '../../internal/abort-race';
import { newClaudeTurnState } from '../claude/classify';
import { claudeUserContent } from '../claude/protocol';
import { claudeTranscriptExists, claudeTranscriptPath } from '../claude/transcript';
import type { AgentEngineSession, AgentEngineTurn } from '../engine';
import { loseEngineTurn } from '../engine-requests';
import type { PlanLimits } from '../hello';
import { imageTurnStarter } from '../image-input';
import { planLimitsReadFailed } from '../plan-limits';
import { engineEnvironment, engineProfile } from '../profile';
import {
  createTurnDeltaChannel,
  type SessionLiveness,
  sessionAbort,
  sessionLiveness,
} from '../session-primitives';
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

/** How many times a turn re-launches a query that exited while the turn was being bound to it. */
const MAX_QUERY_RELAUNCHES = 3;

type Uuid = `${string}-${string}-${string}-${string}-${string}`;
/** The SDK keys a user message by a UUID; a client id of another form is refused, not coerced. */
function isUuid(value: string): value is Uuid {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** How long `close()` waits for spawned Claude Code processes: the SDK's grace, then the group stop. */
const ENGINE_EXIT_WAIT_MS = 10_000;

async function waitForEngineExits(exits: ReadonlySet<Promise<void>>): Promise<void> {
  if (exits.size === 0) return;
  await raceAbort(Promise.all(exits), AbortSignal.timeout(ENGINE_EXIT_WAIT_MS)).catch(() => {
    throw new Error(
      `Claude Code did not exit within ${ENGINE_EXIT_WAIT_MS} ms of closing the SDK session`,
    );
  });
}

/** Build the `startTurn` dispatcher for one Claude SDK session, enforcing single-turn concurrency. */
function createSdkStartTurn(input: {
  config: ClaudeSdkDriverConfig;
  sessionId: string;
  signal: AbortSignal;
  liveness: SessionLiveness;
  getTurn: () => SdkTurnSlot | undefined;
  setTurn: (turn: SdkTurnSlot | undefined) => void;
  isStarting: () => boolean;
  setStarting: (value: boolean) => void;
  markResumable: () => void;
  ensureQuery: (startLoopImmediately: boolean) => Promise<RunningQueryHandle>;
  isRunning: (handle: RunningQueryHandle) => boolean;
}) {
  return imageTurnStarter<Parameters<AgentEngineSession['startTurn']>[0], AgentEngineTurn>({
    driverLabel: 'The Agent SDK driver',
    busyMessage: 'A turn is already running in this Claude session',
    imageOptions: input.config,
    signal: input.signal,
    check(turnInput) {
      input.liveness.ensureAlive();
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
        // An idle query can exit while this await is pending; its handle then reads no input.
        // Bind the turn only to the query that is running now.
        for (let attempt = 1; !input.isRunning(active); attempt += 1) {
          if (attempt > MAX_QUERY_RELAUNCHES)
            throw new Error('The Claude SDK query kept exiting before the turn could start');
          active = await input.ensureQuery(false);
        }
      } finally {
        input.setStarting(false);
      }
      input.liveness.ensureAlive();
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
        return sdkTurnHandle(turn, active.query, input.liveness);
      } catch (error) {
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
  let pendingResumeSessionAt = input.resumeSessionAt;
  let pendingResumeDropsTurn = input.resumeDropsTurn;
  let current: SdkTurnSlot | undefined;
  let startingTurn = false;
  let opened = false;
  let providerPid: number | undefined;
  let activeModel = config.model;
  let activePermissionMode: NonNullable<Options['permissionMode']> =
    config.permissionMode ?? 'default';
  let flagSettingsOverlay: ClaudeSdkFlagSettings | undefined;
  let running: RunningQueryHandle | undefined;
  const engineExits = new Set<Promise<void>>();
  let inFlightClose: (() => void) | undefined;

  const linked = sessionAbort(input.signal);
  const liveness = sessionLiveness({
    closedMessage: 'The Claude SDK session is closed',
    caller: input.signal,
    linked: linked.signal,
  });
  const isClosed = () => !liveness.isAlive();
  const ensureSessionAlive = () => liveness.ensureAlive();
  const shutdown = (reason: unknown) => {
    if (liveness.lost !== undefined) return;
    liveness.markLost(reason);
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
  linked.signal.addEventListener('abort', () => shutdown(abortReason(linked.signal)), {
    once: true,
  });
  const canUseTool = createSdkCanUseTool({
    getTurn: () => current,
    isClosed,
    ...(config.onPermissionRequest !== undefined && {
      onPermissionRequest: config.onPermissionRequest,
    }),
    ...(config.onObserverError !== undefined && { onObserverError: config.onObserverError }),
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
    // Like the CLI, resume only a conversation Claude Code has written: a first query that died
    // before its transcript leaves nothing to resume, and resuming it would fail every later one.
    getResume: async () => ({
      resume:
        pendingResumeSessionAt !== undefined || (await claudeTranscriptExists(transcript)),
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
    trackExit: (exited) => {
      engineExits.add(exited);
      void exited.then(() => engineExits.delete(exited));
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
    liveness,
    getTurn: () => current,
    setTurn: (turn) => {
      current = turn;
    },
    isStarting: () => startingTurn,
    setStarting: (value) => {
      startingTurn = value;
    },
    markResumable: () => {
      pendingResumeSessionAt = undefined;
      pendingResumeDropsTurn = undefined;
    },
    ensureQuery,
    isRunning: (handle) => running === handle,
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
      liveness.markClosing();
      shutdown(new Error('The Claude SDK session is closed'));
      linked.abort();
      linked.release();
      // Stop and wait, like every engine: a process this driver spawned is gone when close
      // resolves. One the SDK spawned itself gives no handle to wait on.
      await waitForEngineExits(engineExits);
    },
  };
}
