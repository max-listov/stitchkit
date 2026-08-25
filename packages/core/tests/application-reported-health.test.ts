import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createApplication } from '../src/application/kernel';
import { defineManagedResource } from '../src/application/resource';
import { managedServerResource } from '../src/application/server-resource';
import { defineContract } from '../src/contract';
import { createServer } from '../src/server/bun';
import { implement } from '../src/server/implement';
import {
  type ManagedServerHandle,
  type ShutdownOptions,
  ShutdownOptionsSchema,
} from '../src/server/shutdown';

/**
 * Two reports from a consumer, both about a value the kernel accepted and then
 * threw away — the worst shape a failure can take, because there is no error
 * and no trace.
 */

/**
 * A managed server that records what it was asked to do. The adapter only calls
 * `shutdown`, but the shape is written out whole rather than cast: a change to
 * `ManagedServerHandle` becomes a compile error here instead of a silently
 * unexercised double.
 */
function capturingServer(captured: ShutdownOptions[]): ManagedServerHandle<undefined> {
  const counts = {
    acceptedRequests: 0,
    completedRequests: 0,
    pendingRequests: 0,
    pendingWebSockets: 0,
    pendingRequestsAtForce: 0,
    pendingWebSocketsAtForce: 0,
    abortedRequests: 0,
    forcedWebSockets: 0,
    durationMs: 0,
  };
  return {
    url: 'http://127.0.0.1:0',
    port: 0,
    runtime: undefined,
    status: { state: 'running', ...counts },
    shutdown: (options?: ShutdownOptions) => {
      captured.push(options ?? {});
      return Promise.resolve({ outcome: 'clean' as const, ...counts });
    },
  };
}

describe('a resource that reports its own health is believed', () => {
  test('an optional resource that starts degraded stays degraded', async () => {
    // Becoming ready used to assign `healthy` unconditionally. The guide's own
    // minimal example reports `healthy`, which is the same value that
    // overwrote it — so the example appeared to work and taught the habit,
    // while a resource that starts DEGRADED on purpose (up, but still dialling
    // something external) was silently reported as fine.
    const app = createApplication({
      id: 'reported',
      resources: [
        defineManagedResource({
          id: 'dialling',
          required: false,
          start: ({ reportHealth }) => {
            reportHealth('degraded');
          },
        }),
      ],
    });
    const snapshot = await app.start();
    try {
      expect(snapshot.health).toBe('degraded');
      // The application is still ready: an optional resource does not gate it.
      expect(snapshot.ready).toBe(true);
      expect(snapshot.resources.find((entry) => entry.id === 'dialling')?.health).toBe(
        'degraded',
      );
    } finally {
      await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
    }
  });

  test('a resource that says nothing is healthy, as before', async () => {
    // The control. Without it, an implementation that simply stopped assigning
    // health would pass the test above.
    const app = createApplication({
      id: 'silent',
      resources: [defineManagedResource({ id: 'quiet', start: () => undefined })],
    });
    const snapshot = await app.start();
    try {
      expect(snapshot.health).toBe('healthy');
      expect(snapshot.resources.find((entry) => entry.id === 'quiet')?.health).toBe('healthy');
    } finally {
      await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
    }
  });

  test('a REQUIRED resource that starts degraded is refused, and told why', async () => {
    // Deliberate, and now sayable. Readiness requires every required resource
    // to be healthy, so "ready but degraded" is unreachable for one by
    // construction. What changed is that the refusal names the resource and its
    // state instead of claiming it "lost readiness" — which it never had.
    const app = createApplication({
      id: 'required-degraded',
      resources: [
        defineManagedResource({
          id: 'core',
          start: ({ reportHealth }) => {
            reportHealth('degraded');
          },
        }),
      ],
    });
    const failure = await app.start().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('"core" is not healthy (ready/degraded)');
    expect(message).toContain('required: false');
    // It never had readiness, so it cannot have lost it.
    expect(message).not.toContain('lost readiness');
    await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
  });

  test('the refusal is attributed, not merely thrown', async () => {
    // The half a looser check quietly dropped. Letting the failure fall through
    // to the final readiness gate still refused the startup — no false green —
    // but reported no phase for it, left `onResourceFailure` silent, and let
    // every downstream `activate` run first: schedules armed, long polls opened,
    // all of it rolled back afterwards.
    const failures: { resourceId: string; phase: string }[] = [];
    let downstreamActivated = false;
    const app = createApplication({
      id: 'attributed',
      resources: [
        defineManagedResource({
          id: 'core',
          start: ({ reportHealth }) => {
            reportHealth('degraded');
          },
        }),
        defineManagedResource({
          id: 'after',
          dependsOn: ['core'],
          start: () => undefined,
          activate: () => {
            downstreamActivated = true;
          },
        }),
      ],
      onResourceFailure: ({ resourceId, phase }) => {
        failures.push({ resourceId, phase });
      },
    });
    await app.start().catch(() => undefined);

    expect(failures).toEqual([{ resourceId: 'core', phase: 'start' }]);
    expect(downstreamActivated).toBe(false);
    await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
  });

  test('a resource that genuinely lost readiness is not told to become optional', async () => {
    // The other direction, and the reason the advice is branched at all:
    // telling the operator of a database that just dropped to put it behind
    // `required: false` is the worst possible suggestion.
    let drop: (() => void) | undefined;
    const app = createApplication({
      id: 'lost',
      resources: [
        defineManagedResource({
          id: 'db',
          start: ({ reportHealth }) => {
            drop = () => reportHealth('unhealthy');
          },
        }),
        defineManagedResource({
          id: 'later',
          dependsOn: ['db'],
          start: () => {
            drop?.();
          },
        }),
      ],
    });
    const failure = await app.start().then(
      () => null,
      (error: unknown) => error,
    );
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('"db" lost readiness');
    expect(message).toContain('(ready/unhealthy)');
    // The advice a resource that CHOSE its state gets would be actively wrong
    // here: a database that just dropped does not belong behind
    // `required: false`.
    expect(message).not.toContain('required: false');
    await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
  });
});

