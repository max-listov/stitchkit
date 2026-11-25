import { redact } from '../../observability/sanitize';

/**
 * Project a tool's successful response into a JSON-safe value when raw
 * `JSON.stringify` cannot serialise it (for example a `bigint` or cyclic
 * object behind `z.unknown()`). Values that already stringify cleanly are
 * returned untouched with their exact `JSON.stringify` text so normal
 * responses stay byte-for-byte identical.
 *
 * The never-matching `sensitiveKeys` pattern disables secret masking — this
 * is the tool's response payload, not an audit log row.
 */
export function projectJsonSafe(
  value: unknown,
  space?: number,
): { readonly value: unknown; readonly text: string } {
  try {
    const serialized = JSON.stringify(value, null, space);
    if (serialized !== undefined) return { value, text: serialized };
  } catch {
    // Fall through to the JSON-safe projection below.
  }
  const safe = redact(value, { sensitiveKeys: /(?!)/ });
  return { value: safe, text: JSON.stringify(safe, null, space) ?? 'null' };
}

/** Serialize a value to JSON, projecting cycles and bigints instead of throwing. */
export function stringifyJsonSafe(value: unknown, space?: number): string {
  return projectJsonSafe(value, space).text;
}
