import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  BoundedOperationWaitError,
  createBoundedAdmission,
} from '../src/entrypoints/application';
import { DEADLINE_BUDGET_HEADER, defineContract } from '../src/entrypoints/contract';
import { createClient, createHttpClient } from '../src/entrypoints/http';
import { AppError, createHandler, implement } from '../src/entrypoints/server';
import {
  applyOutboundDeadlineHeader,
  outboundDeadlineHeaderValue,
  parseDeadlineBudgetHeader,
} from '../src/internal/deadline-budget';

const hopBContract = defineContract(
  { prefix: 'hop-b' },
  {
    inspect: {
      method: 'POST',
      path: '/inspect',
      desc: 'Inspect remaining deadline budget on hop B',
      timeout: 5_000,
      input: z.object({ delayMs: z.number().int().nonnegative().optional() }),
      output: z.object({
        receivedHeader: z.string().nullable(),
        remainingMs: z.number().nullable(),
        aborted: z.boolean(),
      }),
    },
    capped: {
      method: 'GET',
      path: '/capped',
      desc: 'Endpoint with tight 400ms contract timeout ceiling',
      timeout: 400,
      output: z.object({ remainingMs: z.number().nullable() }),
    },
    unbounded: {
      method: 'GET',
      path: '/unbounded',
      desc: 'Endpoint without a declared timeout',
      output: z.object({ remainingMs: z.number().nullable() }),
    },
  },
);

const hopAContract = defineContract(
  { prefix: 'hop-a' },
  {
    forward: {
      method: 'POST',
      path: '/forward',
      desc: 'Forward remaining deadline budget minus reserve to admission and hop B',
      timeout: 10_000,
      input: z.object({
        workBeforeForwardMs: z.number().int().nonnegative().default(0),
        reserveMs: z.number().int().nonnegative().default(200),
        hopBDelayMs: z.number().int().nonnegative().default(0),
      }),
      output: z.object({
        hopARemainingBefore: z.number().nullable(),
        hopBReceivedHeader: z.string().nullable(),
        hopBRemainingMs: z.number().nullable(),
      }),
    },
  },
);

