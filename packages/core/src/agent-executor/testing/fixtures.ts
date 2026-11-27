import type { CodexNotificationEvent } from '../codex/handlers';
import { type CodexThread, CodexThreadSchema } from '../codex/protocol';
import { type JsonRpcValue, JsonRpcValueSchema } from '../json-rpc-peer';
import { type ExecutorDelta, ExecutorDeltaSchema } from '../vocabulary';

/** Compact input accepted by {@link makeExecutorDelta}, making `turnId`, `itemId`, and `raw` optional across every `ExecutorDelta` branch. */
export type ExecutorDeltaInput<D extends ExecutorDelta = ExecutorDelta> =
  D extends ExecutorDelta
    ? Omit<D, 'turnId' | 'itemId' | 'raw'> & {
        readonly turnId?: string | undefined;
        readonly itemId?: string | undefined;
        readonly raw?: ExecutorDelta['raw'] | undefined;
      }
    : never;

/** Optional overrides accepted by {@link makeCodexNotificationEvent}. */
export interface CodexNotificationEventOverrides {
  /** Override `duringActiveTurn` (defaults to `false`). */
  readonly duringActiveTurn?: boolean | undefined;
  /** Override classified `deltas` (defaults to `[]`). */
  readonly deltas?: readonly ExecutorDelta[] | undefined;
}

/** Build a validated {@link ExecutorDelta} with sensible default `turnId`, `itemId`, and `raw` metadata. */
export function makeExecutorDelta(delta: ExecutorDeltaInput): ExecutorDelta {
  return ExecutorDeltaSchema.parse({
    ...delta,
    turnId: delta.turnId ?? 'turn-1',
    itemId: delta.itemId ?? 'item-1',
    raw: delta.raw ?? { source: 'test', type: delta.type },
  });
}

/** Build a validated {@link CodexNotificationEvent} fixture for consumer unit tests. */
export function makeCodexNotificationEvent(
  method: string,
  params?: JsonRpcValue,
  overrides?: CodexNotificationEventOverrides,
): CodexNotificationEvent {
  if (typeof method !== 'string' || method.trim().length === 0) {
    throw new TypeError(
      '[stitchkit] makeCodexNotificationEvent: method must be a non-empty string',
    );
  }
  const validatedParams = params !== undefined ? JsonRpcValueSchema.parse(params) : undefined;
  const validatedDeltas = (overrides?.deltas ?? []).map((delta) =>
    ExecutorDeltaSchema.parse(delta),
  );
  return {
    method,
    params: validatedParams,
    duringActiveTurn: overrides?.duringActiveTurn ?? false,
    deltas: validatedDeltas,
  };
}

/** Build a validated {@link CodexThread} fixture with sensible defaults and optional field overrides. */
export function makeCodexThreadFixture(
  overrides?: { [K in keyof CodexThread]?: CodexThread[K] | undefined } & Readonly<
    Record<string, unknown>
  >,
): CodexThread {
  const base: Record<string, unknown> = {
    id: 'thread-1',
    cwd: '/workspace',
    preview: '',
    status: { type: 'idle' },
    canAcceptDirectInput: true,
    turns: [],
  };
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) base[key] = value;
    }
  }
  return CodexThreadSchema.parse(base);
}
