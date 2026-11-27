import { abortReason, raceAbort } from '../../internal/abort-race';
import { assertTimerMs } from '../../internal/deadline';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import type { CodexControlClient } from './control-client';
import type { CodexListedTurn } from './protocol';
import { assertNonEmptyThreadId, assertRequiredNonEmptyString } from './thread-controls';

const DEFAULT_FIND_TURN_MAX_PAGES = 256;
const DEFAULT_FIND_TURN_PAGE_SIZE = 50;
const MAX_UINT32 = 0xffff_ffff;

/** Minimum cursor-bearing shape required by {@link iterateCodexPages}. */
export interface CodexPageCursorResult {
  /** Opaque continuation cursor for the next page, or `null`/`undefined` when no more pages exist. */
  readonly nextCursor?: string | null | undefined;
}

/** Options controlling bounded cursor pagination in {@link iterateCodexPages}. */
export interface IterateCodexPagesOptions {
  /** Maximum number of pages to request before stopping with `truncated: true`. */
  readonly maxPages: number;
  /** Optional cancellation signal checked before and during every page fetch. */
  readonly signal?: AbortSignal | undefined;
  /** What to do when a server repeats a previously seen cursor: `'throw'` (default) or `'stop'`. */
  readonly onRepeatedCursor?: 'throw' | 'stop' | undefined;
}

/** Collected pages and truncation status returned by {@link iterateCodexPages}. */
export interface IterateCodexPagesResult<TPage extends CodexPageCursorResult> {
  /** All fetched pages in request order. */
  readonly pages: readonly TPage[];
  /** `true` when `maxPages` was reached while the last page still advertised a `nextCursor`, or stopped early on a repeated cursor. */
  readonly truncated: boolean;
}

async function walkCodexPages<TPage extends CodexPageCursorResult>(
  fetchPage: (cursor: string | undefined) => Promise<TPage>,
  options: IterateCodexPagesOptions,
  onPage: (page: TPage) => 'continue' | 'stop',
  repeatedCursorLabel: string,
): Promise<{ readonly truncated: boolean; readonly stoppedByConsumer: boolean }> {
  assertPositiveSafeInteger('maxPages', options.maxPages, TypeError, { absent: 'refused' });
  const onRepeatedCursor = options.onRepeatedCursor ?? 'throw';
  if (onRepeatedCursor !== 'throw' && onRepeatedCursor !== 'stop') {
    throw new TypeError(
      `[stitchkit] iterateCodexPages: onRepeatedCursor must be "throw" or "stop", received ${JSON.stringify(onRepeatedCursor)}`,
    );
  }
  const signal = options.signal;
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let pageIndex = 0; pageIndex < options.maxPages; pageIndex += 1) {
    if (signal?.aborted) throw abortReason(signal);
    const pending = fetchPage(cursor);
    const page = signal !== undefined ? await raceAbort(pending, signal) : await pending;
    if (signal?.aborted) throw abortReason(signal);
    if (onPage(page) === 'stop') {
      return { truncated: false, stoppedByConsumer: true };
    }
    const next = page.nextCursor;
    if (next === null || next === undefined) {
      return { truncated: false, stoppedByConsumer: false };
    }
    if (seen.has(next)) {
      if (onRepeatedCursor === 'stop') {
        return { truncated: true, stoppedByConsumer: false };
      }
      throw new Error(
        `Codex ${repeatedCursorLabel} repeated cursor ${JSON.stringify(next)} before history ended`,
      );
    }
    seen.add(next);
    cursor = next;
  }
  return { truncated: true, stoppedByConsumer: false };
}

/**
 * Iterate a cursor-paginated Codex RPC (`listTurns`, `listThreads`, `listModels`, `listItems`)
 * with bounded page count, repeated-cursor loop protection, empty-string opaque cursor support,
 * and `AbortSignal` cancellation.
 */