describe('the server adapter hands the server a budget it can accept', () => {
  test('shutting down through managedServerResource is clean, not forced', async () => {
    // `context.now()` is `performance.now()` — fractional — and every budget the
    // adapter built was a subtraction of two such readings, while
    // `ShutdownOptionsSchema` declares both as integers and validates its
    // input. So the server refused every call this adapter made, in every
    // phase, and the application always finished `forced` without ever stopping
    // the server properly. A consumer who followed the guide's advice not to
    // re-implement the shutdown machine ended up worse off than one who did.
    const contract = defineContract(
      { prefix: 'probe' },
      {
        ping: {
          method: 'GET',
          path: '/',
          desc: 'ping',
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    const server = createServer({
      port: 0,
      services: [implement(contract, { ping: () => ({ ok: true }) })],
    });

    const failures: { phase: string; error: string }[] = [];
    const app = createApplication({
      id: 'server-budget',
      resources: [managedServerResource({ id: 'http', server })],
      onResourceFailure: ({ phase, error }) => {
        failures.push({ phase, error: String(error) });
      },
    });
    await app.start();
    const result = await app.shutdown({ gracePeriodMs: 1_000, forceTimeoutMs: 500 });

    expect(result.outcome).toBe('clean');
    // Not merely "it finished": the whole defect was a validation failure per
    // phase, reported only to a hook a consumer may never have wired.
    expect(failures).toEqual([]);
  });

  test('the third integer field is a budget too', async () => {
    // `retryAfterSeconds` is declared `int()` by the same schema and was left
    // out of the first repair — while the upgrade guide actively tells a
    // consumer to move it onto this adapter, where deriving it from a duration
    // (`timeoutMs / 1000`) lands straight on a fraction. The failure was
    // byte-for-byte the reported one, and worse: the server is never closed, so
    // the process hangs rather than exiting forced.
    const contract = defineContract(
      { prefix: 'retry' },
      {
        ping: {
          method: 'GET',
          path: '/',
          desc: 'ping',
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    const server = createServer({
      port: 0,
      services: [implement(contract, { ping: () => ({ ok: true }) })],
    });
    const failures: string[] = [];
    const app = createApplication({
      id: 'retry-budget',
      resources: [
        managedServerResource({ id: 'http', server, retryAfterSeconds: 2_500 / 1_000 }),
      ],
      onResourceFailure: ({ phase }) => {
        failures.push(phase);
      },
    });
    await app.start();
    const result = await app.shutdown({ gracePeriodMs: 1_000, forceTimeoutMs: 500 });
    expect(result.outcome).toBe('clean');
    expect(failures).toEqual([]);
  }, 20_000);

  test('rolling back a failed startup is a shutdown, not an abort', async () => {
    // `closeAttempted` used to call `close` with no deadlines at all, so the
    // adapter's honest arithmetic — `now - now` — produced
    // `{ gracePeriodMs: 0, forceTimeoutMs: 0 }`. A real server, a real request
    // in flight: this is the whole defect end to end, and it cost three things
    // rather than one. The request died at the socket — the client saw a closed
    // connection, not a response. The rollback itself then failed, because
    // `withTimeout(forceStop(), 0)` cannot succeed. And that failure REPLACED
    // the diagnosis: `start()` rejected with an `AggregateError` reading
    // "startup and rollback failed", so the first line an operator read was
    // shutdown machinery, and the resource that actually broke was one entry
    // down.
    const contract = defineContract(
      { prefix: 'slow' },
      {
        work: {
          method: 'GET',
          path: '/',
          desc: 'slow',
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    const server = createServer({
      port: 0,
      services: [
        implement(contract, {
          work: async () => {
            await new Promise((resolve) => setTimeout(resolve, 300));
            return { ok: true };
          },
        }),
      ],
    });
    const app = createApplication({
      id: 'rollback-in-flight',
      resources: [
        managedServerResource({ id: 'http', server }),
        defineManagedResource({
          id: 'breaks',
          dependsOn: ['http'],
          start: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            throw new Error('startup failed on purpose');
          },
        }),
      ],
    });

    const inFlight = fetch(`${server.url}/slow`).then(
      (response) => response.status,
      (error: unknown) => String(error),
    );
    while (server.status.pendingRequests < 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const startedAt = performance.now();
    const failure = await app.start().then(
      () => null,
      (error: unknown) => error,
    );
    const rollbackMs = performance.now() - startedAt;

    // The request the server had already accepted is answered, not severed.
    expect(await inFlight).toBe(200);
    // The startup cause survives on its own, undiluted: the rollback no longer
    // fails, so there is nothing to aggregate it with.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect(failure instanceof Error ? failure.message : '').toBe('startup failed on purpose');
    // A grace period is a CEILING, not a sleep. The default budget is 30s, and
    // the rollback returns as soon as the last request finishes — so a failed
    // startup still fails fast. Anything near the ceiling means the rollback
    // started waiting out the clock instead of watching the work.
    expect(rollbackMs).toBeLessThan(5_000);
  }, 20_000);

  test('a rollback is bounded even when a resource never finishes closing', async () => {
    // The half a budget alone does not buy. `closeAttempted` runs ONE phase —
    // `close` — and nothing wrapped it, so a resource whose `close` never
    // returns held a failed startup open forever: the application could not even
    // report why it failed to start. Handing that loop deadlines without
    // watching them would have left the hang exactly where it was while reading
    // as though it were fixed.
    //
    // The budget is declared here precisely so this is provable in 40ms rather
    // than 35 seconds — a bound nobody can afford to test is a bound nobody can
    // trust.
    const app = createApplication({
      id: 'bounded-rollback',
      shutdown: { gracePeriodMs: 20, forceTimeoutMs: 20 },
      resources: [
        defineManagedResource({
          id: 'stuck',
          start: () => undefined,
          close: () => new Promise<void>(() => undefined),
        }),
        defineManagedResource({
          id: 'breaks',
          dependsOn: ['stuck'],
          start: () => {
            throw new Error('startup failed on purpose');
          },
        }),
      ],
    });

    const startedAt = performance.now();
    const failure = await app.start().then(
      () => null,
      (error: unknown) => error,
    );
    const elapsed = performance.now() - startedAt;

    expect(failure).toBeInstanceOf(AggregateError);
    // The startup cause is not buried by the rollback's own failure.
    expect((failure as AggregateError).cause).toBeInstanceOf(Error);
    expect(((failure as AggregateError).cause as Error).message).toBe(
      'startup failed on purpose',
    );
    expect(
      (failure as AggregateError).errors.some(
        (error: unknown) =>
          error instanceof Error && error.message.includes('did not finish closing'),
      ),
    ).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  }, 20_000);

  test('the declared budget is what the rollback spends', async () => {
    // One number, declared in one place, spent by both paths. Without it the
    // rollback's ceiling was a constant compiled into the kernel — a supervisor
    // policy chosen by a layer that does not choose supervisor policy.
    const captured: ShutdownOptions[] = [];
    const app = createApplication({
      id: 'declared-budget',
      shutdown: { gracePeriodMs: 120, forceTimeoutMs: 40 },
      resources: [
        managedServerResource({ id: 'http', server: capturingServer(captured) }),
        defineManagedResource({
          id: 'breaks',
          dependsOn: ['http'],
          start: () => {
            throw new Error('startup failed on purpose');
          },
        }),
      ],
    });
    await app.start().catch(() => undefined);

    expect(captured).toHaveLength(1);
    // What reaches the server is what REMAINS of the declared budget: it is an
    // absolute deadline, and the time between computing it and reading it has
    // already been spent. So this is a range on purpose — an exact `120` would
    // be a test asserting that no time passes, which is both false and the kind
    // of assertion that fails once on a loaded machine and gets deleted.
    expect(captured[0]?.gracePeriodMs).toBeLessThanOrEqual(120);
    expect(captured[0]?.gracePeriodMs).toBeGreaterThan(100);
    // The force budget is a difference of two deadlines, so it does not decay —
    // only float leaves a sub-millisecond residue, which rounds up.
    expect(captured[0]?.forceTimeoutMs).toBeGreaterThanOrEqual(40);
    expect(captured[0]?.forceTimeoutMs).toBeLessThanOrEqual(41);
  });

  test('an absent deadline is not a spent one', () => {
    // `deadlineAt` is optional on `ManagedResourceContext`, so absence is a
    // legal input — the conformance kit builds such contexts, and so may a
    // consumer. The adapter used to answer it with `now - now`, i.e. "your
    // budget is zero", which is the whole defect one layer down from where it
    // was reported. It now says nothing and lets the schema that owns these
    // numbers apply its own defaults.
    const captured: ShutdownOptions[] = [];
    const resource = managedServerResource({ id: 'fake', server: capturingServer(captured) });
    void resource.close?.({
      applicationId: 'x',
      signal: new AbortController().signal,
      now: () => 1_000.25,
      reportHealth: () => undefined,
    });

    expect(captured).toHaveLength(1);
    expect(Object.hasOwn(captured[0] ?? {}, 'gracePeriodMs')).toBe(false);
    expect(Object.hasOwn(captured[0] ?? {}, 'forceTimeoutMs')).toBe(false);
    // What the server will therefore use: the schema's defaults, not zero.
    const applied = ShutdownOptionsSchema.parse(captured[0] ?? {});
    expect(applied.gracePeriodMs).toBe(30_000);
    expect(applied.forceTimeoutMs).toBe(5_000);
  });

  test('a force budget is never rounded to an impossible zero', () => {
    // `0` is a meaningful grace budget ("no grace") and an impossible force one:
    // the server runs `withTimeout(forceStop(), forceTimeoutMs)`, so zero gives
    // the forced stop a single macrotask and then fails it with "did not
    // complete within 0ms". Flooring a sub-millisecond remainder would
    // manufacture exactly that.
    const captured: ShutdownOptions[] = [];
    // A whole handle, not a cast: the adapter only calls `shutdown`, but writing
    // the shape out means a change to it is a compile error here rather than a
    // silently unexercised double.
    const counts = {
      acceptedRequests: 0,
      completedRequests: 0,
      pendingRequests: 0,
      pendingWebSockets: 0,
      pendingRequestsAtForce: 0,
      pendingWebSocketsAtForce: 0,
      abortedRequests: 0,
      forcedWebSockets: 0,
      durationMs: 0,
    };
    const server: ManagedServerHandle<undefined> = {
      url: 'http://127.0.0.1:0',
      port: 0,
      runtime: undefined,
      status: { state: 'running', ...counts },
      shutdown: (options?: ShutdownOptions) => {
        captured.push(options ?? {});
        return Promise.resolve({ outcome: 'clean', ...counts });
      },
    };
    const resource = managedServerResource({ id: 'fake', server });
    const startedAt = 1_000.25;
    resource.force?.({
      applicationId: 'x',
      signal: new AbortController().signal,
      now: () => startedAt,
      // 0.4 ms left: floored it becomes an impossible budget, rounded up a
      // usable one.
      forceDeadlineAt: startedAt + 0.4,
      reportHealth: () => undefined,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.forceTimeoutMs).toBe(1);
    expect(Number.isInteger(captured[0]?.gracePeriodMs)).toBe(true);
  });
});
