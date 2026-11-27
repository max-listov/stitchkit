import { withLinkedAbortSignals } from '../../internal/abort-race';
import type { DriverImageOptions } from '../image-input';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import { safeJsonValue } from '../session-primitives';
import {
  type CodexApprovalPolicy,
  CodexApprovalPolicySchema,
  type CodexCollaborationMode,
  CodexCollaborationModeSchema,
  type CodexSandboxPolicy,
  CodexSandboxPolicySchema,
  CodexStartedThreadSchema,
  extractCodexThreadContext,
  parseCodexResponse,
} from './protocol';
import type {
  CodexForkedThread,
  CodexForkThreadOptions,
  CodexSteerTurnInput,
  CodexThreadPolicyOverrides,
} from './session-types';
import {
  assertNonEmptyThreadId,
  assertOptionalNonEmptyNoNulString,
  assertOptionalNonEmptyString,
  assertRequiredNonEmptyString,
  type CodexRpcCallOptions,
  validateCodexRpcCallOptions,
} from './thread-controls';
import {
  codexTurnInput,
  type InlinedCodexPart,
  inlineCodexParts,
  sendCodexTurnSteer,
} from './turn-input';

/** Common per-turn start parameters shared by {@link CodexSession.startTurn} and {@link CodexControlClient.startThreadTurn}. */
export interface CodexTurnStartOverrideFields {
  readonly clientId: string;
  readonly cwd?: string | undefined;
  readonly model?: string | undefined;
  readonly modelProvider?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly collaborationMode?: CodexCollaborationMode | undefined;
  readonly approvalPolicy?: CodexApprovalPolicy | undefined;
  readonly sandboxPolicy?: CodexSandboxPolicy | undefined;
  readonly runtimeWorkspaceRoots?: readonly string[] | undefined;
}

/** Validate `beforeTurnId` and `lastTurnId` mutual exclusion for `thread/fork`. */
export function validateCodexForkBounds(
  options: Pick<CodexForkThreadOptions, 'beforeTurnId' | 'lastTurnId'>,
  caller: string,
): void {
  if (options.beforeTurnId !== undefined && options.lastTurnId !== undefined) {
    throw new TypeError(
      `[stitchkit] ${caller}: beforeTurnId and lastTurnId are mutually exclusive`,
    );
  }
}

/** Validate `runtimeWorkspaceRoots` and `config` policy overrides before sending them to Codex. */
export function validateCodexPolicyOverrides(
  overrides: Pick<CodexThreadPolicyOverrides, 'runtimeWorkspaceRoots' | 'config'>,
  caller: string,
): void {
  if (overrides.runtimeWorkspaceRoots !== undefined) {
    if (!Array.isArray(overrides.runtimeWorkspaceRoots)) {
      throw new TypeError(
        `[stitchkit] ${caller}: runtimeWorkspaceRoots must be an array of strings`,
      );
    }
    for (const root of overrides.runtimeWorkspaceRoots) {
      if (typeof root !== 'string' || root.trim().length === 0) {
        throw new TypeError(
          `[stitchkit] ${caller}: every runtimeWorkspaceRoots entry must be a non-empty string`,
        );
      }
    }
  }
  if (overrides.config !== undefined) {
    if (
      typeof overrides.config !== 'object' ||
      overrides.config === null ||
      Array.isArray(overrides.config)
    ) {
      throw new TypeError(`[stitchkit] ${caller}: config must be a plain JSON object`);
    }
    safeJsonValue(overrides.config);
  }
}

/** Build JSON-RPC params for `thread/start`, `thread/resume`, or `thread/fork` from merged policy fields. */
export function buildCodexThreadPolicyParams(
  base: CodexThreadPolicyOverrides,
  overrides: CodexThreadPolicyOverrides | undefined,
): Record<string, JsonRpcValue> {
  const mergedConfig =
    base.config !== undefined || overrides?.config !== undefined
      ? { ...(base.config ?? {}), ...(overrides?.config ?? {}) }
      : undefined;
  const merged: CodexThreadPolicyOverrides = {
    ...base,
    ...overrides,
    ...(mergedConfig !== undefined && { config: mergedConfig }),
  };
  validateCodexPolicyOverrides(merged, 'CodexSession');
  const params: Record<string, JsonRpcValue> = {};
  if (merged.model !== undefined) params.model = merged.model;
  if (merged.modelProvider !== undefined) params.modelProvider = merged.modelProvider;
  if (merged.approvalPolicy !== undefined)
    params.approvalPolicy = safeJsonValue(merged.approvalPolicy);
  if (merged.sandbox !== undefined) params.sandbox = merged.sandbox;
  if (merged.developerInstructions !== undefined)
    params.developerInstructions = merged.developerInstructions;
  if (merged.runtimeWorkspaceRoots !== undefined)
    params.runtimeWorkspaceRoots = [...merged.runtimeWorkspaceRoots];
  if (merged.config !== undefined) params.config = safeJsonValue(merged.config);
  return params;
}

