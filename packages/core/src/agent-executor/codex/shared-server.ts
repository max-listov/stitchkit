import { abortReason } from '../../internal/abort-race';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import { isRecord } from '../../internal/typed';
import { loseEngineTurn } from '../engine-requests';
import type { ExecutorDriverCapabilities } from '../hello';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import {
  invokeObserver,
  sessionAbort,
  sessionLiveness,
  stopConnection,
} from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import { codexSharedServerCapabilities } from './capabilities';
import { connectCodex } from './connect';
import { type CodexControlClient, createCodexControlClient } from './control-client';
import { codexThreadIdOf, discardStartingTurn } from './event-routing';
import { codexObserverOptions, createCodexHandlers } from './handlers';
import {
  codexStopped,
  codexStoppedReply,
  type PendingExternalCodexRequest,
  releaseExternalCodexRequestsBeforeStop,
} from './request-answers';
import { refuseOwnedUnsubscribe } from './session-bind';
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
  const closingThreadIds = new Set<string>();
  const globalExternalPending = new Map<string, PendingExternalCodexRequest>();
  let opened = false;
  const liveness = sessionLiveness({
    closedMessage: 'The Codex shared server is closed',
    caller: input.signal,
    linked: linked.signal,
  });
  const globalHandlers = createCodexHandlers({
    sharedWithOtherClients: false,
    profileId: profile.profileId,
    limits: config.limits,
    externalPending: globalExternalPending,
    liveness,
    closingGracefully: () => liveness.closingGracefully,
    getTurn: () => undefined,
    clearTurn: () => undefined,
    ...codexObserverOptions(config),
  });

  const heldGlobally = (params: unknown): boolean => {
    const requestId = isRecord(params) ? params.requestId : undefined;
    return (
      (typeof requestId === 'string' || typeof requestId === 'number') &&
      globalExternalPending.has(String(requestId))
    );
  };
  const failAllThreads = (reason: unknown) => {
    for (const slot of [...threads.values()]) {
      slot.liveness.markLost(reason);
      const turn = slot.current;
      slot.current = undefined;
      discardStartingTurn(turn);
      slot.externalPending.clear();
      loseEngineTurn(turn, codexStopped, reason);
      slot.abortThread(reason);
      slot.releaseThreadSignal();
    }
    threads.clear();
  };

  // A failure inside one thread's handling stays with that notification: siblings keep running.
  const contained = (handle: () => void) =>
    invokeObserver(config.onObserverError, 'driver:notification', handle);

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
            contained(() => globalHandlers.onNotification(method, params));
            return;
          }
          const targetId = codexThreadIdOf(params);
          if (targetId !== undefined && closingThreadIds.has(targetId)) return;
          // A request that arrived before its thread registered is held globally; its resolution
          // must reach that same map, or the entry stays until the global cap refuses new requests.
          if (method === 'serverRequest/resolved' && heldGlobally(params)) {
            contained(() => globalHandlers.onNotification(method, params));
            return;
          }
          const slot = targetId !== undefined ? threads.get(targetId) : undefined;
          if (slot !== undefined) {
            contained(() => slot.handlers.onNotification(method, params));
            // The server unloaded a thread this driver still owns: its slot and turn end here.
            if (method === 'thread/closed')
              slot.abortThread(new Error(`Codex closed thread ${slot.threadId}`));
            return;
          }
          contained(() => globalHandlers.onNotification(method, params));
        },
        onRequest(method, params, id) {
          const targetId = codexThreadIdOf(params);
          if (targetId !== undefined && closingThreadIds.has(targetId))
            return codexStoppedReply(method);
          const slot = targetId !== undefined ? threads.get(targetId) : undefined;
          if (slot !== undefined) return slot.handlers.onRequest(method, params, id);
          return globalHandlers.onRequest(method, params, id);
        },
      },
      (error) => {
        const { abortedByCaller } = liveness;
        const shouldNotify = opened && !liveness.closing && !abortedByCaller;
        if (!liveness.closing && !abortedByCaller) liveness.markLost(error);
        globalExternalPending.clear();
        failAllThreads(
          abortedByCaller && input.signal !== undefined ? abortReason(input.signal) : error,
        );
        linked.abort();
        if (shouldNotify)
          invokeObserver(config.onObserverError, 'onDisconnect', () =>
            config.onDisconnect?.(error),
          );
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
    ensureAlive: () => liveness.ensureAlive(),
    onBeforeInterruptTurn,
  });
  const sharedCapabilities = codexSharedServerCapabilities(baseCapabilities);
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
    closingThreadIds,
    openingNativeThreadIds: new Set<string>(),
    openingThreads: 0,
    liveness,
  };

  // Every caller of close() waits for the same stop: the second must not return while the process lives.
  let closing: Promise<void> | undefined;
  const closeServer = (): Promise<void> => {
    closing ??= (async () => {
      liveness.markClosing();
      // The process is this driver's alone (stdio): what it still asks is answered as stopped.
      const answer = liveness.closingGracefully;
      await releaseExternalCodexRequestsBeforeStop(
        [globalExternalPending, ...[...threads.values()].map((slot) => slot.externalPending)],
        answer,
      );
      failAllThreads(new Error('The Codex shared server closed'));
      try {
        await stopConnection(connected);
      } finally {
        linked.abort();
        linked.release();
      }
    })();
    return closing;
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
    // A thread open on this server leaves only through its session's close(); see refuseOwnedUnsubscribe.
    unsubscribeThread(params, options) {
      if (threads.has(params.threadId) || closingThreadIds.has(params.threadId))
        return refuseOwnedUnsubscribe(params.threadId);
      return controlClient.unsubscribeThread(params, options);
    },
    openThread: (threadInput) => openSharedCodexThread(state, threadInput),
    close: closeServer,
  };
}
