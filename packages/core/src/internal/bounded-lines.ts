export const DEFAULT_STREAM_LINE_BYTES = 1024 * 1024;

function lineLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_STREAM_LINE_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError('maxLineBytes must be a positive safe integer');
  }
  return resolved;
}

function joinBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

/** Bounded, fatal-UTF-8 line reader shared by NDJSON and SSE parsers. */
export async function* readBoundedUtf8Lines(
  response: Response,
  maxLineBytes?: number,
): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const limit = lineLimit(maxLineBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending: Uint8Array = new Uint8Array();

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      let start = 0;
      for (let index = 0; index < chunk.value.byteLength; index += 1) {
        if (chunk.value[index] !== 0x0a) continue;
        const lineBytes = joinBytes(pending, chunk.value.slice(start, index));
        if (lineBytes.byteLength > limit) {
          throw new RangeError(`Stream line exceeds the ${limit} byte limit`);
        }
        yield decoder.decode(lineBytes);
        pending = new Uint8Array();
        start = index + 1;
      }
      pending = joinBytes(pending, chunk.value.slice(start));
      if (pending.byteLength > limit) {
        throw new RangeError(`Stream line exceeds the ${limit} byte limit`);
      }
    }
    if (pending.byteLength > 0) yield decoder.decode(pending);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
