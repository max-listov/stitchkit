import { z } from 'zod';
import { withDeadline } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import {
  type AgentChildBudget,
  type AgentChildHandle,
  type AgentChildRecord,
  type AgentChildState,
  AgentChildStateSchema,
  ChildStateEventPayloadSchema,
  parseChild,
} from './children-contract';
import type { AgentCompanionHost } from './companion-host';
import { AgentConversationPurgedError } from './purge';
import type { AgentRuntimeStore } from './store';

/** Configuration for creating an `AgentChildManager` backed by a store and spawner. */
export interface AgentChildManagerConfig {
  /** The store the children's conversations live in. */
  store: AgentRuntimeStore;
  /** That store's companion host: `host` of the SQLite or Postgres store. */
  host: AgentCompanionHost;
  spawn(request: {
    parentConversationId: string;
    childConversationId: string;
    seedArchive: Uint8Array;
    childInput: unknown;
    budget: AgentChildBudget;
  }): AgentChildHandle | Promise<AgentChildHandle>;
  /**
   * What the parent still has to give: every child's granted budget is the
   * requested one clamped to this, and a dimension the model leaves out takes
   * this value. A granted budget that names no limit, or a dimension at zero,
   * refuses the spawn.
   */
  remainingBudget(
    parentConversationId: string,
  ): AgentChildRemainingBudget | Promise<AgentChildRemainingBudget>;
  /** Children of one parent that may be spawned or running at once; one more refuses. */
  maxActiveChildren: number;
  now?: () => Date;
}

/** A parent's remainder: like a child budget, but a spent dimension is `0`. */
export interface AgentChildRemainingBudget {
  usd?: number;
  tokens?: number;
  milliseconds?: number;
}

/**
 * What one child manager holds across its operations.
 *
 * `handles` and `settlements` are this process's own view — a child spawned
 * by another manager, or before a restart, has a row but no handle — so every
 * operation that decides whether it can reach a child reads the same maps.
 * Everything else, the active count included, is read from the rows, so two
 * managers over one store see the same children. An entry leaves both maps
 * when the child ends: its settlement is recorded, or a stop recorded how the
 * child ended. `spawning` holds a child only while its spawn runs.
 */
export interface ChildManagerState {
  readonly config: AgentChildManagerConfig;
  readonly host: AgentCompanionHost;
  readonly store: AgentRuntimeStore;
  readonly now: () => Date;
  readonly handles: Map<string, AgentChildHandle>;
  readonly settlements: Map<string, ChildSettlement>;
  readonly spawning: Map<string, PendingSpawn>;
}

/**
 * A child this process is spawning: its host may be starting it, or its row may
 * already exist, but its handle is not registered yet, so a stop cannot reach it
 * through `handles`. A stop of its parent sets `stopRequested`, and the spawn
 * stops the child the moment its handle is registered.
 */
export interface PendingSpawn {
  readonly parentConversationId: string;
  stopRequested: boolean;
  /** Settles once the spawn has registered the child, stopped it on request, or failed. */
  readonly done: Promise<void>;
}

/**
 * How a child's own end is being recorded. `arrived` turns true the moment
 * the host reports the result, before the record is written: a stop that
 * finds it true lets the settlement record the end it already has.
 *
 * `ended` is what a waiter holds: it settles with `settled`, or as soon as a
 * stop has recorded how the child ended (`endedByStop`) — a waiter that came
 * before the stop never waits on a host the stop already wrote off.
 */
export interface ChildSettlement {
  readonly settled: Promise<void>;
  readonly ended: Promise<void>;
  endedByStop(): void;
  arrived: boolean;
}

export function createChildManagerState(config: AgentChildManagerConfig): ChildManagerState {
  // Required by the type, checked here for a caller that is not typed: no
  // limit is not a default the model may spend.
  if (typeof config.remainingBudget !== 'function')
    throw new TypeError('createAgentChildManager requires remainingBudget');
  if (config.maxActiveChildren === undefined)
    throw new TypeError('createAgentChildManager requires maxActiveChildren');
  assertPositiveSafeInteger('maxActiveChildren', config.maxActiveChildren);
  return {
    config,
    host: config.host,
    store: config.store,
    now: config.now ?? (() => new Date()),
    handles: new Map<string, AgentChildHandle>(),
    settlements: new Map<string, ChildSettlement>(),
    spawning: new Map<string, PendingSpawn>(),
  };
}

