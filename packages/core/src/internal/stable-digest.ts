/**
 * A stable identity for a call's arguments — one implementation, two callers.
 *
 * Two callers need the same thing for different reasons. The MCP round keys a
 * tool invocation by `(operation, arguments)` so a retry is recognised as the
 * same round; a watched read keys its shared source by `(operation, arguments)`
 * so two browsers asking the same question are one read on the server. If those
 * two computed the key differently, the same arguments would be the same round
 * and two different watches — and nothing would say so.
 *
 * The stability that matters is key order: `{a:1,b:2}` and `{b:2,a:1}` are the
 * same arguments and `JSON.stringify` disagrees, so a naive key silently splits
 * one shared source into two whenever a caller builds its object in a different
 * order. That is not a hypothetical: object literal order follows the source
 * that wrote it, and two components asking the same question rarely share one.
 */
import { bytesToBase64Url } from './base64url';

/**
 * The value with every object's keys sorted, recursively — arrays keep their
 * order, because in an array order *is* the value.
 *
 * `Object.keys` returns own enumerable keys only, so nothing from a prototype
 * reaches the digest.
 */
export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = stableValue(Reflect.get(value, key));
  }
  return result;
}

/**
 * A bounded, order-independent digest of a call's arguments.
 *
 * SHA-256 over the key-sorted JSON, base64url without padding. Bounded because
 * the key travels on the wire and arguments do not have a bounded size; a hash
 * rather than the JSON itself so a large argument object does not become a
 * large subscription key repeated in every frame.
 *
 * What it cannot do, stated because the limit is easy to walk into: values
 * `JSON.stringify` drops or transforms — `undefined` members, a `Date`, a `Map`,
 * a `BigInt` (which throws) — are not distinguished, or not survivable, here.
 * Contract arguments are parsed JSON, so this is the argument shape by
 * construction; a caller digesting something else has to say what it means.
 */
export async function argumentsDigest(args: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(args)));
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
