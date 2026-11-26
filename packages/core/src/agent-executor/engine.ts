import type { AgentMessagePart } from '../agent-parts/parts';
import type { InteractionReply } from './executor-contract';
import type {
  ExecutorDriverCapabilities,
  ExecutorEngine,
  ExecutorEngineInfo,
  ExecutorProfile,
  PlanLimits,
} from './hello';
import type { ExecutorProfileConfig } from './profile';
import type { ExecutorDelta, ExecutorStartupPhase } from './vocabulary';

/** One turn running in an engine: its deltas, and the two ways to steer it. */
export interface AgentEngineTurn {
  /** Ends after the `turn-end` delta, or with an error when the engine died. */
  readonly deltas: AsyncIterable<ExecutorDelta>;
  interrupt(): Promise<void>;
  /** Answer an engine's request; an unknown `interactionId` is refused. */
  respond(interactionId: string, reply: InteractionReply['reply']): Promise<void>;
}

/** One engine process holding one native session, for the life of a connection. */
export interface AgentEngineSession {
  /** The engine's own session id: a join key, set once the engine names it. */
  readonly nativeThreadId: string;
  /**
   * Send the turn's input under `clientId`, the id the executor chose and the
   * engine keeps, and resolve once it is written — the effect `dispatch`
   * records. The turn's deltas follow.
   */
  startTurn(input: {
    turnId: string;
    clientId: string;
    input: readonly AgentMessagePart[];
  }): Promise<AgentEngineTurn>;
  /**
   * Stop the engine and wait for it. An engine that died on its own already failed its turn
   * and let go of the caller's signal; `close()` then only collects what it left.
   */
  close(): Promise<void>;
}

/**
 * A vendor's engine behind one interface. A driver spawns the engine itself,
 * through `stitchkit/process`, with the profile's environment and nothing
 * else; it never signs in, it reads whether the profile is signed in.
 */
export interface AgentEngineDriver {
  readonly engine: ExecutorEngine;
  /** `client-id`: `findInput` can answer; `none`: an unknown send stays unknown. */
  readonly reconcile: 'client-id' | 'none';
  /** Declarative driver capabilities advertised for this driver and configuration. */
  readonly capabilities?: ExecutorDriverCapabilities;
  info(): Promise<ExecutorEngineInfo>;
  status(profile: ExecutorProfileConfig): Promise<{
    login: ExecutorProfile['login'];
    effectiveCredential: ExecutorProfile['effectiveCredential'];
    planLimits?: PlanLimits;
  }>;
  open(input: {
    profile: ExecutorProfileConfig;
    cwd: string;
    /** Resume this native session; a fresh one is started without it. */
    nativeThreadId?: string;
    /** Optional observer invoked with startup phases (`spawning`, `initializing`, `verifying`) during open. */
    onStartupPhase?: (phase: ExecutorStartupPhase) => void;
    signal?: AbortSignal;
  }): Promise<AgentEngineSession>;
  /** Whether the engine holds the input sent under `clientId`; only for `reconcile: 'client-id'`. */
  findInput?(input: {
    profile: ExecutorProfileConfig;
    cwd: string;
    nativeThreadId: string;
    clientId: string;
  }): Promise<boolean>;
}
