import { raceAbort } from '../../internal/abort-race';
import type { AgentEngineTurn } from '../engine';
import {
  answerEngineRequest,
  drainEngineRequests,
  type EngineRequestTurn,
  endEngineTurn,
  holdEngineRequest,
  loseEngineTurn,
} from '../engine-requests';
import { InteractionReplySchema } from '../executor-contract';
import type { PlanLimits } from '../hello';
import { type DriverImageOptions, imageTurnStarter } from '../image-input';
import {
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcError,
  type JsonRpcPeer,
  type JsonRpcValue,
} from '../json-rpc-peer';
import { mergeRateLimitEvent } from '../plan-limits';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import {
  createTurnDeltaChannel,
  nonEmptyString,
  offerTurnDelta,
  sessionAbort,
  stopConnection,
} from '../session-primitives';
import { type CodexTurnState, classifyCodexNotification } from './classify';
import { type CodexConnectConfig, connectCodex } from './connect';
import { codexPlanWindows } from './limits';
import {
  CODEX_APPROVAL_DECISION,
  CODEX_APPROVAL_REQUESTS,
  CODEX_INPUT_REQUEST,
  CodexApprovalParamsSchema,
  CodexStartedThreadSchema,
  CodexStartedTurnSchema,
  type CodexThreadContext,
  CodexUserInputAnswersSchema,
  CodexUserInputParamsSchema,
  extractCodexThreadContext,
} from './protocol';
import {
  buildCodexThreadPolicyParams,
  buildCodexTurnStartParams,
  type CodexControlClient,
  type CodexSession,
  type CodexThreadPolicyOverrides,
  type CodexTurnInput,
  createCodexControlClient,
  createCodexSessionMutators,
  validateCodexTurnStartOverrides,
} from './session-controls';

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
  }) =>
    | Promise<CodexThreadPolicyOverrides | undefined>
    | CodexThreadPolicyOverrides
    | undefined;
  readonly verifyThread?: (context: {
    readonly nativeThreadId: string;
    readonly threadContext: CodexThreadContext;
    readonly controls: CodexControlClient;
  }) => Promise<void> | void;
  readonly limits: Map<string, PlanLimits>;
}

/** The turn running in a session, and the engine's requests it is still to answer, by method. */
interface CodexTurnSlot extends EngineRequestTurn<JsonRpcValue, { method: string }> {
  readonly state: CodexTurnState;
  codexTurnId?: string;
}

function approvalDetail(params: unknown) {
  const asked = CodexApprovalParamsSchema.parse(params);
  const callId = nonEmptyString(asked.itemId);
  return {
    ...(callId !== undefined && { callId }),
    ...(typeof asked.command === 'string' && { prompt: asked.command }),
  };
}

function inputDetail(params: unknown) {
  const asked = CodexUserInputParamsSchema.parse(params);
  const callId = nonEmptyString(asked.itemId);
  return {
    ...(callId !== undefined && { callId }),
    input: asked.questions.map((question) => ({
      id: question.id,
      question: question.question,
    })),
  };
}

function codexStoppedAnswer(method: string): JsonRpcValue {
  return CODEX_APPROVAL_REQUESTS.has(method)
    ? { decision: CODEX_APPROVAL_DECISION.interrupted }
    : { answers: {} };
}

const codexStopped = (waiting: { detail: { method: string } }) =>
  codexStoppedAnswer(waiting.detail.method);

