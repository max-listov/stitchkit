import type { AgentEngineSession, AgentEngineTurn } from '../engine';
import { spawnEngineProcess } from '../engine-process';
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
import {
  createJsonRpcPeer,
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcError,
  type JsonRpcPeer,
  type JsonRpcValue,
} from '../json-rpc-peer';
import { mergeRateLimitEvent } from '../plan-limits';
import { type ExecutorProfileConfig, engineEnvironment, engineProfile } from '../profile';
import {
  createTurnDeltaChannel,
  extractTextOnlyInput,
  nonEmptyString,
  offerTurnDelta,
  sessionAbort,
  stopConnection,
} from '../session-primitives';
import { type CodexTurnState, classifyCodexNotification } from './classify';
import { codexPlanWindows } from './limits';
import {
  CODEX_APPROVAL_DECISION,
  CODEX_APPROVAL_REQUESTS,
  CODEX_INPUT_REQUEST,
  CODEX_OPTED_OUT_NOTIFICATIONS,
  CodexApprovalParamsSchema,
  CodexStartedThreadSchema,
  CodexStartedTurnSchema,
  CodexUserInputAnswersSchema,
  CodexUserInputParamsSchema,
} from './protocol';

/** How long the app-server may take to initialize and open its thread. */
const BOOTSTRAP_MS = 45_000;
const REQUEST_MS = 60_000;

export interface CodexSessionConfig {
  executable: string;
  prefix: readonly string[];
  model?: string;
  approvalPolicy: string;
  sandbox: string;
  ambient: Readonly<Record<string, string | undefined>>;
  limits: Map<string, PlanLimits>;
  version: string;
}

/** Spawn `codex app-server`, initialize it, and return the peer; the caller owns the process. */
export async function connectCodex(
  config: CodexSessionConfig,
  profile: ExecutorProfileConfig,
  cwd: string,
  signal: AbortSignal,
  handlers: Partial<
    Pick<Parameters<typeof createJsonRpcPeer>[0], 'onRequest' | 'onNotification'>
  > = {},
  /** The app-server's output ended, or carried a line that is not JSON-RPC. */
  onEnd: (error: Error) => void = () => undefined,
) {
  // Everything that can refuse runs before the spawn: nothing after it leaves the app-server running.
  const env = engineEnvironment(profile, config.ambient);
  const peer: JsonRpcPeer = createJsonRpcPeer({
    header: 'omitted',
    requestTimeoutMs: REQUEST_MS,
    send: (line) => engine.send(line),
    ...handlers,
  });
  const engine = spawnEngineProcess({
    executable: config.executable,
    args: [...config.prefix, 'app-server'],
    cwd,
    env,
    signal,
  });
  const reading = (async () => {
    try {
      for await (const line of engine.lines) peer.receive(line);
      const ended = new Error(`Codex app-server exited: ${engine.stderrTail().slice(-2000)}`);
      peer.close(ended);
      onEnd(ended);
    } catch (error) {
      const failed = error instanceof Error ? error : new Error(String(error));
      peer.close(failed);
      onEnd(failed);
      await engine.stop().catch(() => undefined);
    }
  })();
  try {
    await peer.request(
      'initialize',
      {
        clientInfo: { name: 'stitchkit-agent-executor', version: config.version },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: CODEX_OPTED_OUT_NOTIFICATIONS,
        },
      },
      { timeoutMs: BOOTSTRAP_MS },
    );
    peer.notify('initialized');
    return { engine, peer, reading };
  } catch (error) {
    // The reader closes the peer once the stopped process's output ends.
    await stopConnection({ engine, reading }, { error });
    throw error;
  }
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

/**
 * The answer to a request the consumer will not answer — the turn was interrupted,
 * ended or lost its app-server: an approval is `cancel` ("the turn will also be
 * immediately interrupted"), never `decline` ("the agent will continue the turn");
 * an input request gets no answers.
 */
function codexStoppedAnswer(method: string): JsonRpcValue {
  return CODEX_APPROVAL_REQUESTS.has(method)
    ? { decision: CODEX_APPROVAL_DECISION.interrupted }
    : { answers: {} };
}

/** The answer to one held request of a stopped turn, by its method. */
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
          state.limits.set(
            state.profileId,
            mergeRateLimitEvent({
              previous: state.limits.get(state.profileId),
              windows: codexPlanWindows(verdict.rateLimits),
              now: new Date(),
            }),
          );
          return;
        case 'resolved':
          // The engine closed the request itself: nothing is written back to it. The
          // promise `onRequest` returned stays unsettled on purpose — answering would send a
          // response for an id the engine no longer waits on — and the peer keeps no table
          // of inbound requests, so with this entry gone nothing holds it.
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

/**
 * One app-server for one connection, holding one thread. Server requests
 * the driver knows become `request` deltas answered by `respond`; any other
 * is refused at once with `-32601`, so no unanswered request hangs a turn.
 */
export async function openCodexSession(
  config: CodexSessionConfig,
  input: {
    profile: ExecutorProfileConfig;
    cwd: string;
    nativeThreadId?: string;
    signal?: AbortSignal;
  },
): Promise<AgentEngineSession> {
  const profile = engineProfile('codex', input.profile);
  const linked = sessionAbort(input.signal);
  let current: CodexTurnSlot | undefined;
  let dead: Error | undefined;
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
        // The session is over: nothing follows the caller's signal any more.
        linked.abort();
      },
    );
  } catch (error) {
    linked.release();
    throw error;
  }
  const { peer } = connected;
  const stop = async (primary?: { error: unknown }) => {
    linked.abort();
    await stopConnection(connected, primary);
  };
  let threadId: string;
  try {
    const threadParams = {
      cwd: input.cwd,
      approvalPolicy: config.approvalPolicy,
      sandbox: config.sandbox,
      ...(config.model !== undefined && { model: config.model }),
    };
    const opened = input.nativeThreadId
      ? await peer.request('thread/resume', {
          threadId: input.nativeThreadId,
          excludeTurns: true,
          ...threadParams,
        })
      : await peer.request('thread/start', threadParams);
    threadId = CodexStartedThreadSchema.parse(opened).thread.id;
  } catch (error) {
    await stop({ error });
    throw error;
  }
  return {
    nativeThreadId: threadId,
    async startTurn(turnInput): Promise<AgentEngineTurn> {
      if (dead !== undefined) throw dead;
      if (current !== undefined)
        throw new Error('A turn is already running in this Codex thread');
      const text = extractTextOnlyInput(turnInput.input, 'The Codex driver');
      const turn: CodexTurnSlot = {
        state: { turnId: turnInput.turnId, interruptRequested: false },
        channel: createTurnDeltaChannel(),
        pending: new Map(),
      };
      current = turn;
      try {
        const started = await peer.request('turn/start', {
          threadId,
          input: [{ type: 'text', text, text_elements: [] }],
          clientUserMessageId: turnInput.clientId,
        });
        turn.codexTurnId = CodexStartedTurnSchema.parse(started).turn.id;
      } catch (error) {
        if (current === turn) current = undefined;
        throw error;
      }
      return {
        deltas: turn.channel,
        async interrupt() {
          turn.state.interruptRequested = true;
          // Resolve pending approvals/input before sending turn/interrupt so Codex never deadlocks.
          drainEngineRequests(turn, codexStopped);
          if (turn.codexTurnId !== undefined)
            await peer.request('turn/interrupt', { threadId, turnId: turn.codexTurnId });
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
    async close() {
      await stop();
    },
  };
}
