import { randomUUID } from 'node:crypto';
import type { AgentEngineDriver, AgentEngineSession, AgentEngineTurn } from '../engine';
import { answerEngineRequest, drainEngineRequests, loseEngineTurn } from '../engine-requests';
import { type InteractionReply, InteractionReplySchema } from '../executor-contract';
import {
  type ExecutorDriverCapabilities,
  ExecutorDriverCapabilitiesSchema,
  type ExecutorEngine,
  ExecutorEngineSchema,
  type PlanLimits,
} from '../hello';
import { engineProfile } from '../profile';
import { createTurnDeltaChannel, emitStartupPhase, sessionAbort } from '../session-primitives';
import type { ReplayGate } from './replay-gate';
import { type ReplayTurnSlot, runReplayTurnScript } from './replay-runner';
import {
  type ExecutorReplayTranscript,
  ExecutorReplayTranscriptSchema,
  parseReplayTranscript,
} from './replay-transcript';

const DENY_INTERRUPTED: InteractionReply['reply'] = {
  kind: 'deny',
  message: 'The turn was interrupted',
};
const DENY_CLOSED: InteractionReply['reply'] = {
  kind: 'deny',
  message: 'The replay session closed',
};

/** Configuration for {@link createReplayExecutorDriver}. */
export interface ReplayExecutorDriverConfig {
  /** Which wire engine identity to emulate (any existing {@link ExecutorEngine}; default `'acp'`). */
  readonly engine?: ExecutorEngine;
  /** Reconcile strategy emulated by this driver (`'none'` default, or `'client-id'` with `findInput`). */
  readonly reconcile?: 'client-id' | 'none';
  /** One transcript per turn (NDJSON string or validated {@link ExecutorReplayTranscript}). */
  readonly turns: readonly (string | ExecutorReplayTranscript)[];
  /** Optional label gate pausing execution on `{ kind: 'gate', label }` steps. */
  readonly gate?: ReplayGate;
  /** Workspace path substituted for `<workspace>` placeholders in NDJSON transcripts. */
  readonly workspace?: string;
  /** Optional capability overrides merged onto engine defaults and validated strictly. */
  readonly capabilities?: Partial<ExecutorDriverCapabilities>;
  /** Engine version string reported in `info()`. Default `'replay-1.0.0'`. */
  readonly version?: string;
  /** Optional model ids advertised by `info()`. When omitted, `info().models` is `'not-asked'`. */
  readonly models?: readonly string[];
  /** When `true`, `session.close()` fails if any configured turns or required steps were not consumed. */
  readonly assertCompleteOnClose?: boolean;
}

/** In-process deterministic replay driver adding inspection and completeness assertions. */
export interface ReplayExecutorDriver extends AgentEngineDriver {
  readonly capabilities: ExecutorDriverCapabilities;
  /** Count of user inputs recorded for `nativeThreadId`. */
  inputsFor(nativeThreadId: string): number;
  /** Whether the engine received an answer (from host or auto-drain) for `interactionId`. */
  wasAnswered(interactionId: string): boolean;
  /** Throw if any scripted turn did not complete or any required `expectReply` step lacked a host reply. */
  assertComplete(): void;
}

function defaultReplayCapabilities(
  engine: ExecutorEngine,
  overrides: Partial<ExecutorDriverCapabilities> | undefined,
): ExecutorDriverCapabilities {
  const base: ExecutorDriverCapabilities = {
    runtimePolicyEnforcement: engine === 'acp' ? 'client-boundary' : 'native',
    sessionApproval: true,
    interruptOnDeny: true,
    updatedToolInput: engine === 'claude-cli' || engine === 'claude-sdk',
    structuredInput: true,
    steer: false,
    fork: false,
    revert: false,
    compact: false,
    injectItems: false,
    backgroundWorkOutlivesTurn: false,
    multiThreadPerProcess: false,
    images: false,
    planLimits: 'passive',
  };
  return ExecutorDriverCapabilitiesSchema.parse({ ...base, ...overrides });
}

function normalizeTurns(
  rawTurns: readonly (string | ExecutorReplayTranscript)[],
  workspace: string | undefined,
): ExecutorReplayTranscript[] {
  return rawTurns.map((entry) =>
    typeof entry === 'string'
      ? parseReplayTranscript(entry, workspace !== undefined ? { workspace } : {})
      : ExecutorReplayTranscriptSchema.parse(entry),
  );
}

/**
 * Create an in-process, zero-subprocess, deterministic replay {@link AgentEngineDriver}
 * over NDJSON transcripts for local development and e2e tests.
 */
