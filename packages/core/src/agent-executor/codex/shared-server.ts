import { abortReason } from '../../internal/abort-race';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import { loseEngineTurn } from '../engine-requests';
import type { ExecutorDriverCapabilities } from '../hello';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import { invokeSafely, sessionAbort, stopConnection } from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import { connectCodex } from './connect';
import { type CodexControlClient, createCodexControlClient } from './control-client';
import { codexThreadIdOf, discardStartingTurn } from './event-routing';
import { createCodexHandlers } from './handlers';
import { codexStopped, type PendingExternalCodexRequest } from './request-answers';
import type { CodexSession } from './session-types';
import {
  type CodexSharedServerThreadInput,
  openSharedCodexThread,
  type SharedServerState,
  type SharedThreadSlot,
} from './shared-thread';
import { type CodexSessionConfig, interruptLocalCodexTurn } from './thread-open';

const DEFAULT_MAX_SHARED_THREADS = 32;
const HARD_MAX_SHARED_THREADS = 256;

/** Input to {@link CodexDriver.openSharedServer} for a headless multi-thread `codex app-server`. */
export interface CodexSharedServerOpenInput {
  readonly profile: ExecutorProfileConfig;
  readonly cwd: string;
  /** Maximum concurrent open threads multiplexed on this shared server (`1..256`). Default `32`. */
  readonly maxThreads?: number | undefined;
  /** Optional observer invoked with startup phases (`spawning`, `initializing`) during server startup. */
  readonly onStartupPhase?: ((phase: ExecutorStartupPhase) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Shared headless `codex app-server` multiplexing up to `maxThreads` independent {@link CodexSession}s. */
export interface CodexSharedServer extends CodexControlClient {
  readonly providerPid: number | undefined;
  /** Server-reported `userAgent` from the `initialize` response, or `undefined` when omitted. */
  readonly userAgent: string | undefined;
  readonly maxThreads: number;
  readonly activeThreadCount: number;
  readonly capabilities: ExecutorDriverCapabilities;
  openThread(input: CodexSharedServerThreadInput): Promise<CodexSession>;
  close(): Promise<void>;
}

function validateSharedServerInputs(
  config: CodexSessionConfig,
  input: CodexSharedServerOpenInput,
): number {
  if (config.transport !== undefined && config.transport.kind !== 'stdio') {
    throw new TypeError(
      `[stitchkit] CodexDriver.openSharedServer: shared multi-thread mode requires stdio transport (received ${JSON.stringify(config.transport.kind)})`,
    );
  }
  const maxThreads = input.maxThreads ?? DEFAULT_MAX_SHARED_THREADS;
  assertPositiveSafeInteger(
    '[stitchkit] CodexDriver.openSharedServer: maxThreads',
    maxThreads,
  );
  if (maxThreads > HARD_MAX_SHARED_THREADS) {
    throw new RangeError(
      `[stitchkit] CodexDriver.openSharedServer: maxThreads (${maxThreads}) must not exceed ${HARD_MAX_SHARED_THREADS}`,
    );
  }
  return maxThreads;
}

/** Open a single `stdio` `codex app-server` multiplexing up to `maxThreads` independent sessions. */
export async function openCodexSharedServer(
  config: CodexSessionConfig,
  baseCapabilities: ExecutorDriverCapabilities,
  input: CodexSharedServerOpenInput,
): Promise<CodexSharedServer> {
  const maxThreads = validateSharedServerInputs(config, input);
  const profile = engineProfile('codex', input.profile);
  const linked = sessionAbort(input.signal);
  const threads = new Map<string, SharedThreadSlot>();
  const globalExternalPending = new Map<string, PendingExternalCodexRequest>();
  let serverDead: Error | undefined;
  let serverClosing = false;
  let opened = false;

  const ensureServerAlive = () => {
    if (serverClosing) throw new Error('The Codex shared server is closed');
    if (serverDead !== undefined) throw serverDead;
    if (linked.signal.aborted) throw abortReason(linked.signal);
  };
  const globalHandlers = createCodexHandlers({
    profileId: profile.profileId,
    limits: config.limits,
    externalPending: globalExternalPending,
    ensureAlive: ensureServerAlive,
    getTurn: () => undefined,
    clearTurn: () => undefined,
    ...(config.onNotification !== undefined && { onNotification: config.onNotification }),
    ...(config.onServerRequest !== undefined && { onServerRequest: config.onServerRequest }),
    ...(config.serverRequestDelivery !== undefined && {
      serverRequestDelivery: config.serverRequestDelivery,
    }),
  });

  const failAllThreads = (error: Error) => {
    for (const slot of [...threads.values()]) {
      slot.closed = true;
      slot.dead = error;
      const turn = slot.current;
      slot.current = undefined;
      discardStartingTurn(turn);
      slot.externalPending.clear();
      loseEngineTurn(turn, codexStopped, error);
      slot.abortThread();
      slot.releaseThreadSignal();
    }
    threads.clear();
  };

  let connected: Awaited<ReturnType<typeof connectCodex>>;
  try {
    connected = await connectCodex(
      config,
      profile,
      input.cwd,
      linked.signal,
      {
        onNotification(method, params) {
          if (method === 'account/rateLimits/updated') {
            invokeSafely(() => globalHandlers.onNotification(method, params));
            return;
          }
          const targetId = codexThreadIdOf(params);
          const slot = targetId !== undefined ? threads.get(targetId) : undefined;
          if (slot !== undefined) {
            invokeSafely(() => slot.handlers.onNotification(method, params));
            return;
          }
          invokeSafely(() => globalHandlers.onNotification(method, params));
        },
        onRequest(method, params, id) {
          const targetId = codexThreadIdOf(params);
          const slot = targetId !== undefined ? threads.get(targetId) : undefined;
          if (slot !== undefined) return slot.handlers.onRequest(method, params, id);
          return globalHandlers.onRequest(method, params, id);
        },
      },
      (error) => {
        const shouldNotify = opened && !serverClosing && input.signal?.aborted !== true;
        serverDead = error;
        globalExternalPending.clear();
        failAllThreads(error);
        linked.abort();
        if (shouldNotify) invokeSafely(() => config.onDisconnect?.(error));
      },
      input.onStartupPhase,
    );
  } catch (error) {
    linked.release();
    throw error;
  }

  const { peer, providerPid, userAgent } = connected;
  const onBeforeInterruptTurn = (targetThreadId: string, turnId: string) => {
    interruptLocalCodexTurn(threads.get(targetThreadId)?.current, turnId);
  };
  const controlClient = createCodexControlClient({
    peer,
    imageOptions: config,
    signal: linked.signal,
    ensureAlive: ensureServerAlive,
    onBeforeInterruptTurn,
  });
  const sharedCapabilities: ExecutorDriverCapabilities = {
    ...baseCapabilities,
    multiThreadPerProcess: true,
  };
  const state: SharedServerState = {
    config,
    profile,
    peer,
    providerPid,
    userAgent,
    maxThreads,
    onBeforeInterruptTurn,
    serverSignal: linked.signal,
    threads,
    openingNativeThreadIds: new Set<string>(),
    openingThreads: 0,
    isServerClosing: () => serverClosing,
    getServerDead: () => serverDead,
    ensureServerAlive,
  };

  const closeServer = async () => {
    if (serverClosing) return;
    serverClosing = true;
    globalExternalPending.clear();
    failAllThreads(new Error('The Codex shared server closed'));
    try {
      await stopConnection(connected);
    } finally {
      linked.abort();
      linked.release();
    }
  };

  opened = true;
  return {
    providerPid,
    userAgent,
    maxThreads,
    get activeThreadCount() {
      return threads.size;
    },
    capabilities: sharedCapabilities,
    ...controlClient,
    openThread: (threadInput) => openSharedCodexThread(state, threadInput),
    close: closeServer,
  };
}
