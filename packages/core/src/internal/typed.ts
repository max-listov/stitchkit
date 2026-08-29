import type { SurfaceAgentRuntimeToolDefinition } from '../tools/internal/surface-projector';
import type { RuntimeToolDefinition } from '../tools/runtime-tool';

export function typedEntries<T extends object>(
  value: T,
): Array<{ [K in keyof T]: [K, T[K]] }[keyof T]> {
  return Object.entries(value) as Array<{ [K in keyof T]: [K, T[K]] }[keyof T]>;
}

/** Narrow an unknown value to a plain object — not `null`, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Invoke a runtime-discovered handler after a fail-first function check. */
export function callRuntimeHandler(handler: unknown, context: unknown): unknown {
  if (typeof handler !== 'function') {
    throw new TypeError('Runtime handler must be a function');
  }
  return Reflect.apply(handler, undefined, [context]);
}

/**
 * Agent-only public declarations use a peer-free structural tool definition.
 * Construction validates executable functions before this boundary restores
 * the richer internal definition consumed by the canonical mount.
 */
export function executableAgentRuntimeTools(
  tools: readonly SurfaceAgentRuntimeToolDefinition[],
): readonly RuntimeToolDefinition[] {
  for (const tool of tools) {
    if (typeof tool.handler !== 'function') {
      throw new TypeError(`Runtime tool "${tool.name}" must provide a handler`);
    }
    if (tool.present?.agent !== undefined && typeof tool.present.agent !== 'function') {
      throw new TypeError(`Runtime tool "${tool.name}" Agent presenter must be a function`);
    }
    if (tool.present?.agent !== undefined && tool.output === undefined) {
      throw new TypeError(
        `Runtime tool "${tool.name}" Agent presenter requires an output schema`,
      );
    }
  }
  return tools as readonly RuntimeToolDefinition[];
}

/**
 * Isolated loose-to-typed adapter boundary for transports whose decoder is
 * selected at runtime while the contract fixes the generic result type.
 */
export function transportResult<T>(value: unknown): T {
  return value as T;
}

export function mapObject<
  TSource extends object,
  TResult extends { [K in keyof TSource]?: unknown },
>(
  source: TSource,
  mapper: <K extends keyof TSource>(key: K, value: TSource[K]) => TResult[K] | undefined,
): TResult {
  const result: Partial<TResult> = {};
  for (const [key, value] of typedEntries(source)) {
    const mapped = mapper(key, value);
    if (mapped !== undefined) result[key] = mapped;
  }
  return result as TResult;
}

/**
 * Dynamic key-wise factory bridge. Use when runtime construction preserves a
 * mapped type's key/value relation but TypeScript cannot express the dependent
 * callback return. The assertion is intentionally isolated at this boundary.
 */
export function mapObjectTypeBoundary<
  TSource extends object,
  TResult extends { [K in keyof TSource]?: unknown },
>(
  source: TSource,
  mapper: (key: keyof TSource, value: TSource[keyof TSource]) => unknown,
): TResult {
  return mapObject<TSource, TResult>(
    source,
    (key, value) => mapper(key, value) as TResult[typeof key] | undefined,
  );
}