export function createReplayExecutorDriver(
  config: ReplayExecutorDriverConfig,
): ReplayExecutorDriver {
  const engine = ExecutorEngineSchema.parse(config.engine ?? 'acp');
  const reconcile = config.reconcile ?? 'none';
  if (reconcile !== 'client-id' && reconcile !== 'none') {
    throw new TypeError(`Unsupported replay reconcile mode: ${String(reconcile)}`);
  }
  const capabilities = defaultReplayCapabilities(engine, config.capabilities);
  const transcripts = normalizeTurns(config.turns, config.workspace);
  const version = config.version ?? 'replay-1.0.0';
  const limits = new Map<string, PlanLimits>();
  const recordedInputs = new Map<string, Set<string>>();
  const answeredIds = new Set<string>();
  const hostAnsweredIds = new Set<string>();
  let nextTurnIndex = 0;
  let completedTurns = 0;

  const assertComplete = () => {
    if (completedTurns < transcripts.length) {
      throw new Error(
        `Replay driver incomplete: completed ${completedTurns} of ${transcripts.length} scripted turn(s)`,
      );
    }
    const missingRequired: string[] = [];
    for (const transcript of transcripts) {
      for (const step of transcript.steps) {
        if (
          step.kind === 'expectReply' &&
          step.required !== false &&
          !hostAnsweredIds.has(step.interactionId)
        ) {
          missingRequired.push(`expectReply:${step.interactionId}`);
        }
      }
    }
    if (missingRequired.length > 0) {
      throw new Error(
        `Replay driver incomplete: unconsumed required step(s): ${missingRequired.join(', ')}`,
      );
    }
  };

  return {
    engine,
    reconcile,
    capabilities,
    ...(engine === 'acp' ? { approvalEnforcement: 'agent-initiated' as const } : {}),
    async info() {
      return {
        engine,
        version,
        reconcile,
        models:
          config.models !== undefined
            ? { answer: 'listed', ids: [...config.models] }
            : { answer: 'not-asked' },
        capabilities,
      };
    },
    async status(rawProfile) {
      const profile = engineProfile(engine, rawProfile);
      const known = limits.get(profile.profileId);
      return {
        login: { state: 'signed-in' },
        effectiveCredential: 'subscription',
        ...(known !== undefined && { planLimits: known }),
      };
    },
    ...(reconcile === 'client-id'
      ? {
          async findInput(input: { nativeThreadId: string; clientId: string }) {
            return recordedInputs.get(input.nativeThreadId)?.has(input.clientId) ?? false;
          },
        }
      : {}),
    inputsFor: (nativeThreadId) => recordedInputs.get(nativeThreadId)?.size ?? 0,
    wasAnswered: (interactionId) => answeredIds.has(interactionId),
    assertComplete,
    async open(openInput): Promise<AgentEngineSession> {
      const profile = engineProfile(engine, openInput.profile);
      const linked = sessionAbort(openInput.signal);
      emitStartupPhase(openInput.onStartupPhase, 'initializing');
      const nativeThreadId = openInput.nativeThreadId ?? `replay-thread-${randomUUID()}`;
      let closed = false;
      let activeTurn: ReplayTurnSlot | undefined;
      let activeTurnPromise: Promise<void> | undefined;

      return {
        nativeThreadId,
        async startTurn(turnInput): Promise<AgentEngineTurn> {
          if (closed) throw new Error('The replay session is closed');
          if (activeTurn !== undefined) {
            throw new Error('A turn is already running in this replay session');
          }
          const script = transcripts[nextTurnIndex];
          if (script === undefined) {
            throw new Error(`No replay transcript available for turn index ${nextTurnIndex}`);
          }
          nextTurnIndex += 1;
          let seen = recordedInputs.get(nativeThreadId);
          if (seen === undefined) {
            seen = new Set();
            recordedInputs.set(nativeThreadId, seen);
          }
          seen.add(turnInput.clientId);

          const turn: ReplayTurnSlot = {
            turnId: turnInput.turnId,
            state: { turnId: turnInput.turnId, interruptRequested: false },
            channel: createTurnDeltaChannel(),
            pending: new Map(),
            interruptWaiters: [],
            replyPromises: new Map(),
          };
          activeTurn = turn;
          const runPromise = runReplayTurnScript({
            script,
            turn,
            engine,
            profileId: profile.profileId,
            limits,
            answeredIds,
            hostAnsweredIds,
            ...(config.gate !== undefined && { gate: config.gate }),
            signal: linked.signal,
            onTurnCompleted: () => {
              completedTurns += 1;
            },
            clearActiveTurn: () => {
              if (activeTurn === turn) activeTurn = undefined;
              if (activeTurnPromise === runPromise) activeTurnPromise = undefined;
            },
          });
          activeTurnPromise = runPromise;

          return {
            deltas: turn.channel,
            async interrupt() {
              turn.state.interruptRequested = true;
              drainEngineRequests(turn, () => DENY_INTERRUPTED);
              for (const wake of turn.interruptWaiters.splice(0)) wake();
            },
            async respond(interactionId, rawReply) {
              if (!turn.pending.has(interactionId)) {
                throw new TypeError(`Unknown interaction ${interactionId} for this turn`);
              }
              const parsed = InteractionReplySchema.shape.reply.safeParse(rawReply);
              if (!parsed.success) {
                throw new TypeError(`Invalid interaction reply: ${parsed.error.message}`);
              }
              hostAnsweredIds.add(interactionId);
              answerEngineRequest(turn, interactionId, parsed.data);
            },
          };
        },
        async close() {
          closed = true;
          const running = activeTurn;
          const pendingRun = activeTurnPromise;
          activeTurn = undefined;
          loseEngineTurn(running, () => DENY_CLOSED, new Error('The replay session closed'));
          linked.abort();
          linked.release();
          if (pendingRun !== undefined) await pendingRun;
          if (config.assertCompleteOnClose) assertComplete();
        },
      };
    },
  };
}