function createCodexHandlers(state: {
  profileId: string;
  limits: Map<string, PlanLimits>;
  getTurn: () => CodexTurnSlot | undefined;
  clearTurn: () => void;
}) {
  return {
    onNotification(method: string, params: unknown) {
      const turn = state.getTurn();
      let verdict: ReturnType<typeof classifyCodexNotification>;
      try {
        verdict = classifyCodexNotification(
          method,
          params,
          turn?.state ?? { turnId: 'between-turns', interruptRequested: false },
        );
      } catch (error) {
        if (turn !== undefined) {
          offerTurnDelta(turn.channel, {
            type: 'error',
            turnId: turn.state.turnId,
            itemId: `unhandled:${method}`,
            raw: { source: 'codex', type: method },
            kind: 'unhandled',
            message: `Codex notification ${method} did not match schema: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
      switch (verdict.kind) {
        case 'limits':
          try {
            state.limits.set(
              state.profileId,
              mergeRateLimitEvent({
                previous: state.limits.get(state.profileId),
                windows: codexPlanWindows(verdict.rateLimits),
                now: new Date(),
              }),
            );
          } catch (error) {
            if (turn !== undefined) {
              offerTurnDelta(turn.channel, {
                type: 'error',
                turnId: turn.state.turnId,
                itemId: `unhandled:${method}`,
                raw: { source: 'codex', type: method },
                kind: 'unhandled',
                message: `Codex rate-limit update could not be merged: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }
          return;
        case 'resolved':
          if (turn?.pending.delete(verdict.requestId)) {
            offerTurnDelta(turn.channel, {
              type: 'request-resolved',
              turnId: turn.state.turnId,
              itemId: `resolved:${verdict.requestId}`,
              raw: { source: 'codex', type: 'serverRequest/resolved' },
              interactionId: verdict.requestId,
            });
          }
          return;
        case 'deltas':
        case 'unhandled':
          if (turn !== undefined)
            for (const delta of verdict.kind === 'deltas' ? verdict.deltas : [verdict.delta])
              offerTurnDelta(turn.channel, delta);
          return;
        case 'end':
          endEngineTurn(turn, codexStopped, verdict.deltas);
          state.clearTurn();
          return;
        case 'ignore':
          return;
      }
    },
    onRequest(method: string, params: unknown, id: string | number) {
      const turn = state.getTurn();
      const known = CODEX_APPROVAL_REQUESTS.has(method) || method === CODEX_INPUT_REQUEST;
      if (turn === undefined || !known) {
        if (turn !== undefined) {
          offerTurnDelta(turn.channel, {
            type: 'error',
            turnId: turn.state.turnId,
            itemId: `unhandled-request:${id}`,
            raw: { source: 'codex', type: method },
            kind: 'unhandled',
            message: `Codex request ${method} is not known to this driver; refused`,
          });
        }
        throw new JsonRpcError(
          JSON_RPC_METHOD_NOT_FOUND,
          `${method} is not handled by this executor`,
        );
      }
      const interactionId = String(id);
      const approval = CODEX_APPROVAL_REQUESTS.has(method);
      return new Promise<JsonRpcValue>((resolve) => {
        holdEngineRequest(turn, {
          interactionId,
          detail: { method },
          answeredBy: { source: 'codex', type: method },
          delta: () => ({
            type: 'request',
            turnId: turn.state.turnId,
            itemId: `request:${interactionId}`,
            raw: { source: 'codex', type: method },
            interactionId,
            kind: approval ? 'approval' : 'input',
            ...(approval ? approvalDetail(params) : inputDetail(params)),
          }),
          refusal: codexStoppedAnswer(method),
          resolve,
        });
      });
    },
  };
}

function createCodexStartTurn(input: {
  config: CodexSessionConfig;
  peer: JsonRpcPeer;
  threadId: string;
  activeModelProvider: string | undefined;
  signal: AbortSignal;
  ensureAlive(): void;
  getTurn(): CodexTurnSlot | undefined;
  setTurn(turn: CodexTurnSlot | undefined): void;
}) {
  return imageTurnStarter<CodexTurnInput, AgentEngineTurn>({
    driverLabel: 'The Codex driver',
    busyMessage: 'A turn is already running in this Codex thread',
    imageOptions: input.config,
    signal: input.signal,
    check(turnInput) {
      input.ensureAlive();
      if (input.getTurn() !== undefined)
        throw new Error('A turn is already running in this Codex thread');
      validateCodexTurnStartOverrides(turnInput, input.activeModelProvider);
    },
    async dispatch(turnInput, parts) {
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
      try {
        const started = await input.peer.request('turn/start', turnParams);
        turn.codexTurnId = CodexStartedTurnSchema.parse(started).turn.id;
      } catch (error) {
        if (input.getTurn() === turn) input.setTurn(undefined);
        throw error;
      }
      return {
        deltas: turn.channel,
        async interrupt() {
          turn.state.interruptRequested = true;
          drainEngineRequests(turn, codexStopped);
          if (turn.codexTurnId !== undefined) {
            await input.peer.request('turn/interrupt', {
              threadId: input.threadId,
              turnId: turn.codexTurnId,
            });
          }
        },
        async respond(interactionId, rawReply) {
          const reply = InteractionReplySchema.shape.reply.parse(rawReply);
          const waiting = turn.pending.get(interactionId);
          if (waiting === undefined)
            throw new TypeError(`Unknown interaction ${interactionId} for this turn`);
          if (CODEX_APPROVAL_REQUESTS.has(waiting.detail.method)) {
            if (reply.kind === 'input')
              throw new TypeError(
                'A Codex approval is approved or denied, not answered with input',
              );
            answerEngineRequest(turn, interactionId, {
              decision:
                reply.kind === 'approve'
                  ? CODEX_APPROVAL_DECISION.approve
                  : CODEX_APPROVAL_DECISION.deny,
            });
          } else {
            if (reply.kind !== 'input')
              throw new TypeError('A Codex input request is answered with input');
            answerEngineRequest(turn, interactionId, {
              answers: CodexUserInputAnswersSchema.parse(reply.value),
            });
          }
        },
      };
    },
  });
}

/**
 * One app-server connection holding one thread. Server requests the driver knows
 * become `request` deltas answered by `respond`; any other is refused at once with
 * `-32601`, so no unanswered request hangs a turn.
 */
export async function openCodexSession(
  config: CodexSessionConfig,
  input: {
    profile: ExecutorProfileConfig;
    cwd: string;
    nativeThreadId?: string;
    signal?: AbortSignal;
  },
): Promise<CodexSession> {
  const profile = engineProfile('codex', input.profile);
  const linked = sessionAbort(input.signal);
  let current: CodexTurnSlot | undefined;
  let dead: Error | undefined;
  let closing = false;
  let connected: Awaited<ReturnType<typeof connectCodex>>;
  try {
    connected = await connectCodex(
      config,
      profile,
      input.cwd,
      linked.signal,
      createCodexHandlers({
        profileId: profile.profileId,
        limits: config.limits,
        getTurn: () => current,
        clearTurn: () => {
          current = undefined;
        },
      }),
      (error) => {
        dead = error;
        const turn = current;
        current = undefined;
        loseEngineTurn(turn, codexStopped, error);
        linked.abort();
      },
    );
  } catch (error) {
    linked.release();
    throw error;
  }
  const { peer, providerPid } = connected;
  const ensureAlive = () => {
    if (closing) throw new Error('The Codex session is closed');
    if (dead !== undefined) throw dead;
  };
  const stop = async (primary?: { error: unknown }) => {
    closing = true;
    try {
      await stopConnection(connected, primary);
    } finally {
      linked.abort();
      linked.release();
    }
  };
  const controlClient = createCodexControlClient({ peer, ensureAlive });

  let threadId: string;
  let threadContext: CodexThreadContext;
  let dynamicOverrides: CodexThreadPolicyOverrides | undefined;
  try {
    if (config.prepareThread !== undefined) {
      dynamicOverrides = await raceAbort(
        Promise.resolve(
          config.prepareThread({
            controls: controlClient,
            cwd: input.cwd,
            ...(input.nativeThreadId !== undefined && {
              nativeThreadId: input.nativeThreadId,
            }),
          }),
        ),
        linked.signal,
      );
      linked.signal.throwIfAborted();
    }
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
    const threadParams: Record<string, JsonRpcValue> = {
      cwd: input.cwd,
      ...buildCodexThreadPolicyParams(basePolicy, dynamicOverrides),
    };
    const opened = input.nativeThreadId
      ? await peer.request('thread/resume', {
          threadId: input.nativeThreadId,
          excludeTurns: true,
          ...threadParams,
        })
      : await peer.request('thread/start', threadParams);
    const parsed = CodexStartedThreadSchema.parse(opened);
    threadId = parsed.thread.id;
    threadContext = extractCodexThreadContext(parsed);
    if (config.verifyThread !== undefined) {
      await raceAbort(
        Promise.resolve(
          config.verifyThread({
            nativeThreadId: threadId,
            threadContext,
            controls: controlClient,
          }),
        ),
        linked.signal,
      );
      linked.signal.throwIfAborted();
    }
  } catch (error) {
    await stop({ error });
    throw error;
  }

  const activeModelProvider =
    threadContext.modelProvider ?? dynamicOverrides?.modelProvider ?? config.modelProvider;
  const startTurn = createCodexStartTurn({
    config,
    peer,
    threadId,
    activeModelProvider,
    signal: linked.signal,
    ensureAlive,
    getTurn: () => current,
    setTurn: (turn) => {
      current = turn;
    },
  });
  const mutators = createCodexSessionMutators({
    peer,
    threadId,
    imageOptions: config,
    signal: linked.signal,
    ensureAlive,
    getActiveTurn: () => current,
  });

  return {
    nativeThreadId: threadId,
    providerPid,
    threadContext,
    startTurn,
    ...controlClient,
    ...mutators,
    async close() {
      await stop();
    },
  };
}
