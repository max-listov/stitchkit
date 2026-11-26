import { drainEngineRequests } from '../engine-requests';
import type { PlanLimits } from '../hello';
import { type DriverImageOptions, guardedTurnStarter } from '../image-input';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import { createTurnDeltaChannel } from '../session-primitives';
import type { CodexConnectConfig } from './connect';
import type { CodexControlClient } from './control-client';
import type { CodexNotificationEvent, CodexServerRequestEvent } from './handlers';
import { CodexStartedTurnSchema, type CodexThreadContext } from './protocol';
import {
  answerActiveCodexTurnRequest,
  type CodexTurnSlot,
  codexStopped,
} from './request-answers';
import {
  buildCodexThreadPolicyParams,
  buildCodexTurnStartParams,
  type CodexOpenForkOptions,
  type CodexOpenInput,
  type CodexThreadPolicyOverrides,
  type CodexTurn,
  type CodexTurnInput,
  validateCodexForkBounds,
  validateCodexPolicyOverrides,
  validateCodexTurnStartOverrides,
} from './session-controls';
import { assertNonEmptyThreadId, assertOptionalNonEmptyNoNulString } from './thread-controls';
import { inlineCodexParts } from './turn-input';

/** Parameters for Codex `thread/resume`. */
export interface CodexResumeThreadParams extends CodexThreadPolicyOverrides {
  /** Thread identifier to resume. */
  readonly threadId: string;
  /** Optional working directory override forwarded on `thread/resume`. */
  readonly cwd?: string;
  /** Defaults to `true` when omitted so large threads do not inline full history into the resume reply. */
  readonly excludeTurns?: boolean;
}

export interface CodexSessionConfig extends DriverImageOptions, CodexConnectConfig {
  readonly model?: string;
  readonly modelProvider?: string;
  readonly approvalPolicy: CodexThreadPolicyOverrides['approvalPolicy'];
  readonly sandbox: CodexThreadPolicyOverrides['sandbox'];
  readonly developerInstructions?: string;
  readonly runtimeWorkspaceRoots?: readonly string[];
  readonly config?: Readonly<Record<string, JsonRpcValue>>;
  readonly prepareThread?: (context: {
    readonly controls: CodexControlClient;
    readonly cwd: string;
    readonly nativeThreadId?: string;
    readonly forkFrom?: CodexOpenForkOptions;
  }) =>
    | Promise<CodexThreadPolicyOverrides | undefined>
    | CodexThreadPolicyOverrides
    | undefined;
  readonly verifyThread?: (context: {
    readonly nativeThreadId: string;
    readonly threadContext: CodexThreadContext;
    readonly controls: CodexControlClient;
  }) => Promise<void> | void;
  readonly onNotification?: (event: CodexNotificationEvent) => void;
  readonly onServerRequest?: (event: CodexServerRequestEvent) => void;
  readonly serverRequestDelivery?: 'external-only' | 'all';
  readonly onDisconnect?: (error: Error) => void;
  readonly limits: Map<string, PlanLimits>;
}

/** Mark and drain a local driver-started turn when `turn/interrupt` targets its exact `codexTurnId`. */
export function interruptLocalCodexTurn(
  turn: CodexTurnSlot | undefined,
  turnId: string,
): void {
  if (turn === undefined || turn.codexTurnId !== turnId) return;
  turn.state.interruptRequested = true;
  drainEngineRequests(turn, codexStopped);
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
  ensureAlive(): void;
  getTurn(): CodexTurnSlot | undefined;
  setTurn(turn: CodexTurnSlot | undefined): void;
}): (turnInput: CodexTurnInput) => Promise<CodexTurn> {
  return guardedTurnStarter({
    busyMessage: 'A turn is already running in this Codex thread',
    check: (turnInput: CodexTurnInput) => {
      input.ensureAlive();
      if (input.getTurn() !== undefined) {
        throw new Error('A turn is already running in this Codex thread');
      }
      validateCodexTurnStartOverrides(turnInput, input.activeModelProvider);
    },
    inline: (turnInput) =>
      inlineCodexParts(turnInput.input, {
        ...input.config,
        driverLabel: 'The Codex driver',
        signal: input.signal,
      }),
    dispatch: async (turnInput, parts) => {
      const turnParams = buildCodexTurnStartParams(
        input.threadId,
        turnInput,
        parts,
        input.activeModelProvider,
      );
      const turn: CodexTurnSlot = {
        state: { turnId: turnInput.turnId, interruptRequested: false },
        channel: createTurnDeltaChannel(),
        pending: new Map(),
      };
      input.setTurn(turn);
      let nativeTurnId: string;
      try {
        const started = await input.peer.request('turn/start', turnParams);
        nativeTurnId = CodexStartedTurnSchema.parse(started).turn.id;
        turn.codexTurnId = nativeTurnId;
      } catch (error) {
        if (input.getTurn() === turn) input.setTurn(undefined);
        throw error;
      }
      return {
        nativeTurnId,
        deltas: turn.channel,
        async interrupt() {
          interruptLocalCodexTurn(turn, nativeTurnId);
          await input.peer.request('turn/interrupt', {
            threadId: input.threadId,
            turnId: nativeTurnId,
          });
        },
        async respond(interactionId, rawReply) {
          answerActiveCodexTurnRequest(turn, interactionId, rawReply);
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
    readonly nativeThreadId?: string;
    readonly forkFrom?: CodexOpenForkOptions;
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
