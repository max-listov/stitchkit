/**
 * The difference between two answers to the same watched read.
 *
 * A watched read publishes the whole value on every change. For a small answer
 * that is the right thing — a difference has its own overhead, and below a few
 * hundred bytes the difference is the larger message. For a large one it is not:
 * the case this exists for is a ~75 KB list answer in which two timestamps move,
 * republished every fifteen seconds, which is a megabyte of socket per
 * subscriber per minute to carry a hundred bytes of news.
 *
 * ## What it is, and what it deliberately is not
 *
 * It is a *structural* difference over parsed JSON: objects by changed and
 * removed key, arrays by runs copied from the previous value plus the elements
 * that are genuinely new. It is not a text diff and not a patch format from
 * elsewhere (JSON Patch, RFC 7386 merge patch): both of those lose the one
 * property this has to keep — an array that shifted by one element must cost one
 * op, not N. RFC 7386 additionally cannot express removing an array element or
 * distinguish `null` from "delete", and a watched read's value is arbitrary
 * application JSON where both are ordinary.
 *
 * ## The rule that makes it safe to use
 *
 * **A difference that is not smaller than the value is not sent.** Every caller
 * measures — {@link deltaWins} — because a difference can be larger: a list that
 * was replaced wholesale produces one `put` per element plus the framing. There
 * is no shape of value for which sending the delta is the only option, so the
 * failure mode of a bad diff is a wasted comparison, never a bigger frame.
 *
 * ## Fidelity
 *
 * `apply(previous, diff(previous, next))` reconstructs `next` exactly, for every
 * value that survives `JSON.parse(JSON.stringify(x))` — which is every value a
 * contract read can return, because it crossed a socket to get here. The
 * property test over random pairs is the standing proof; it is a property rather
 * than examples because the interesting inputs are the ones nobody thinks to
 * write down.
 *
 * → the hub applies this per subscriber (`application/watch-hub`), the client
 * reassembles (`live/watch-client`).
 */
import { z } from 'zod';
import { serializeCanonicalJson } from '../internal/canonical-json';
import { isRecord } from '../internal/typed';

/** One step of rebuilding an array from the previous one. */
export type WatchArrayOp =
  /** Take `count` elements from the previous array starting at `from`. */
  | { readonly o: 'copy'; readonly from: number; readonly count: number }
  /** Take the element at `from` and apply a difference to it. */
  | { readonly o: 'patch'; readonly from: number; readonly d: WatchDelta }
  /** An element with no counterpart in the previous array. */
  | { readonly o: 'put'; readonly v: unknown };

/** The difference between two values. */
export type WatchDelta =
  /** Replace wholesale — the two values have nothing to share. */
  | { readonly t: 'set'; readonly v: unknown }
  | {
      readonly t: 'obj';
      /** Per changed or added key, the difference to apply to it. */
      readonly set?: Readonly<Record<string, WatchDelta>>;
      /** Keys present before and gone now. */
      readonly drop?: readonly string[];
    }
  | { readonly t: 'arr'; readonly ops: readonly WatchArrayOp[] };

export const WatchDeltaSchema: z.ZodType<WatchDelta> = z.lazy(() =>
  z.union([
    z.object({ t: z.literal('set'), v: z.unknown() }),
    z.object({
      t: z.literal('obj'),
      set: z.record(z.string(), WatchDeltaSchema).optional(),
      drop: z.array(z.string()).optional(),
    }),
    z.object({ t: z.literal('arr'), ops: z.array(WatchArrayOpSchema) }),
  ]),
) as z.ZodType<WatchDelta>;

export const WatchArrayOpSchema: z.ZodType<WatchArrayOp> = z.lazy(() =>
  z.union([
    z.object({
      o: z.literal('copy'),
      from: z.number().int().nonnegative(),
      count: z.number().int().positive(),
    }),
    z.object({
      o: z.literal('patch'),
      from: z.number().int().nonnegative(),
      d: WatchDeltaSchema,
    }),
    z.object({ o: z.literal('put'), v: z.unknown() }),
  ]),
) as z.ZodType<WatchArrayOp>;

/**
 * The identity of a value as one string — key order normalised.
 *
 * Used to decide whether two things are the same, never to prove they are: the
 * only consumer is the diff, and a diff that calls two equal things different
 * produces a larger message, not a wrong one.
 */
function signature(value: unknown): string {
  return serializeCanonicalJson(value);
}

/**
 * The difference from `previous` to `next`, or `undefined` when they are equal.
 *
 * `undefined` is a real answer and the caller must handle it: a re-read that
 * produced the same bytes has no news in it, and the hub already declines to
 * publish one. It is returned rather than an empty delta so that "nothing
 * changed" cannot be confused with "everything at the top level was replaced by
 * an empty object".
 */
export function diff(previous: unknown, next: unknown): WatchDelta | undefined {
  if (signature(previous) === signature(next)) return undefined;
  if (isRecord(previous) && isRecord(next)) return objectDiff(previous, next);
  if (Array.isArray(previous) && Array.isArray(next)) return arrayDiff(previous, next);
  return { t: 'set', v: next };
}

function objectDiff(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): WatchDelta {
  const set: Record<string, WatchDelta> = {};
  const drop: string[] = [];
  for (const key of Object.keys(next)) {
    if (!Object.hasOwn(previous, key)) {
      set[key] = { t: 'set', v: next[key] };
      continue;
    }
    const nested = diff(previous[key], next[key]);
    if (nested !== undefined) set[key] = nested;
  }
  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(next, key)) drop.push(key);
  }
  return {
    t: 'obj',
    ...(Object.keys(set).length > 0 && { set }),
    ...(drop.length > 0 && { drop }),
  };
}

