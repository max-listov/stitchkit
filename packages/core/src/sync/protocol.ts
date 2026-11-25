/**
 * The wire of a sync: what a push carries and answers per change, what a page
 * request and header carry, and how several streams make one cursor.
 *
 * The outcome of a change is an open vocabulary. A client that validated it as
 * a closed list dropped the whole answer — every acknowledgement in it — the
 * day a server sent a value it did not know. Here each result is read on its
 * own, an outcome this client does not know is retried (the server's ledger
 * makes a repeat safe) a bounded number of times and then held for a person to
 * see, and a `code` is any string. A rejection is held for a person too, unless
 * the app says its rows stand alone.
 */
import { z } from 'zod';
import { utf8ByteLength } from '../internal/bounded-body';
import { assertPositiveSafeInteger } from '../internal/positive-integer';

/** The outcomes this client knows; the names are the ones already on the wire. */
export const SYNC_CHANGE_OUTCOMES = [
  'applied',
  'replayed',
  'terminal_rejected',
  'retryable_failed',
] as const;
/** Known change push outcome value from `SYNC_CHANGE_OUTCOMES`. */
export type SyncChangeOutcome = (typeof SYNC_CHANGE_OUTCOMES)[number];

/** One change's result as it arrives: any outcome string, any code. */
export const SyncChangeResultSchema = z
  .object({
    changeId: z.string().min(1),
    outcome: z.string().min(1),
    code: z.string().nullish(),
    /** The version the change got, when the server names it; the cursor covers it later. */
    version: z.int().nonnegative().nullish(),
  })
  .loose();
/** Raw per-change server push result inferred from `SyncChangeResultSchema`. */
export type SyncChangeResult = z.infer<typeof SyncChangeResultSchema>;

/** How large one push may be; a server refuses more, a client never builds more. */
export interface SyncPushLimits {
  readonly maxChanges: number;
  /** UTF-8 bytes of the `changes` array as JSON. */
  readonly maxBytes: number;
}

/** The push request a server endpoint declares, around the app's own change schema. */
export function syncPushRequestSchema<CHANGE extends z.ZodType>(
  change: CHANGE,
  limits: SyncPushLimits,
) {
  return z.object({
    changes: z
      .array(change)
      .min(1)
      .max(limits.maxChanges)
      .refine((changes) => utf8ByteLength(JSON.stringify(changes)) <= limits.maxBytes, {
        message: `a push carries at most ${limits.maxBytes} bytes of changes`,
      }),
  });
}

/** The push answer: results read one by one, so one unknown value does not drop the rest. */
export const SyncPushResultSchema = z.object({ results: z.array(z.unknown()) });

const Version = z.int().nonnegative();

/** What a client asks for: `after: null` is the start of a full snapshot. */
export const SyncPageRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    after: Version.nullable(),
    /** The continuation of a full snapshot the server pages by token; `null` otherwise. */
    token: z.string().min(1).nullable(),
    /** True for every page of a full snapshot, so the server keeps its full-snapshot filter. */
    full: z.boolean(),
  })
  .readonly();
/** Client page pull request inferred from `SyncPageRequestSchema`. */
export type SyncPageRequest = z.infer<typeof SyncPageRequestSchema>;

/** The header every sync page carries; the app extends it with its rows. */
export const SyncPageHeaderSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  hasMore: z.boolean(),
  /** The cursor of the next page; it must grow while `hasMore`. */
  nextCursor: Version.nullable().optional(),
  /**
   * The continuation of a full snapshot whose pages are not ordered by version
   * (by kind and id): opaque, the server reads it back; it must change while
   * `hasMore`. With it, `nextCursor` is not read.
   */
  nextToken: z.string().min(1).nullable().optional(),
  /** The newest version this page reflects. */
  latestVersion: Version.optional(),
  /** The server answered with a full snapshot the session did not ask for. */
  full: z.boolean().optional(),
});
/** Server sync page response header inferred from `SyncPageHeaderSchema`. */
export type SyncPageHeader = Readonly<z.infer<typeof SyncPageHeaderSchema>>;

/**
 * The refusal code of a page request whose cursor is older than the feed the
 * server keeps: the session loads a full snapshot at once. Map the server's own
 * refusal to it in `handleError`.
 */
export const SYNC_STALE_CURSOR = 'stale_cursor';

/** What to do with the outbox row of one result. */
export type SyncChangeAction = 'acknowledge' | 'retry' | 'hold';

/** Push change result paired with whether its outcome was recognized and the outbox action to take. */
export interface ClassifiedChangeResult {
  readonly changeId: string;
  readonly outcome: SyncChangeOutcome;
  /** The outcome the server sent was one this client knows. */
  readonly known: boolean;
  readonly code?: string;
  /** The version an acknowledged change got; keep the row `confirmed` until the cursor covers it. */
  readonly version?: number;
  /**
   * `acknowledge` an applied or replayed change; `retry` a failure; `hold` a
   * rejection (unless `rejected: 'acknowledge'`), a failure once it has come back
   * `holdAfterFailures` times, and an outcome this client does not know once it
   * has come back `holdAfter` times.
   */
  readonly action: SyncChangeAction;
}