export async function iterateCodexPages<TPage extends CodexPageCursorResult>(
  fetchPage: (cursor: string | undefined) => Promise<TPage>,
  options: IterateCodexPagesOptions,
): Promise<IterateCodexPagesResult<TPage>> {
  const pages: TPage[] = [];
  const outcome = await walkCodexPages(
    fetchPage,
    options,
    (page) => {
      pages.push(page);
      return 'continue';
    },
    'pagination',
  );
  return { pages, truncated: outcome.truncated };
}

/** Parameters for locating a turn by `clientId` on a live Codex control connection or session. */
export interface FindCodexTurnByClientIdParams {
  /** Thread identifier whose turn history will be scanned. */
  readonly threadId: string;
  /** Client-generated `clientUserMessageId` to match against `userMessage` items. */
  readonly clientId: string;
  /** Maximum pages to inspect before failing closed. Default `256`. */
  readonly maxPages?: number | undefined;
  /** Page size passed to `thread/turns/list` (`1..4294967295`). Default `50`. */
  readonly pageSize?: number | undefined;
  /** Optional cancellation signal checked before and during every page request. */
  readonly signal?: AbortSignal | undefined;
  /** Optional per-page RPC timeout in milliseconds forwarded to `listTurns`. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Locate the turn carrying a `userMessage` with `clientId` over a live {@link CodexControlClient}
 * (`CodexControlConnection`, `CodexSharedServer`, or `CodexSession`) without spawning a new process.
 *
 * Streams pages without buffering prior pages, stops immediately on match, fails closed if any
 * returned turn declares an incomplete `itemsView` (anything other than `'full'`), and throws if
 * `maxPages` is exhausted before history ends.
 */
export async function findCodexTurnByClientId(
  controls: Pick<CodexControlClient, 'listTurns'>,
  params: FindCodexTurnByClientIdParams,
): Promise<CodexListedTurn | null> {
  const caller = 'findCodexTurnByClientId';
  const threadId = assertNonEmptyThreadId(params.threadId, caller);
  const clientId = assertRequiredNonEmptyString(params.clientId, 'clientId', caller);
  const maxPages = params.maxPages ?? DEFAULT_FIND_TURN_MAX_PAGES;
  const pageSize = params.pageSize ?? DEFAULT_FIND_TURN_PAGE_SIZE;
  assertPositiveSafeInteger(`[stitchkit] ${caller}: maxPages`, maxPages);
  assertPositiveSafeInteger(`[stitchkit] ${caller}: pageSize`, pageSize);
  if (pageSize > MAX_UINT32) {
    throw new TypeError(`[stitchkit] ${caller}: pageSize must not exceed ${MAX_UINT32}`);
  }
  if (params.timeoutMs !== undefined) {
    assertTimerMs('timeoutMs', params.timeoutMs);
  }
  const rpcOptions =
    params.timeoutMs !== undefined || params.signal !== undefined
      ? {
          ...(params.timeoutMs !== undefined && { timeoutMs: params.timeoutMs }),
          ...(params.signal !== undefined && { signal: params.signal }),
        }
      : undefined;

  let matched: CodexListedTurn | null = null;
  const outcome = await walkCodexPages(
    (cursor) =>
      controls.listTurns(
        {
          threadId,
          limit: pageSize,
          itemsView: 'full',
          ...(cursor !== undefined && { cursor }),
        },
        rpcOptions,
      ),
    {
      maxPages,
      signal: params.signal,
      onRepeatedCursor: 'throw',
    },
    (page) => {
      for (const turn of page.data) {
        if (turn.itemsView !== undefined && turn.itemsView !== 'full') {
          throw new Error(
            `Codex thread/turns/list returned incomplete itemsView ${JSON.stringify(turn.itemsView)} for turn ${turn.id}`,
          );
        }
      }
      for (const turn of page.data) {
        if (
          turn.items.some((item) => item.type === 'userMessage' && item.clientId === clientId)
        ) {
          matched = turn;
          return 'stop';
        }
      }
      return 'continue';
    },
    'thread/turns/list',
  );
  if (outcome.stoppedByConsumer) return matched;
  if (outcome.truncated) {
    throw new Error(
      `Codex thread/turns/list exceeded ${maxPages} pages without reaching the end of history`,
    );
  }
  return null;
}
