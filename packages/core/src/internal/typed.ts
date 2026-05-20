export function typedEntries<T extends object>(
  value: T,
): Array<{ [K in keyof T]: [K, T[K]] }[keyof T]> {
  return Object.entries(value) as Array<{ [K in keyof T]: [K, T[K]] }[keyof T]>;
}

/** Narrow an unknown value to a plain object — not `null`, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
