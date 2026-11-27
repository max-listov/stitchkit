import { raceAbort } from '../../internal/abort-race';
import {
  type EngineTurnLiveness,
  interruptEngineTurn,
  refuseEngineTurnRequests,
} from '../engine-requests';
import { type DriverImageOptions, guardedTurnStarter } from '../image-input';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import { createTurnDeltaChannel } from '../session-primitives';
import type { CodexConnectConfig } from './connect';
import type { CodexControlClient } from './control-client';
import { CodexStartingTurn, codexTurnIdOf, discardStartingTurn } from './event-routing';
import type { CodexNotificationEvent, CodexServerRequestEvent } from './handlers';
import type { CodexLimitBook } from './limits';
import {
  CodexStartedTurnSchema,
  type CodexThreadContext,
  parseCodexResponse,
} from './protocol';
import {
  answerActiveCodexTurnRequest,
  type CodexTurnSlot,
  codexStopped,
} from './request-answers';
import {
  buildCodexThreadPolicyParams,
  buildCodexTurnStartRpcParams,
  validateCodexForkBounds,
  validateCodexPolicyOverrides,
  validateCodexTurnStartOverrides,
} from './session-controls';
import type {
  CodexOpenForkOptions,
  CodexOpenInput,
  CodexThreadPolicyOverrides,
  CodexTurn,
  CodexTurnInput,
} from './session-types';
import { assertNonEmptyThreadId, assertOptionalNonEmptyNoNulString } from './thread-controls';
import { inlineCodexParts } from './turn-input';

/** Parameters for Codex `thread/resume`. */
export interface CodexResumeThreadParams extends CodexThreadPolicyOverrides {
  /** Thread identifier to resume. */
  readonly threadId: string;
  /** Optional working directory override forwarded on `thread/resume`. */
  readonly cwd?: string | undefined;
  /** Defaults to `true` when omitted so large threads do not inline full history into the resume reply. */
  readonly excludeTurns?: boolean | undefined;
}

export interface CodexSessionConfig extends DriverImageOptions, CodexConnectConfig {
  readonly model?: string | undefined;
  readonly modelProvider?: string | undefined;
  readonly approvalPolicy: CodexThreadPolicyOverrides['approvalPolicy'];
  readonly sandbox: CodexThreadPolicyOverrides['sandbox'];
  readonly developerInstructions?: string | undefined;
  readonly runtimeWorkspaceRoots?: readonly string[] | undefined;
  readonly config?: Readonly<Record<string, JsonRpcValue>> | undefined;
  readonly prepareThread?:
    | ((context: {
        readonly controls: CodexControlClient;
        readonly cwd: string;
        readonly nativeThreadId?: string | undefined;
        readonly forkFrom?: CodexOpenForkOptions | undefined;
      }) =>
        | Promise<CodexThreadPolicyOverrides | undefined>
        | CodexThreadPolicyOverrides
        | undefined)
    | undefined;
  readonly verifyThread?:
    | ((context: {
        readonly nativeThreadId: string;
        readonly threadContext: CodexThreadContext;
        readonly controls: CodexControlClient;
      }) => Promise<void> | void)
    | undefined;
  readonly onNotification?: ((event: CodexNotificationEvent) => void) | undefined;
  readonly onServerRequest?: ((event: CodexServerRequestEvent) => void) | undefined;
  readonly serverRequestDelivery?: 'external-only' | 'all' | undefined;
  readonly onDisconnect?: ((error: Error) => void) | undefined;
  readonly limits: CodexLimitBook;
}

/** Mark and drain a local driver-started turn when `turn/interrupt` targets its exact `codexTurnId`. */
export function interruptLocalCodexTurn(
  turn: CodexTurnSlot | undefined,
  turnId: string,
): void {
  if (turn === undefined || turn.codexTurnId !== turnId) return;
  refuseEngineTurnRequests(turn, codexStopped);
}

/** How long stopping an abandoned turn waits for its turn id and for the interrupt answer. */
const ABANDONED_TURN_MS = 5_000;

/**
 * Interrupt a turn the server may run while this driver no longer follows it. The native id is the
 * `turn/start` reply's, or the one a buffered event named before that reply; a reply still on its
 * way is awaited at most {@link ABANDONED_TURN_MS}. Best effort and once per turn. The ids are read
 * when this is called, so call it before the pre-start buffer is discarded.
 */