/**
 * Arrays by runs, so a window that slid costs one op rather than N.
 *
 * The walk is greedy and single-pass, and the order of its three attempts is the
 * whole design. First it tries to *continue* the run it is already copying:
 * that is what turns "drop k from the head, append a tail" — the shape every
 * paged and tailing list has — into one `copy` plus the new elements, and it is
 * the reason this is not a plain longest-common-subsequence, which would find
 * the same elements but not cheaply express them as runs. Second it looks the
 * element up by identity anywhere in the previous array, which is what carries a
 * reordering without resending the elements that merely moved. Only then does it
 * fall back to a difference against the element sitting in the same place, and
 * finally to sending the element.
 *
 * Greedy is a deliberate limit, not an oversight: an optimal alignment is
 * quadratic, and the caller measures the result anyway — a worse alignment can
 * only lose the size comparison and send the value.
 */
function arrayDiff(previous: readonly unknown[], next: readonly unknown[]): WatchDelta {
  const previousSignatures = previous.map(signature);
  const positions = new Map<string, number[]>();
  previousSignatures.forEach((value, index) => {
    const bucket = positions.get(value);
    if (bucket) bucket.push(index);
    else positions.set(value, [index]);
  });
  const taken = new Set<number>();
  const ops: WatchArrayOp[] = [];
  let cursor = 0;

  const extend = (from: number): boolean => {
    const last = ops.at(-1);
    if (last?.o !== 'copy' || last.from + last.count !== from) return false;
    ops[ops.length - 1] = { o: 'copy', from: last.from, count: last.count + 1 };
    return true;
  };

  for (const element of next) {
    const wanted = signature(element);
    // 1. Continue the run in progress.
    const last = ops.at(-1);
    const continuation = last?.o === 'copy' ? last.from + last.count : undefined;
    if (
      continuation !== undefined &&
      continuation < previous.length &&
      previousSignatures[continuation] === wanted &&
      !taken.has(continuation)
    ) {
      taken.add(continuation);
      extend(continuation);
      cursor = continuation + 1;
      continue;
    }
    // 2. The same element somewhere else — a move, not a rewrite.
    const bucket = positions.get(wanted);
    const found = bucket?.find((index) => !taken.has(index));
    if (found !== undefined) {
      taken.add(found);
      if (!extend(found)) ops.push({ o: 'copy', from: found, count: 1 });
      cursor = found + 1;
      continue;
    }
    // 3. Changed in place: patch it against whatever sits here now.
    const counterpart = cursor < previous.length && !taken.has(cursor) ? cursor : undefined;
    const nested =
      counterpart === undefined ? undefined : diff(previous[counterpart], element);
    if (counterpart !== undefined && nested !== undefined) {
      taken.add(counterpart);
      ops.push({ o: 'patch', from: counterpart, d: nested });
      cursor = counterpart + 1;
      continue;
    }
    // 4. New.
    ops.push({ o: 'put', v: element });
  }
  return { t: 'arr', ops };
}

/**
 * Rebuild the new value from the old one and a difference.
 *
 * **Throws when the difference does not fit the value it was given.** That is
 * the contract, and the reason it is not a tolerant merge: a difference applied
 * to the wrong base produces a plausible object that is not what the server
 * holds, and a watched read whose face is quietly wrong is the exact failure the
 * revision and the fingerprint exist to prevent. The caller catches and
 * resynchronises that one key.
 */
export function apply(previous: unknown, delta: WatchDelta): unknown {
  if (delta.t === 'set') return delta.v;
  if (delta.t === 'obj') {
    if (!isRecord(previous))
      throw new Error('an object difference needs an object to apply to');
    const result: Record<string, unknown> = { ...previous };
    for (const key of delta.drop ?? []) delete result[key];
    for (const [key, nested] of Object.entries(delta.set ?? {})) {
      result[key] = apply(Object.hasOwn(result, key) ? result[key] : undefined, nested);
    }
    return result;
  }
  if (!Array.isArray(previous))
    throw new Error('an array difference needs an array to apply to');
  const result: unknown[] = [];
  for (const op of delta.ops) {
    if (op.o === 'put') {
      result.push(op.v);
      continue;
    }
    if (op.from >= previous.length) {
      throw new Error(
        `the difference reads element ${op.from} of an array of ${previous.length}`,
      );
    }
    if (op.o === 'patch') {
      result.push(apply(previous[op.from], op.d));
      continue;
    }
    if (op.from + op.count > previous.length) {
      throw new Error(
        `the difference copies ${op.count} from ${op.from} of an array of ${previous.length}`,
      );
    }
    result.push(...previous.slice(op.from, op.from + op.count));
  }
  return result;
}

/**
 * Whether sending the difference actually saves anything.
 *
 * Measured on the encoded length of both, because that is what crosses the
 * socket — a delta with fewer *nodes* can still be the longer message once its
 * framing is written out. Ties go to the value: identical cost, one fewer thing
 * that can go wrong at the other end.
 */
export function deltaWins(delta: WatchDelta, value: unknown): boolean {
  return JSON.stringify(delta).length < (JSON.stringify(value) ?? 'null').length;
}
