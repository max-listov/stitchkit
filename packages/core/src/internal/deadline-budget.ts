import { assertTimerMs } from './deadline';
import { isPositiveSafeInteger } from './positive-integer';
import { clampTimerMs } from './timers';

/** Relative remaining call budget in integer milliseconds propagated across HTTP hops. */
export const DEADLINE_BUDGET_HEADER = 'x-stitchkit-timeout-ms';

/** Parsed outcome of an inbound {@link DEADLINE_BUDGET_HEADER} value. */
export type ParsedDeadlineBudgetHeader =
  | { readonly kind: 'absent' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly timeoutMs: number };

/** Effective server-side deadline budget after combining inbound header and endpoint contract ceiling. */
export type ServerDeadlineBudget =
  | { readonly kind: 'unbounded' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'bounded'; readonly budgetMs: number };

const POSITIVE_INT_RE = /^[1-9]\d{0,15}$/;

/**
 * Parse a relative remaining deadline header value in milliseconds.
 *
 * - Missing/null → `'absent'`
 * - `'0'` → `'expired'` (caller's budget already exhausted)
 * - Positive ASCII integer → `'ok'` clamped to `MAX_TIMER_MS`
 * - Anything else (negative, float, non-numeric, empty) → `'invalid'`
 */
export function parseDeadlineBudgetHeader(
  raw: string | null | undefined,
): ParsedDeadlineBudgetHeader {
  if (raw === null || raw === undefined) return { kind: 'absent' };
  const trimmed = raw.trim();
  if (trimmed === '0') return { kind: 'expired' };
  if (!POSITIVE_INT_RE.test(trimmed)) return { kind: 'invalid' };
  const parsed = Number(trimmed);
  if (!isPositiveSafeInteger(parsed)) return { kind: 'invalid' };
  return { kind: 'ok', timeoutMs: clampTimerMs(parsed) };
}

/**
 * Combine an inbound {@link DEADLINE_BUDGET_HEADER} with the endpoint's declared `timeout` ceiling.
 * An expired (`'0'`) header fails immediately; an invalid header is ignored so the endpoint's own
 * ceiling remains intact; a valid positive header is clamped to `endpointTimeoutMs` when declared.
 */
export function resolveServerDeadlineBudget(input: {
  readonly headerValue: string | null | undefined;
  readonly endpointTimeoutMs: number | undefined;
}): ServerDeadlineBudget {
  const parsed = parseDeadlineBudgetHeader(input.headerValue);
  if (parsed.kind === 'expired') return { kind: 'expired' };
  if (parsed.kind === 'ok') {
    const budgetMs =
      input.endpointTimeoutMs !== undefined
        ? Math.min(parsed.timeoutMs, input.endpointTimeoutMs)
        : parsed.timeoutMs;
    return { kind: 'bounded', budgetMs };
  }
  if (input.endpointTimeoutMs !== undefined) {
    return { kind: 'bounded', budgetMs: input.endpointTimeoutMs };
  }
  return { kind: 'unbounded' };
}

/**
 * Build a monotonic remaining-budget reader (`ctx.remainingTimeoutMs`).
 * Returns integer milliseconds remaining (`>= 0`) after subtracting optional `reserveMs`.
 */
export function createRemainingTimeoutReader(
  deadlineAt: number,
): (reserveMs?: number) => number {
  return (reserveMs?: number): number => {
    if (reserveMs !== undefined) {
      assertTimerMs('remainingTimeoutMs reserveMs', reserveMs, { min: 0 });
    }
    const remaining = Math.floor(deadlineAt - performance.now()) - (reserveMs ?? 0);
    return Math.max(0, remaining);
  };
}

/** Compute the integer milliseconds left before `deadlineAt` for an outbound hop header (`'0'` when expired). */
export function outboundDeadlineHeaderValue(deadlineAt: number): string {
  const remaining = Math.ceil(deadlineAt - performance.now());
  if (remaining <= 0) return '0';
  return String(clampTimerMs(remaining));
}

/**
 * Attach {@link DEADLINE_BUDGET_HEADER} with the live remaining budget before `deadlineAt`
 * unless the caller already set that header explicitly. Never mutates an incoming `Request`
 * in place so transport retries recompute the remaining budget cleanly.
 */
export function applyOutboundDeadlineHeader(
  input: string | URL | Request,
  init: RequestInit | undefined,
  deadlineAt: number | undefined,
): { readonly input: string | URL | Request; readonly init: RequestInit | undefined } {
  if (deadlineAt === undefined) return { input, init };
  if (input instanceof Request) {
    if (init?.headers !== undefined) {
      const headers = new Headers(init.headers);
      if (headers.has(DEADLINE_BUDGET_HEADER)) return { input, init };
      headers.set(DEADLINE_BUDGET_HEADER, outboundDeadlineHeaderValue(deadlineAt));
      return { input: new Request(input, { headers }), init: { ...init, headers } };
    }
    if (input.headers.has(DEADLINE_BUDGET_HEADER)) return { input, init };
    const headers = new Headers(input.headers);
    headers.set(DEADLINE_BUDGET_HEADER, outboundDeadlineHeaderValue(deadlineAt));
    return { input: new Request(input, { headers }), init };
  }
  const headers = new Headers(init?.headers);
  if (!headers.has(DEADLINE_BUDGET_HEADER)) {
    headers.set(DEADLINE_BUDGET_HEADER, outboundDeadlineHeaderValue(deadlineAt));
  }
  return { input, init: { ...init, headers } };
}
