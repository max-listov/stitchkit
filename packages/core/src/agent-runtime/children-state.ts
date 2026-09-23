import type { SqliteDatabase } from '../internal/sqlite';
import {
  type AgentChildBudget,
  type AgentChildHandle,
  type AgentChildRecord,
  type AgentChildState,
  AgentChildStateSchema,
  parseChild,
} from './children-contract';
import { AgentConversationPurgedError } from './purge';
import type { SqliteAgentRuntimeStore } from './sqlite';

export interface SqliteAgentChildManagerConfig {
  sqlite: SqliteAgentRuntimeStore;
  spawn(request: {
    parentConversationId: string;
    childConversationId: string;
    seedArchive: Uint8Array;
    childInput: unknown;
    budget: AgentChildBudget;
  }): AgentChildHandle | Promise<AgentChildHandle>;
  remainingBudget?(parentConversationId: string): AgentChildBudget | Promise<AgentChildBudget>;
  now?: () => Date;
}

/**
 * What one child manager holds across its operations.
 *
 * `handles` and `settlements` are this process's own view — a child spawned
 * by another manager, or before a restart, has a row but no handle — so every
 * operation that decides whether it can reach a child reads the same maps.
 */
export interface ChildManagerState {
  readonly config: SqliteAgentChildManagerConfig;
  readonly database: SqliteDatabase;
  readonly store: SqliteAgentRuntimeStore['store'];
  readonly now: () => Date;
  readonly handles: Map<string, AgentChildHandle>;
  readonly settlements: Map<string, Promise<void>>;
}

export function createChildManagerState(
  config: SqliteAgentChildManagerConfig,
): ChildManagerState {
  return {
    config,
    database: config.sqlite.database,
    store: config.sqlite.store,
    now: config.now ?? (() => new Date()),
    handles: new Map<string, AgentChildHandle>(),
    settlements: new Map<string, Promise<void>>(),
  };
}

function currentState(
  state: ChildManagerState,
  childConversationId: string,
): AgentChildState | undefined {
  const raw = state.database
    .prepare(
      'SELECT state FROM stitchkit_agent_runtime_children WHERE child_conversation_id = ?',
    )
    .get(childConversationId);
  return raw === null || raw === undefined
    ? undefined
    : AgentChildStateSchema.parse((raw as { state: unknown }).state);
}

export function isLive(state: ChildManagerState, childConversationId: string): boolean {
  const current = currentState(state, childConversationId);
  return current === 'spawned' || current === 'running';
}

/**
 * Whether a settlement may still be recorded: a live row, or no row at all —
 * the parent's purge takes the child rows with it, and the child's own
 * conversation still deserves to learn how it ended.
 */
export function settleable(state: ChildManagerState, childConversationId: string): boolean {
  const current = currentState(state, childConversationId);
  return current === undefined || current === 'spawned' || current === 'running';
}

/** How long a child's host may take to answer a stop or a reachability probe. */
const STOP_BOUND_MS = 10_000;

export async function bounded<VALUE>(
  work: Promise<VALUE> | VALUE,
  fallback: VALUE,
): Promise<VALUE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<VALUE>((resolve) => {
        timer = setTimeout(() => resolve(fallback), STOP_BOUND_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function listChildren(
  state: ChildManagerState,
  parentConversationId: string,
): readonly AgentChildRecord[] {
  return state.database
    .prepare(`
        SELECT parent_conversation_id, child_conversation_id, seed_upto_seq, state,
          budget_payload, usage_payload, result_reference, created_at, updated_at
        FROM stitchkit_agent_runtime_children
        WHERE parent_conversation_id = ? ORDER BY created_at, child_conversation_id
      `)
    .all(parentConversationId)
    .map(parseChild);
}

export async function updateState(
  state: ChildManagerState,
  record: AgentChildRecord,
  next: AgentChildState,
  resultReference?: string,
  details: Record<string, string | number | boolean> = {},
): Promise<void> {
  const updatedAt = state.now().toISOString();
  const payload = {
    childConversationId: record.childConversationId,
    state: next,
    ...(resultReference && { resultReference }),
    ...details,
  };
  const childPayload = {
    parentConversationId: record.parentConversationId,
    state: next,
    ...(resultReference && { resultReference }),
    ...details,
  };
  const write = (audience: 'both' | 'child' | 'row') =>
    state.config.sqlite.transaction(async (scope) => {
      scope.database
        .prepare(`
            UPDATE stitchkit_agent_runtime_children
            SET state = ?, result_reference = ?, updated_at = ? WHERE child_conversation_id = ?
          `)
        .run(next, resultReference ?? null, updatedAt, record.childConversationId);
      if (audience === 'both') {
        await scope.appendEvent({
          conversationId: record.parentConversationId,
          kind: 'child/state',
          occurredAt: updatedAt,
          payload,
        });
      }
      if (audience !== 'row') {
        await scope.appendEvent({
          conversationId: record.childConversationId,
          kind: 'child/state',
          occurredAt: updatedAt,
          payload: childPayload,
        });
      }
    });
  // A purged conversation takes no events. The parent may be gone by the
  // time a child settles, or the child itself; the row still records the
  // state, and whichever side still exists gets its event. A settlement
  // nobody awaits must not surface as an unhandled rejection.
  try {
    await write('both');
  } catch (error) {
    if (!(error instanceof AgentConversationPurgedError)) throw error;
    try {
      await write('child');
    } catch (inner) {
      if (!(inner instanceof AgentConversationPurgedError)) throw inner;
      await write('row');
    }
  }
}

export function activeChild(
  state: ChildManagerState,
  parentConversationId: string,
  childConversationId: string,
): { child: AgentChildRecord; handle: AgentChildHandle } {
  const child = listChildren(state, parentConversationId).find(
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