export function interruptAbandonedCodexTurn(
  peer: JsonRpcPeer,
  threadId: string,
  turn: CodexTurnSlot | undefined,
): Promise<void> {
  if (turn === undefined || turn.abandoned === true) return Promise.resolve();
  turn.abandoned = true;
  const known = turn.codexTurnId ?? turn.starting?.observedTurnId;
  const reply = turn.startReply;
  const named: Promise<string | undefined> =
    known !== undefined || reply === undefined
      ? Promise.resolve(known)
      : raceAbort(reply, AbortSignal.timeout(ABANDONED_TURN_MS)).then(
          codexTurnIdOf,
          () => undefined,
        );
  return named
    .then(async (turnId) => {
      if (turnId === undefined) return;
      await peer.request(
        'turn/interrupt',
        { threadId, turnId },
        { timeoutMs: ABANDONED_TURN_MS },
      );
    })
    .catch(() => undefined);
}

/** Validate and normalize JSON-RPC params for `thread/resume` (defaults `excludeTurns` to `true`). */
export function buildCodexResumeThreadParams(
  params: CodexResumeThreadParams,
): Record<string, JsonRpcValue> {
  const caller = 'CodexControlClient.resumeThread';
  const threadId = assertNonEmptyThreadId(params.threadId, caller);
  assertOptionalNonEmptyNoNulString(params.cwd, 'cwd', caller);
  if (params.excludeTurns !== undefined && typeof params.excludeTurns !== 'boolean') {
    throw new TypeError(`[stitchkit] ${caller}: excludeTurns must be a boolean`);
  }
  const policyParams = buildCodexThreadPolicyParams({}, params);
  return {
    threadId,
    excludeTurns: params.excludeTurns ?? true,
    ...policyParams,
    ...(params.cwd !== undefined && { cwd: params.cwd }),
  };
}

export function createCodexStartTurn(input: {
  config: CodexSessionConfig;
  peer: JsonRpcPeer;
  threadId: string;
  activeModelProvider: string | undefined;
  signal: AbortSignal;
  /** The liveness of the session or thread the turns run in; `signal` is the one it reads. */
  liveness: EngineTurnLiveness;
  getTurn(): CodexTurnSlot | undefined;
  setTurn(turn: CodexTurnSlot | undefined): void;
}): (turnInput: CodexTurnInput) => Promise<CodexTurn> {
  return guardedTurnStarter({
    busyMessage: 'A turn is already running in this Codex thread',
    check: (turnInput: CodexTurnInput) => {
      input.liveness.ensureAlive();
      if (input.getTurn() !== undefined) {
        throw new Error('A turn is already running in this Codex thread');
      }
      validateCodexTurnStartOverrides(
        'CodexSession.startTurn',
        turnInput,
        input.activeModelProvider,
      );
    },
    inline: (turnInput) =>
      inlineCodexParts(turnInput.input, {
        ...input.config,
        driverLabel: 'The Codex driver',
        signal: input.signal,
      }),
    dispatch: async (turnInput, parts) => {
      const turnParams = buildCodexTurnStartRpcParams(
        'CodexSession.startTurn',
        input.threadId,
        turnInput,
        parts,
        input.activeModelProvider,
      );
      const starting = new CodexStartingTurn();
      const turn: CodexTurnSlot = {
        threadId: input.threadId,
        starting,
        state: { turnId: turnInput.turnId, interruptRequested: false },
        channel: createTurnDeltaChannel(),
        pending: new Map(),
        settled: false,
      };
      const isAlive = () => input.liveness.isAlive();
      input.setTurn(turn);
      // The request outlives a local abort: a reply that still arrives names the turn to interrupt.
      const reply = input.peer.request('turn/start', turnParams);
      turn.startReply = reply;
      void reply.catch(() => undefined);
      let nativeTurnId: string;
      try {
        const started = await raceAbort(reply, input.signal);
        if (!isAlive() || input.getTurn() !== turn) {
          if (input.getTurn() === turn) input.setTurn(undefined);
          discardStartingTurn(turn);
          input.liveness.ensureAlive();
          throw new Error('The Codex session is closed');
        }
        nativeTurnId = parseCodexResponse('turn/start', CodexStartedTurnSchema, started).turn
          .id;
        turn.codexTurnId = nativeTurnId;
        try {
          starting.flush(isAlive);
        } finally {
          if (turn.starting === starting) delete turn.starting;
        }
      } catch (error) {
        if (input.getTurn() === turn) input.setTurn(undefined);
        // A live connection whose turn failed locally (a reply it cannot read, an overflowing
        // pre-start buffer, a local timeout) still runs that turn: stop it. A closing thread is
        // stopped by its own close.
        if (isAlive()) void interruptAbandonedCodexTurn(input.peer, input.threadId, turn);
        if (turn.starting !== undefined) {
          const pending = turn.starting;
          try {
            if (isAlive()) pending.flush(isAlive);
            else pending.discard();
          } finally {
            if (turn.starting === pending) delete turn.starting;
          }
        }
        throw error;
      }
      return {
        nativeTurnId,
        deltas: turn.channel,
        interrupt: () =>
          interruptEngineTurn(turn, input.liveness, {
            refusal: codexStopped,
            tell: () =>
              input.peer.request('turn/interrupt', {
                threadId: input.threadId,
                turnId: nativeTurnId,
              }),
          }),
        async respond(interactionId, rawReply) {
          answerActiveCodexTurnRequest(turn, input.liveness, interactionId, rawReply);
        },
      };
    },
  });
}