/**
 * How long a child's host may take to answer the manager: a stop, a reachability
 * probe, a blocking report, a blocking answer or a message. A constant rather than
 * an option: it bounds a host that stopped answering, not work the application
 * sizes, and one bound for every question keeps a silent host's cost the same.
 */
const CHILD_HOST_BOUND_MS = 10_000;

/** `work`'s value, or `fallback` once the child host bound has passed. */
export async function bounded<VALUE>(
  work: Promise<VALUE> | VALUE,
  fallback: VALUE,
): Promise<VALUE> {
  const outcome = await withDeadline(Promise.resolve(work), CHILD_HOST_BOUND_MS);
  return outcome.settled ? outcome.value : fallback;
}

/**
 * Ask a child's host within the bound: its answer, its own failure as thrown,
 * or an error naming `what` it did not answer.
 *
 * The bound ends the wait, not the host's work: the host may still take what
 * it was given. `onUnanswered` receives that unfinished answer, so the caller
 * can refuse to ask the same thing twice and record it if it lands.
 */
export async function askChildHost<VALUE>(
  what: string,
  work: () => VALUE | Promise<VALUE>,
  onUnanswered?: (answer: Promise<VALUE>) => void,
): Promise<VALUE> {
  const answer = Promise.resolve().then(work);
  const outcome = await withDeadline(
    answer.then(
      (value) => ({ answered: true as const, value }),
      (cause: unknown) => ({ answered: false as const, cause }),
    ),
    CHILD_HOST_BOUND_MS,
  );
  if (!outcome.settled) {
    onUnanswered?.(answer);
    throw new Error(`The child host did not answer ${what} within ${CHILD_HOST_BOUND_MS} ms`);
  }
  if (!outcome.value.answered) throw outcome.value.cause;
  return outcome.value.value;
}

/** How a policy stop asked of a child's host ended: confirmed, or why not. */
export type ChildStopDelivery =
  | { readonly stopped: true }
  | {
      readonly stopped: false;
      readonly reason: 'stop-failed' | 'stop-timeout';
      readonly cause: unknown;
    };

/** How a stop ended a child: delivered or not, or never asked of an unreachable host. */
export type ChildStopOutcome =
  | ChildStopDelivery
  | { readonly stopped: false; readonly reason: 'unreachable' };

/** The stop each host is answering now; a second stop of the same child joins it. */
const stopsInFlight = new WeakMap<AgentChildHandle, Promise<ChildStopDelivery>>();

/**
 * Deliver a policy stop to a child host within the stop bound.
 *
 * The one path every stop takes — a parent cascade, an interrupt, a budget
 * stop and the cleanup of a spawn that could not be recorded — so a host that
 * throws, rejects or never answers ends each of them the same way. Stops that
 * meet on one child while its host is answering share that one delivery: the
 * host is asked once, and every caller records the same outcome, so a second,
 * quickly refused stop cannot write `lost` over a stop still being confirmed.
 */
export function stopHandle(
  handle: AgentChildHandle,
  policy: string,
): Promise<ChildStopDelivery> {
  const inFlight = stopsInFlight.get(handle);
  if (inFlight) return inFlight;
  const delivery = deliverStop(handle, policy);
  stopsInFlight.set(handle, delivery);
  void delivery.finally(() => {
    if (stopsInFlight.get(handle) === delivery) stopsInFlight.delete(handle);
  });
  return delivery;
}

function deliverStop(handle: AgentChildHandle, policy: string): Promise<ChildStopDelivery> {
  return bounded<ChildStopDelivery>(
    Promise.resolve()
      .then(() => handle.stopPolicy(policy))
      .then(
        () => ({ stopped: true }),
        (cause: unknown) => ({ stopped: false, reason: 'stop-failed', cause }),
      ),
    {
      stopped: false,
      reason: 'stop-timeout',
      cause: new Error(
        `The child host did not answer the stop within ${CHILD_HOST_BOUND_MS} ms`,
      ),
    },
  );
}

/**
 * Run a dual-conversation write, falling back to each surviving conversation
 * when either side has already been purged. Resolves whether any side wrote.
 */
export async function writeWithPurgeFallback(
  write: (audience: 'both' | 'parent' | 'child') => Promise<boolean>,
): Promise<boolean> {
  // A purged conversation takes no events. The parent may be gone by the
  // time a child settles, or the child itself; whichever side still exists
  // gets its event. A purge of either side removes the child row, so when
  // both are gone there is nothing left to write. A settlement nobody awaits
  // must not surface as an unhandled rejection.
  try {
    return await write('both');
  } catch (error) {
    if (!(error instanceof AgentConversationPurgedError)) throw error;
    let wrote = false;
    for (const side of ['parent', 'child'] as const) {
      try {
        wrote = (await write(side)) || wrote;
      } catch (inner) {
        if (!(inner instanceof AgentConversationPurgedError)) throw inner;
      }
    }
    return wrote;
  }
}