/** Options controlling how `classifyChangeResults` treats rejections, failures and unrecognized outcomes. */
export interface SyncResultReading {
  /**
   * What a `terminal_rejected` change becomes. Default `hold`: the row waits for
   * a person with its code, and the rows made on top of it with it.
   * `acknowledge` drops it, for rows that stand on their own.
   */
  readonly rejected?: 'acknowledge' | 'hold';
  /**
   * Hold a row after this many `retryable_failed` answers for it, this one
   * included; needs `failuresOf`. Default: a known failure is retried for ever.
   */
  readonly holdAfterFailures?: number;
  /** How many `retryable_failed` answers this row already had; the app keeps the count. */
  readonly failuresOf?: (changeId: string) => number;
  /** Hold a row after this many unknown outcomes for it, this one included. Default 3. */
  readonly holdAfter?: number;
  /** How many unknown outcomes this row already had; the app keeps the count. Default 0. */
  readonly unknownOutcomesOf?: (changeId: string) => number;
}

/** The action of one result whose outcome the client knows. */
function knownAction(
  outcome: SyncChangeOutcome,
  changeId: string,
  reading: SyncResultReading,
): SyncChangeAction {
  if (outcome === 'applied' || outcome === 'replayed') return 'acknowledge';
  if (outcome === 'terminal_rejected') return reading.rejected ?? 'hold';
  if (reading.holdAfterFailures === undefined || reading.failuresOf === undefined)
    return 'retry';
  return reading.failuresOf(changeId) + 1 >= reading.holdAfterFailures ? 'hold' : 'retry';
}

/**
 * Read each result on its own. A malformed entry is skipped and counted in
 * `invalid`; an unknown outcome is `retryable_failed` with `known: false`.
 */
export function classifyChangeResults(
  results: readonly unknown[],
  reading: SyncResultReading = {},
): { results: ClassifiedChangeResult[]; invalid: number } {
  const holdAfter = reading.holdAfter ?? 3;
  assertPositiveSafeInteger('[stitchkit] sync: holdAfter', holdAfter, RangeError);
  if (reading.holdAfterFailures !== undefined) {
    assertPositiveSafeInteger(
      '[stitchkit] sync: holdAfterFailures',
      reading.holdAfterFailures,
      RangeError,
    );
    if (reading.failuresOf === undefined)
      throw new RangeError('[stitchkit] sync: holdAfterFailures needs failuresOf to count');
  }
  if (reading.rejected !== undefined && !['acknowledge', 'hold'].includes(reading.rejected))
    throw new RangeError("[stitchkit] sync: rejected is 'acknowledge' or 'hold'");
  const classified: ClassifiedChangeResult[] = [];
  let invalid = 0;
  for (const raw of results) {
    const parsed = SyncChangeResultSchema.safeParse(raw);
    if (!parsed.success) {
      invalid += 1;
      continue;
    }
    const { changeId, code, version } = parsed.data;
    const named = SYNC_CHANGE_OUTCOMES.find((name) => name === parsed.data.outcome);
    const outcome = named ?? 'retryable_failed';
    const action: SyncChangeAction =
      named === undefined
        ? (reading.unknownOutcomesOf?.(changeId) ?? 0) + 1 >= holdAfter
          ? 'hold'
          : 'retry'
        : knownAction(named, changeId, reading);
    classified.push({
      changeId,
      outcome,
      known: named !== undefined,
      ...(typeof code === 'string' && { code }),
      ...(action === 'acknowledge' && typeof version === 'number' && { version }),
      action,
    });
  }
  return { results: classified, invalid };
}

/** One stream of a page: the last version it returned, and whether it was cut by its limit. */
export interface SyncStreamPage {
  readonly lastVersion: number | null;
  readonly truncated: boolean;
}

/**
 * One cursor over several streams whose rows carry their own versions. The
 * next page starts at the lowest last version of a stream that was cut, so no
 * stream skips rows; a row may come twice, and applying it is idempotent. A
 * stream cut without a version cannot say where to continue and is refused.
 */
export function mergeStreamCursors(streams: readonly SyncStreamPage[]): {
  hasMore: boolean;
  nextCursor: number | null;
  latestVersion?: number;
} {
  const cut: number[] = [];
  const versions: number[] = [];
  for (const stream of streams) {
    if (stream.lastVersion !== null) versions.push(stream.lastVersion);
    if (!stream.truncated) continue;
    if (stream.lastVersion === null)
      throw new RangeError(
        '[stitchkit] sync: a stream cut by its limit names its last version',
      );
    cut.push(stream.lastVersion);
  }
  return {
    hasMore: cut.length > 0,
    nextCursor: cut.length > 0 ? Math.min(...cut) : null,
    ...(versions.length > 0 && { latestVersion: Math.max(...versions) }),
  };
}