export function validateCodexOpenInput(input: CodexOpenInput): void {
  if (input.nativeThreadId !== undefined && input.forkFrom !== undefined) {
    throw new TypeError(
      '[stitchkit] CodexDriver.open: nativeThreadId and forkFrom are mutually exclusive',
    );
  }
  if (input.forkFrom !== undefined) {
    if (
      typeof input.forkFrom.threadId !== 'string' ||
      input.forkFrom.threadId.trim().length === 0
    ) {
      throw new TypeError(
        '[stitchkit] CodexDriver.open: forkFrom.threadId must be a non-empty string',
      );
    }
    validateCodexForkBounds(input.forkFrom, 'CodexDriver.open');
    validateCodexPolicyOverrides(input.forkFrom, 'CodexDriver.open');
  }
}

export function mergeOpenThreadPolicy(
  config: CodexSessionConfig,
  forkFrom: CodexOpenForkOptions | undefined,
  dynamicOverrides: CodexThreadPolicyOverrides | undefined,
): Record<string, JsonRpcValue> {
  const basePolicy: CodexThreadPolicyOverrides = {
    ...(config.model !== undefined && { model: config.model }),
    ...(config.modelProvider !== undefined && { modelProvider: config.modelProvider }),
    ...(config.approvalPolicy !== undefined && { approvalPolicy: config.approvalPolicy }),
    ...(config.sandbox !== undefined && { sandbox: config.sandbox }),
    ...(config.developerInstructions !== undefined && {
      developerInstructions: config.developerInstructions,
    }),
    ...(config.runtimeWorkspaceRoots !== undefined && {
      runtimeWorkspaceRoots: config.runtimeWorkspaceRoots,
    }),
    ...(config.config !== undefined && { config: config.config }),
  };
  const withFork: CodexThreadPolicyOverrides =
    forkFrom === undefined
      ? basePolicy
      : {
          ...basePolicy,
          ...(forkFrom.model !== undefined && { model: forkFrom.model }),
          ...(forkFrom.modelProvider !== undefined && {
            modelProvider: forkFrom.modelProvider,
          }),
          ...(forkFrom.approvalPolicy !== undefined && {
            approvalPolicy: forkFrom.approvalPolicy,
          }),
          ...(forkFrom.sandbox !== undefined && { sandbox: forkFrom.sandbox }),
          ...(forkFrom.developerInstructions !== undefined && {
            developerInstructions: forkFrom.developerInstructions,
          }),
          ...(forkFrom.runtimeWorkspaceRoots !== undefined && {
            runtimeWorkspaceRoots: forkFrom.runtimeWorkspaceRoots,
          }),
          ...(basePolicy.config !== undefined || forkFrom.config !== undefined
            ? { config: { ...(basePolicy.config ?? {}), ...(forkFrom.config ?? {}) } }
            : {}),
        };
  return buildCodexThreadPolicyParams(withFork, dynamicOverrides);
}

/** Dispatch `thread/fork`, `thread/resume`, or `thread/start` with merged policy overrides. */
export function openCodexThreadRpc(
  peer: JsonRpcPeer,
  config: CodexSessionConfig,
  input: {
    readonly cwd: string;
    readonly nativeThreadId?: string | undefined;
    readonly forkFrom?: CodexOpenForkOptions | undefined;
  },
  dynamicOverrides: CodexThreadPolicyOverrides | undefined,
): Promise<JsonRpcValue> {
  const threadParams: Record<string, JsonRpcValue> = {
    cwd: input.cwd,
    ...mergeOpenThreadPolicy(config, input.forkFrom, dynamicOverrides),
  };
  if (input.forkFrom !== undefined) {
    const fork = input.forkFrom;
    return peer.request('thread/fork', {
      threadId: fork.threadId,
      excludeTurns: fork.excludeTurns ?? true,
      ...threadParams,
      ...(fork.beforeTurnId !== undefined && { beforeTurnId: fork.beforeTurnId }),
      ...(fork.lastTurnId !== undefined && { lastTurnId: fork.lastTurnId }),
      ...(fork.deferGoalContinuation !== undefined && {
        deferGoalContinuation: fork.deferGoalContinuation,
      }),
    });
  }
  if (input.nativeThreadId !== undefined) {
    return peer.request('thread/resume', {
      threadId: input.nativeThreadId,
      excludeTurns: true,
      ...threadParams,
    });
  }
  return peer.request('thread/start', threadParams);
}