/** Validate per-turn overrides eagerly before host image files are read. */
export function validateCodexTurnStartOverrides(
  caller: string,
  turnInput: CodexTurnStartOverrideFields,
  activeModelProvider?: string,
): void {
  assertRequiredNonEmptyString(turnInput.clientId, 'clientId', caller);
  assertOptionalNonEmptyNoNulString(turnInput.cwd, 'cwd', caller);
  if (turnInput.modelProvider !== undefined) {
    if (activeModelProvider === undefined || turnInput.modelProvider !== activeModelProvider) {
      throw new TypeError(
        `Codex turn/start cannot switch modelProvider to ${JSON.stringify(turnInput.modelProvider)} (thread active provider is ${JSON.stringify(activeModelProvider ?? 'unknown')})`,
      );
    }
  }
  if (turnInput.collaborationMode !== undefined) {
    CodexCollaborationModeSchema.parse(turnInput.collaborationMode);
  }
  if (turnInput.approvalPolicy !== undefined) {
    CodexApprovalPolicySchema.parse(turnInput.approvalPolicy);
  }
  if (turnInput.sandboxPolicy !== undefined) {
    CodexSandboxPolicySchema.parse(turnInput.sandboxPolicy);
    safeJsonValue(turnInput.sandboxPolicy);
  }
  if (turnInput.runtimeWorkspaceRoots !== undefined) {
    validateCodexPolicyOverrides(
      { runtimeWorkspaceRoots: turnInput.runtimeWorkspaceRoots },
      caller,
    );
  }
}

/** Build validated `turn/start` RPC parameters from turn input and inlined parts. */
export function buildCodexTurnStartRpcParams(
  caller: string,
  threadId: string,
  turnInput: CodexTurnStartOverrideFields,
  parts: readonly InlinedCodexPart[],
  activeModelProvider?: string,
): Record<string, JsonRpcValue> {
  validateCodexTurnStartOverrides(caller, turnInput, activeModelProvider);
  const params: Record<string, JsonRpcValue> = {
    threadId,
    input: codexTurnInput(parts),
    clientUserMessageId: turnInput.clientId,
  };
  if (turnInput.cwd !== undefined) params.cwd = turnInput.cwd;
  if (turnInput.model !== undefined) params.model = turnInput.model;
  if (turnInput.reasoningEffort !== undefined) params.effort = turnInput.reasoningEffort;
  if (turnInput.collaborationMode !== undefined) {
    params.collaborationMode = CodexCollaborationModeSchema.parse(turnInput.collaborationMode);
  }
  if (turnInput.approvalPolicy !== undefined) {
    params.approvalPolicy = safeJsonValue(turnInput.approvalPolicy);
  }
  if (turnInput.sandboxPolicy !== undefined) {
    params.sandboxPolicy = safeJsonValue(turnInput.sandboxPolicy);
  }
  if (turnInput.runtimeWorkspaceRoots !== undefined) {
    params.runtimeWorkspaceRoots = [...turnInput.runtimeWorkspaceRoots];
  }
  return params;
}