describe('HTTP client/server deadline budget propagation', () => {
  test('propagates relative budget across two hops, narrows after local work and feeds createBoundedAdmission without AsyncLocalStorage', async () => {
    const admission = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: 2 },
        perKey: { maxConcurrent: 2, maxKeys: 16 },
      },
    });
    const hopBHandler = createHandler({
      services: [
        implement(hopBContract, {
          inspect: async (ctx) => {
            if (ctx.input.delayMs) {
              await new Promise((resolve) => setTimeout(resolve, ctx.input.delayMs));
            }
            return {
              receivedHeader: ctx.headers?.get(DEADLINE_BUDGET_HEADER) ?? null,
              remainingMs: ctx.remainingTimeoutMs?.() ?? null,
              aborted: ctx.signal?.aborted ?? false,
            };
          },
          capped: (ctx) => ({ remainingMs: ctx.remainingTimeoutMs?.() ?? null }),
          unbounded: (ctx) => ({ remainingMs: ctx.remainingTimeoutMs?.() ?? null }),
        }),
      ],
    });

    const hopBClient = createClient(hopBContract, {
      baseUrl: 'http://hop-b.local',
      fetch: (input, init) =>
        hopBHandler(input instanceof Request ? input : new Request(input, init)),
    });

    const hopAHandler = createHandler({
      services: [
        implement(hopAContract, {
          forward: async (ctx) => {
            const hopARemainingBefore = ctx.remainingTimeoutMs?.() ?? null;
            if (ctx.input.workBeforeForwardMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, ctx.input.workBeforeForwardMs),
              );
            }
            const forwardedBudget = ctx.remainingTimeoutMs?.(ctx.input.reserveMs);
            const result = await admission.run(
              'peer-op',
              async ({ signal }) => {
                if (forwardedBudget !== undefined && forwardedBudget <= 0) {
                  throw new AppError('REQUEST_TIMEOUT', {
                    status: 408,
                    message: 'Not enough budget left for downstream hop',
                  });
                }
                return hopBClient.inspect.withOptions(
                  { delayMs: ctx.input.hopBDelayMs },
                  {
                    ...(forwardedBudget !== undefined && { timeout: forwardedBudget }),
                    signal,
                  },
                );
              },
              {
                ...(forwardedBudget !== undefined && { timeoutMs: forwardedBudget }),
                signal: ctx.signal,
              },
            );
            return {
              hopARemainingBefore,
              hopBReceivedHeader: result.receivedHeader,
              hopBRemainingMs: result.remainingMs,
            };
          },
        }),
      ],
    });

    const hopAClient = createClient(hopAContract, {
      baseUrl: 'http://hop-a.local',
      fetch: (input, init) =>
        hopAHandler(input instanceof Request ? input : new Request(input, init)),
    });

    const out = await hopAClient.forward.withOptions(
      { workBeforeForwardMs: 60, reserveMs: 300, hopBDelayMs: 0 },
      { timeout: 2_000 },
    );

    expect(out.hopARemainingBefore).not.toBeNull();
    expect(out.hopARemainingBefore ?? 0).toBeGreaterThan(1_500);
    expect(out.hopARemainingBefore ?? 0).toBeLessThanOrEqual(2_000);
    expect(out.hopBReceivedHeader).not.toBeNull();
    const hopBHeaderMs = Number(out.hopBReceivedHeader);
    expect(hopBHeaderMs).toBeLessThan(out.hopARemainingBefore ?? 0);
    expect(hopBHeaderMs).toBeLessThanOrEqual(1_700);
    expect(out.hopBRemainingMs).not.toBeNull();
    expect(out.hopBRemainingMs ?? 0).toBeLessThanOrEqual(hopBHeaderMs);
  });

  test('clamps inbound budget to endpoint contract ceiling, rejects expired 0 budget with 408 and ignores malformed headers', async () => {
    let handlerCalls = 0;
    const handler = createHandler({
      services: [
        implement(hopBContract, {
          inspect: (ctx) => {
            handlerCalls += 1;
            return {
              receivedHeader: ctx.headers?.get(DEADLINE_BUDGET_HEADER) ?? null,
              remainingMs: ctx.remainingTimeoutMs?.() ?? null,
              aborted: ctx.signal?.aborted ?? false,
            };
          },
          capped: (ctx) => {
            handlerCalls += 1;
            return { remainingMs: ctx.remainingTimeoutMs?.() ?? null };
          },
          unbounded: (ctx) => {
            handlerCalls += 1;
            return { remainingMs: ctx.remainingTimeoutMs?.() ?? null };
          },
        }),
      ],
    });

    // 1. Unit checks on header parser.
    expect(parseDeadlineBudgetHeader(null)).toEqual({ kind: 'absent' });
    expect(parseDeadlineBudgetHeader('0')).toEqual({ kind: 'expired' });
    expect(parseDeadlineBudgetHeader(' 0 ')).toEqual({ kind: 'expired' });
    expect(parseDeadlineBudgetHeader('-50')).toEqual({ kind: 'invalid' });
    expect(parseDeadlineBudgetHeader('abc')).toEqual({ kind: 'invalid' });
    expect(parseDeadlineBudgetHeader('12.5')).toEqual({ kind: 'invalid' });
    expect(parseDeadlineBudgetHeader('2500')).toEqual({ kind: 'ok', timeoutMs: 2_500 });

    // 2. Inbound header 90_000ms is clamped to endpoint ceiling 400ms.
    const clampedRes = await handler(
      new Request('http://local/hop-b/capped', {
        headers: { [DEADLINE_BUDGET_HEADER]: '90000' },
      }),
    );
    expect(clampedRes.status).toBe(200);
    const clampedBody = (await clampedRes.json()) as { remainingMs: number | null };
    expect(clampedBody.remainingMs).not.toBeNull();
    expect(clampedBody.remainingMs ?? 0).toBeGreaterThan(0);
    expect(clampedBody.remainingMs ?? 0).toBeLessThanOrEqual(400);

    // 3. Expired '0' header fails fast with 408 REQUEST_TIMEOUT before handler runs.
    const callsBeforeExpired = handlerCalls;
    const expiredRes = await handler(
      new Request('http://local/hop-b/capped', {
        headers: { [DEADLINE_BUDGET_HEADER]: '0' },
      }),
    );
    expect(expiredRes.status).toBe(408);
    expect(handlerCalls).toBe(callsBeforeExpired);
    const expiredBody = (await expiredRes.json()) as { error: { code: string } };
    expect(expiredBody.error.code).toBe('REQUEST_TIMEOUT');

    // 4. Malformed header ('-10', 'not-a-number') is ignored: capped keeps 400ms, unbounded stays null.
    const badOnCapped = await handler(
      new Request('http://local/hop-b/capped', {
        headers: { [DEADLINE_BUDGET_HEADER]: 'not-a-number' },
      }),
    );
    expect(badOnCapped.status).toBe(200);
    const badCappedBody = (await badOnCapped.json()) as { remainingMs: number | null };
    expect(badCappedBody.remainingMs ?? 0).toBeLessThanOrEqual(400);

    const badOnUnbounded = await handler(
      new Request('http://local/hop-b/unbounded', {
        headers: { [DEADLINE_BUDGET_HEADER]: '-500' },
      }),
    );
    expect(badOnUnbounded.status).toBe(200);
    expect(await badOnUnbounded.json()).toEqual({ remainingMs: null });
  });

  test('server ctx.signal aborts when propagated budget expires so createBoundedAdmission stops deterministically', async () => {
    const admission = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: 1 },
        perKey: { maxConcurrent: 1, maxKeys: 16 },
      },
    });
    let admissionErrorName = '';
    let signalAborted = false;

    const handler = createHandler({
      services: [
        implement(hopBContract, {
          inspect: async (ctx) => {
            try {
              await admission.run(
                'slow-op',
                async ({ signal }) => {
                  await new Promise<void>((resolve) => {
                    if (signal.aborted) {
                      resolve();
                      return;
                    }
                    signal.addEventListener('abort', () => resolve(), { once: true });
                  });
                },
                {
                  // Intentionally larger than the 60 ms propagated header so server ctx.signal expiry is what aborts admission.
                  timeoutMs: 5_000,
                  signal: ctx.signal,
                },
              );
            } catch (error) {
              signalAborted = ctx.signal?.aborted ?? false;
              if (error instanceof BoundedOperationWaitError) {
                admissionErrorName = `${error.name}:${error.reason}`;
                throw new AppError('REQUEST_TIMEOUT', {
                  status: 408,
                  message: 'Bounded admission timed out on caller deadline',
                });
              }
              throw error;
            }
            return { receivedHeader: null, remainingMs: 0, aborted: false };
          },
          capped: () => ({ remainingMs: null }),
          unbounded: () => ({ remainingMs: null }),
        }),
      ],
    });

    const res = await handler(
      new Request('http://local/hop-b/inspect', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [DEADLINE_BUDGET_HEADER]: '60',
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(408);
    expect(signalAborted).toBe(true);
    expect(admissionErrorName).toMatch(/^BoundedOperationWaitError:(timed-out|cancelled)$/);
  });

  test('createHttpClient and createClient honour propagateDeadline: true and false', async () => {
    const seenHeaders: Array<string | null> = [];
    const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seenHeaders.push(req.headers.get(DEADLINE_BUDGET_HEADER));
      return new Response(JSON.stringify({ remainingMs: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const httpPropagating = createHttpClient({
      baseUrl: 'http://example.local',
      timeout: 4_000,
      propagateDeadline: true,
      fetch: customFetch,
    });
    await httpPropagating.get('hop-b/unbounded');
    expect(seenHeaders[0]).not.toBeNull();
    expect(Number(seenHeaders[0])).toBeGreaterThan(3_000);
    expect(Number(seenHeaders[0])).toBeLessThanOrEqual(4_000);

    // Explicit propagateDeadline: false suppresses header even when timeout is provided.
    await httpPropagating.get('hop-b/unbounded', { timeout: 2_000, propagateDeadline: false });
    expect(seenHeaders[1]).toBeNull();

    // Typed client with propagateDeadline: true sends header even on endpoints without declared timeout.
    const typedPropagating = createClient(hopBContract, {
      baseUrl: 'http://example.local',
      timeout: 3_500,
      propagateDeadline: true,
      fetch: customFetch,
    });
    await typedPropagating.unbounded();
    expect(seenHeaders[2]).not.toBeNull();
    expect(Number(seenHeaders[2])).toBeLessThanOrEqual(3_500);

    await typedPropagating.unbounded.withOptions({ timeout: 1_200, propagateDeadline: false });
    expect(seenHeaders[3]).toBeNull();
  });

  test('propagateDeadline: false at client level still propagates per-call timeout unless per-call propagateDeadline: false', async () => {
    const seenHeaders: Array<string | null> = [];
    const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seenHeaders.push(req.headers.get(DEADLINE_BUDGET_HEADER));
      return new Response(JSON.stringify({ remainingMs: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const httpOptOut = createHttpClient({
      baseUrl: 'http://example.local',
      timeout: 4_000,
      propagateDeadline: false,
      fetch: customFetch,
    });
    await httpOptOut.get('hop-b/unbounded');
    await httpOptOut.get('hop-b/unbounded', { timeout: 1_500 });
    await httpOptOut.get('hop-b/unbounded', { timeout: 1_500, propagateDeadline: false });

    const typedOptOut = createClient(hopBContract, {
      baseUrl: 'http://example.local',
      timeout: 4_000,
      propagateDeadline: false,
      fetch: customFetch,
    });
    await typedOptOut.unbounded();
    await typedOptOut.unbounded.withOptions({ timeout: 1_500 });
    await typedOptOut.unbounded.withOptions({ timeout: 1_500, propagateDeadline: false });

    expect(seenHeaders[0]).toBeNull();
    expect(Number(seenHeaders[1])).toBeGreaterThan(0);
    expect(Number(seenHeaders[1])).toBeLessThanOrEqual(1_500);
    expect(seenHeaders[2]).toBeNull();
    expect(seenHeaders[3]).toBeNull();
    expect(Number(seenHeaders[4])).toBeGreaterThan(0);
    expect(Number(seenHeaders[4])).toBeLessThanOrEqual(1_500);
    expect(seenHeaders[5]).toBeNull();
  });

  test('applyOutboundDeadlineHeader never mutates Request headers in place, emits 0 when expired, and recomputes budget on transport retries', async () => {
    // 1. Expired deadlineAt emits '0', never '1'.
    expect(outboundDeadlineHeaderValue(performance.now() - 50)).toBe('0');

    // 2. Calling applyOutboundDeadlineHeader twice on the same Request never mutates original headers and narrows budget.
    const originalReq = new Request('http://example.local/hop-b/unbounded');
    const deadlineAt = performance.now() + 2_000;
    const first = applyOutboundDeadlineHeader(originalReq, undefined, deadlineAt);
    expect(originalReq.headers.get(DEADLINE_BUDGET_HEADER)).toBeNull();
    expect(first.input).toBeInstanceOf(Request);
    const firstMs = Number((first.input as Request).headers.get(DEADLINE_BUDGET_HEADER));
    expect(firstMs).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = applyOutboundDeadlineHeader(originalReq, undefined, deadlineAt);
    expect(originalReq.headers.get(DEADLINE_BUDGET_HEADER)).toBeNull();
    const secondMs = Number((second.input as Request).headers.get(DEADLINE_BUDGET_HEADER));
    expect(secondMs).toBeLessThan(firstMs);

    // Caller-supplied header on Request wins untouched.
    const callerReq = new Request('http://example.local/hop-b/unbounded', {
      headers: { [DEADLINE_BUDGET_HEADER]: '777' },
    });
    const preserved = applyOutboundDeadlineHeader(callerReq, undefined, deadlineAt);
    expect((preserved.input as Request).headers.get(DEADLINE_BUDGET_HEADER)).toBe('777');

    // 3. Live transport retries on BOTH createHttpClient and createClient recompute remaining budget.
    const runRetryProbe = async (mode: 'http' | 'typed') => {
      const attemptHeaders: number[] = [];
      let attempt = 0;
      const flakyFetch = async (input: string | URL | Request, init?: RequestInit) => {
        attempt += 1;
        const req = input instanceof Request ? input : new Request(input, init);
        attemptHeaders.push(Number(req.headers.get(DEADLINE_BUDGET_HEADER)));
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          const err = new Error('connection reset') as Error & { code?: string };
          err.code = 'ECONNRESET';
          throw err;
        }
        return new Response(JSON.stringify({ remainingMs: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      if (mode === 'http') {
        const client = createHttpClient({
          baseUrl: 'http://example.local',
          timeout: 2_000,
          propagateDeadline: true,
          retry: { limit: 1 },
          fetch: flakyFetch,
        });
        await client.get('hop-b/unbounded');
      } else {
        const client = createClient(hopBContract, {
          baseUrl: 'http://example.local',
          timeout: 2_000,
          propagateDeadline: true,
          retry: { limit: 1 },
          fetch: flakyFetch,
        });
        await client.unbounded();
      }
      expect(attemptHeaders.length).toBe(2);
      expect(attemptHeaders[1] ?? 0).toBeLessThan(attemptHeaders[0] ?? 0);
    };

    await runRetryProbe('http');
    await runRetryProbe('typed');
  });

  test('hooks.authorize runs before 408 REQUEST_TIMEOUT on expired 0 budget (I12)', async () => {
    let beforeHandleCalls = 0;
    let handlerCalls = 0;
    const handler = createHandler({
      services: [
        implement(hopBContract, {
          inspect: () => {
            handlerCalls += 1;
            return { receivedHeader: null, remainingMs: null, aborted: false };
          },
          capped: () => {
            handlerCalls += 1;
            return { remainingMs: null };
          },
          unbounded: () => {
            handlerCalls += 1;
            return { remainingMs: null };
          },
        }),
      ],
      hooks: {
        authorize: (ctx) => {
          if (ctx.headers?.get('authorization') !== 'Bearer good-token') {
            throw new AppError('UNAUTHORIZED', { status: 401, message: 'Unauthorized' });
          }
        },
        beforeHandle: () => {
          beforeHandleCalls += 1;
        },
      },
    });

    // Unauthorized request with expired '0' header gets 401 UNAUTHORIZED (trust before work, I12).
    const unauthRes = await handler(
      new Request('http://local/hop-b/capped', {
        headers: { [DEADLINE_BUDGET_HEADER]: '0' },
      }),
    );
    expect(unauthRes.status).toBe(401);
    expect(beforeHandleCalls).toBe(0);
    expect(handlerCalls).toBe(0);

    // Authorized request with expired '0' header fails fast with 408 REQUEST_TIMEOUT before beforeHandle/handler.
    const authExpiredRes = await handler(
      new Request('http://local/hop-b/capped', {
        headers: {
          authorization: 'Bearer good-token',
          [DEADLINE_BUDGET_HEADER]: '0',
        },
      }),
    );
    expect(authExpiredRes.status).toBe(408);
    expect(beforeHandleCalls).toBe(0);
    expect(handlerCalls).toBe(0);
  });
});