/** The columns `parseChild` reads. */
export const CHILD_COLUMNS = `parent_conversation_id, child_conversation_id, seed_upto_seq, state,
  budget_payload, usage_payload, result_reference, created_at, updated_at`;

export function listChildren(
  state: ChildManagerState,
  parentConversationId: string,
): Promise<readonly AgentChildRecord[]> {
  return state.host.read(async (session) =>
    (
      await session.all(
        `SELECT ${CHILD_COLUMNS} FROM ${state.host.tables.children}
         WHERE parent_conversation_id = ? ORDER BY created_at, child_conversation_id`,
        [parentConversationId],
      )
    ).map(parseChild),
  );
}

/** The states a child ends from: the row is still live. */
export const LIVE_CHILD_STATES: readonly AgentChildState[] = ['spawned', 'running'];

const StateRowSchema = z.object({ state: AgentChildStateSchema });

/**
 * Move a child to `next` and journal it, only from one of `from`.
 *
 * The row is read and written in one write transaction, and the events are
 * appended in it only when the row moved: a child that already ended keeps
 * how it ended and its result, and each conversation holds one terminal
 * state for it, whichever of a settlement, a stop or an interrupt records
 * first. `absent: 'record'` is the settlement's: the parent's purge takes the
 * child rows with it, and the child's own conversation still deserves to
 * learn how it ended. Resolves whether the transition was recorded.
 */
export function transitionChild(
  state: ChildManagerState,
  record: AgentChildRecord,
  next: AgentChildState,
  options: {
    from: readonly AgentChildState[];
    absent: 'skip' | 'record';
    resultReference?: string;
    details?: Record<string, string | number | boolean>;
  },
): Promise<boolean> {
  const { from, absent, resultReference, details = {} } = options;
  const updatedAt = state.now().toISOString();
  const payload = ChildStateEventPayloadSchema.parse({
    childConversationId: record.childConversationId,
    state: next,
    ...(resultReference && { resultReference }),
    ...details,
  });
  const childPayload = ChildStateEventPayloadSchema.parse({
    parentConversationId: record.parentConversationId,
    state: next,
    ...(resultReference && { resultReference }),
    ...details,
  });
  const table = state.host.tables.children;
  const write = (audience: 'both' | 'parent' | 'child') =>
    state.host.transaction(
      audience === 'child' ? record.childConversationId : record.parentConversationId,
      async (scope) => {
        const row = await scope.get(
          `SELECT state FROM ${table} WHERE child_conversation_id = ?`,
          [record.childConversationId],
        );
        if (row === undefined) {
          if (absent === 'skip') return false;
        } else {
          if (!from.includes(StateRowSchema.parse(row).state)) return false;
          await scope.run(
            `UPDATE ${table} SET state = ?, result_reference = ?, updated_at = ?
             WHERE child_conversation_id = ? AND state IN (${from.map(() => '?').join(', ')})`,
            [next, resultReference ?? null, updatedAt, record.childConversationId, ...from],
          );
        }
        if (audience === 'both' || audience === 'parent') {
          await scope.appendEvent({
            conversationId: record.parentConversationId,
            kind: 'child/state',
            occurredAt: updatedAt,
            payload,
          });
        }
        if (audience === 'both' || audience === 'child') {
          await scope.appendEvent({
            conversationId: record.childConversationId,
            kind: 'child/state',
            occurredAt: updatedAt,
            payload: childPayload,
          });
        }
        return true;
      },
    );
  return writeWithPurgeFallback(write);
}

export async function activeChild(
  state: ChildManagerState,
  parentConversationId: string,
  childConversationId: string,
): Promise<{ child: AgentChildRecord; handle: AgentChildHandle }> {
  const child = (await listChildren(state, parentConversationId)).find(
    (record) => record.childConversationId === childConversationId,
  );
  if (!child) throw new TypeError('Unknown child conversation for this parent');
  if (child.state !== 'running' && child.state !== 'spawned') {
    throw new TypeError('Child conversation is not active');
  }
  const handle = state.handles.get(childConversationId);
  if (!handle) throw new TypeError('Child host handle is unavailable');
  return { child, handle };
}