/** Create session-bound turn/thread mutators (`steerTurn`, `forkThread`) for a live Codex session. */
export function createCodexSessionMutators(input: {
  peer: JsonRpcPeer;
  threadId: string;
  imageOptions: DriverImageOptions;
  signal: AbortSignal;
  ensureAlive(): void;
  getActiveTurn(): { readonly codexTurnId?: string } | undefined;
}) {
  return {
    async steerTurn(
      steerInput: CodexSteerTurnInput & { readonly threadId?: string | undefined },
      rpcOptions?: CodexRpcCallOptions,
    ): Promise<{ readonly turnId: string }> {
      input.ensureAlive();
      validateCodexRpcCallOptions(rpcOptions);
      const caller = 'CodexSession.steerTurn';
      const targetThreadId =
        steerInput.threadId === undefined
          ? input.threadId
          : assertNonEmptyThreadId(steerInput.threadId, caller);
      assertOptionalNonEmptyString(steerInput.clientId, 'clientId', caller);
      assertOptionalNonEmptyString(steerInput.expectedTurnId, 'expectedTurnId', caller);
      if (targetThreadId !== input.threadId) {
        const expectedTurnId = assertRequiredNonEmptyString(
          steerInput.expectedTurnId,
          'expectedTurnId',
          caller,
        );
        const parts = await withLinkedAbortSignals(
          rpcOptions?.signal,
          input.signal,
          (signal) =>
            inlineCodexParts(steerInput.input, {
              ...input.imageOptions,
              driverLabel: 'The Codex driver',
              signal,
            }),
        );
        input.ensureAlive();
        validateCodexRpcCallOptions(rpcOptions);
        return sendCodexTurnSteer(
          input.peer,
          {
            threadId: targetThreadId,
            expectedTurnId,
            parts,
            ...(steerInput.clientId !== undefined && { clientId: steerInput.clientId }),
          },
          rpcOptions,
        );
      }
      const active = input.getActiveTurn();
      let expectedTurnId: string;
      if (active !== undefined) {
        if (active.codexTurnId === undefined) {
          throw new Error('Cannot steer turn: no Codex turn is currently running');
        }
        if (
          steerInput.expectedTurnId !== undefined &&
          steerInput.expectedTurnId !== active.codexTurnId
        ) {
          throw new TypeError(
            `Expected active Codex turn ${steerInput.expectedTurnId}, but current turn is ${active.codexTurnId}`,
          );
        }
        expectedTurnId = active.codexTurnId;
      } else {
        if (steerInput.expectedTurnId === undefined) {
          throw new Error('Cannot steer turn: no Codex turn is currently running');
        }
        expectedTurnId = steerInput.expectedTurnId;
      }
      const parts = await withLinkedAbortSignals(rpcOptions?.signal, input.signal, (signal) =>
        inlineCodexParts(steerInput.input, {
          ...input.imageOptions,
          driverLabel: 'The Codex driver',
          signal,
        }),
      );
      input.ensureAlive();
      validateCodexRpcCallOptions(rpcOptions);
      const afterAwait = input.getActiveTurn();
      if (active !== undefined) {
        if (afterAwait !== active || afterAwait.codexTurnId !== expectedTurnId) {
          throw new Error(
            'Cannot steer turn: the active Codex turn ended before steering was sent',
          );
        }
      } else if (afterAwait !== undefined && afterAwait.codexTurnId !== expectedTurnId) {
        throw new TypeError(
          `Expected active Codex turn ${expectedTurnId}, but current turn is ${afterAwait.codexTurnId ?? 'starting'}`,
        );
      }
      return sendCodexTurnSteer(
        input.peer,
        {
          threadId: input.threadId,
          expectedTurnId,
          parts,
          ...(steerInput.clientId !== undefined && { clientId: steerInput.clientId }),
        },
        rpcOptions,
      );
    },
    async forkThread(
      options: CodexForkThreadOptions = {},
      rpcOptions?: CodexRpcCallOptions,
    ): Promise<CodexForkedThread> {
      input.ensureAlive();
      validateCodexRpcCallOptions(rpcOptions);
      validateCodexForkBounds(options, 'CodexSession.forkThread');
      const policyParams = buildCodexThreadPolicyParams({}, options);
      const forked = parseCodexResponse(
        'thread/fork',
        CodexStartedThreadSchema,
        await input.peer.request(
          'thread/fork',
          {
            threadId: input.threadId,
            ...policyParams,
            ...(options.cwd !== undefined && { cwd: options.cwd }),
            ...(options.beforeTurnId !== undefined && { beforeTurnId: options.beforeTurnId }),
            ...(options.lastTurnId !== undefined && { lastTurnId: options.lastTurnId }),
            ...(options.excludeTurns !== undefined && { excludeTurns: options.excludeTurns }),
            ...(options.deferGoalContinuation !== undefined && {
              deferGoalContinuation: options.deferGoalContinuation,
            }),
          },
          rpcOptions,
        ),
      );
      return {
        nativeThreadId: forked.thread.id,
        threadContext: extractCodexThreadContext(forked),
      };
    },
  };
}
