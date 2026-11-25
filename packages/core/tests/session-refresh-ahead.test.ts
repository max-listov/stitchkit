import { describe, expect, test } from 'bun:test';
import { ApiError } from '../src/browser/api-error';
import { createSessionScope, SessionExpiredError } from '../src/browser/session';
import { createSessionCredentials } from '../src/browser/session-credentials';
import {
  type SessionClock,
  type SessionCredentialsEvent,
  SessionRefreshRejectedError,
} from '../src/browser/session-refresh-policy';
import { MAX_TIMER_MS } from '../src/internal/timers';

interface Creds {
  readonly token: string;
  readonly expiresAt: number | null;
}

function createFakeClock(initialWall = 0, initialMono = 0) {
  let wall = initialWall;
  let mono = initialMono;
  let nextId = 0;
  const timers = new Map<number, { at: number; delay: number; run: () => void }>();
  const scheduledDelays: number[] = [];

  const clock: SessionClock = {
    now: () => wall,
    monotonic: () => mono,
    schedule(run, delayMs) {
      const id = nextId++;
      scheduledDelays.push(delayMs);
      timers.set(id, { at: mono + delayMs, delay: delayMs, run });
      return {
        cancel() {
          timers.delete(id);
        },
      };
    },
  };

  const flushMicrotasks = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  const advance = async (ms: number) => {
    const target = mono + ms;
    while (true) {
      let next: { id: number; at: number; run: () => void } | undefined;
      for (const [id, timer] of timers) {
        if (timer.at <= target && (!next || timer.at < next.at)) {
          next = { id, at: timer.at, run: timer.run };
        }
      }
      if (!next) break;
      const delta = next.at - mono;
      mono = next.at;
      wall += delta;
      timers.delete(next.id);
      next.run();
      await flushMicrotasks();
    }
    const remainder = target - mono;
    mono = target;
    wall += remainder;
    await flushMicrotasks();
  };

  return {
    clock,
    advance,
    flushMicrotasks,
    shiftWall(deltaMs: number) {
      wall += deltaMs;
    },
    shiftMonotonic(deltaMs: number) {
      mono += deltaMs;
    },
    liveCount: () => timers.size,
    pendingDelays: () => [...timers.values()].map((timer) => timer.at - mono),
    scheduledDelays,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('session proactive refresh and storage recovery', () => {
  test('proactive refresh fires once at exp minus lead and not 1 ms earlier', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    const events: SessionCredentialsEvent<string>[] = [];
    let refreshes = 0;
    let stored: { session: string; credentials: Creds } | null = null;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      onEvent: (event) => events.push(event),
      refresh: async () => {
        refreshes += 1;
        return { token: `tok-${refreshes}`, expiresAt: 10_000_000 };
      },
      storage: {
        read: async () => stored,
        write: async (session, credentials) => {
          stored = { session, credentials };
        },
        clear: async () => {
          stored = null;
        },
      },
    });

    const op = await auth.login('A', { token: 'tok-0', expiresAt: 600_000 });
    expect(fake.liveCount()).toBe(1);
    await fake.advance(540_000 - 1);
    expect(refreshes).toBe(0);
    await fake.advance(1);
    expect(refreshes).toBe(1);
    expect(auth.read(op).token).toBe('tok-1');
    expect(events.map((e) => e.type)).toEqual(['refreshed']);
    await fake.advance(1_000_000);
    expect(refreshes).toBe(1);
    await auth.logout();
    expect(fake.liveCount()).toBe(0);
  });

  test('a token whose expiry exceeds MAX_TIMER_MS waits in bounded timer steps', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    let refreshes = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      refresh: async () => {
        refreshes += 1;
        return { token: 'tok-next', expiresAt: null };
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    const extra = 1_000_000;
    await auth.login('A', { token: 'tok-long', expiresAt: MAX_TIMER_MS + extra });
    expect(fake.pendingDelays()).toEqual([MAX_TIMER_MS]);
    await fake.advance(MAX_TIMER_MS);
    expect(refreshes).toBe(0);
    expect(fake.pendingDelays()).toEqual([extra - 60_000]);
    await fake.advance(extra - 60_000 - 1);
    expect(refreshes).toBe(0);
    await fake.advance(1);
    expect(refreshes).toBe(1);
    expect(fake.liveCount()).toBe(0);
  });

  test('a token shorter than leadMs refreshes at half its lifetime, and the cooldown never outlasts that half', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    let refreshes = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: {
        expiresAt: (creds) => creds.expiresAt,
        leadMs: 60_000,
        cooldownMs: 30_000,
      },
      refresh: async () => {
        refreshes += 1;
        return { token: `tok-${refreshes}`, expiresAt: fake.clock.now() + 20_000 };
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    await auth.login('A', { token: 'tok-0', expiresAt: 20_000 });
    await fake.advance(9_999);
    expect(refreshes).toBe(0);
    await fake.advance(1);
    expect(refreshes).toBe(1);
    // The second token, received at 10 s, expires at 30 s. A full 30 s cooldown would refresh
    // it at 40 s, ten seconds after it stopped working; half its life is the longer pause allowed.
    await fake.advance(9_999);
    expect(refreshes).toBe(1);
    await fake.advance(1);
    expect(refreshes).toBe(2);
    // Every later token is refreshed before the one in use expires.
    await fake.advance(10_000);
    expect(refreshes).toBe(3);
    await auth.logout();
  });

  test('an already-expired token triggers one immediate refresh and subsequent refreshes wait cooldownMs', async () => {
    const fake = createFakeClock(100_000, 0);
    const scope = createSessionScope<string>();
    let refreshes = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: {
        expiresAt: (creds) => creds.expiresAt,
        leadMs: 60_000,
        cooldownMs: 30_000,
      },
      refresh: async () => {
        refreshes += 1;
        return { token: `expired-${refreshes}`, expiresAt: fake.clock.now() - 10_000 };
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    await auth.login('A', { token: 'expired-0', expiresAt: 50_000 });
    expect(fake.pendingDelays()).toEqual([0]);
    await fake.advance(0);
    expect(refreshes).toBe(1);
    await fake.advance(29_999);
    expect(refreshes).toBe(1);
    await fake.advance(1);
    expect(refreshes).toBe(2);
    await auth.logout();
  });

  test('shifting the wall clock backward does not delay cooldown-gated refresh', async () => {
    const fake = createFakeClock(1_000_000, 0);
    const scope = createSessionScope<string>();
    let refreshes = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: {
        expiresAt: (creds) => creds.expiresAt,
        leadMs: 60_000,
        cooldownMs: 30_000,
      },
      refresh: async () => {
        refreshes += 1;
        if (refreshes === 1) {
          // Wall clock jumps back by one full day while refresh runs.
          fake.shiftWall(-86_400_000);
        }
        return { token: `tok-${refreshes}`, expiresAt: fake.clock.now() - 5_000 };
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    await auth.login('A', { token: 'tok-0', expiresAt: 900_000 });
    await fake.advance(0);
    expect(refreshes).toBe(1);
    // Cooldown is measured on monotonic time, so 30 s still triggers the next refresh.
    await fake.advance(29_999);
    expect(refreshes).toBe(1);
    await fake.advance(1);
    expect(refreshes).toBe(2);
    await auth.logout();
  });

  test('refreshIfDue refreshes an overdue token after a missed timer and ignores a fresh or cooled-down token', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    let refreshes = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: {
        expiresAt: (creds) => creds.expiresAt,
        leadMs: 60_000,
        cooldownMs: 30_000,
      },
      refresh: async () => {
        refreshes += 1;
        return {
          token: `tok-${refreshes}`,
          expiresAt: refreshes === 1 ? fake.clock.now() - 1_000 : fake.clock.now() + 600_000,
        };
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    const op = await auth.login('A', { token: 'tok-0', expiresAt: 600_000 });
    expect(await auth.refreshIfDue(op)).toBeUndefined();
    expect(refreshes).toBe(0);

    // Simulate device sleep: wall clock jumped past expiry without timers firing.
    fake.shiftWall(600_000);
    const first = await auth.refreshIfDue(op);
    expect(first?.token).toBe('tok-1');
    expect(refreshes).toBe(1);

    // Token is still expired, but cooldown has not passed yet.
    expect(await auth.refreshIfDue(op)).toBeUndefined();
    expect(refreshes).toBe(1);
    await auth.logout();
  });

  test('a token without expiresAt never refreshes proactively or on wakeup', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    let refreshes = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      refresh: async () => {
        refreshes += 1;
        return { token: 'tok-new', expiresAt: null };
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    const op = await auth.login('A', { token: 'opaque', expiresAt: null });
    expect(fake.liveCount()).toBe(0);
    await fake.advance(10_000_000);
    expect(refreshes).toBe(0);
    expect(await auth.refreshIfDue(op)).toBeUndefined();
    expect(refreshes).toBe(0);
  });

  test('timer-triggered and manual refresh share one flight per generation', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    const gate = deferred<Creds>();
    let refreshes = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      refresh: () => {
        refreshes += 1;
        return gate.promise;
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    const op = await auth.login('A', { token: 'tok-0', expiresAt: 120_000 });
    await fake.advance(60_000);
    expect(refreshes).toBe(1);
    const manual = auth.refresh(op);
    gate.resolve({ token: 'tok-1', expiresAt: 1_000_000 });
    expect((await manual).token).toBe('tok-1');
    expect(refreshes).toBe(1);
    await auth.logout();
  });

  test('refresh with already-replaced rejected credentials returns current credentials without rotating', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    let refreshes = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      refresh: async () => {
        refreshes += 1;
        return { token: `tok-${refreshes}`, expiresAt: 1_000_000 };
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    const initial: Creds = { token: 'tok-0', expiresAt: 120_000 };
    const op = await auth.login('A', initial);
    const renewed = await auth.refresh(op);
    expect(refreshes).toBe(1);
    // Late 401 arrived for the already-replaced token: returns current without rotating again.
    expect(await auth.refresh(op, { rejected: initial })).toBe(renewed);
    expect(refreshes).toBe(1);
    // Rejecting the current token still rotates.
    const next = await auth.refresh(op, { rejected: renewed });
    expect(next.token).toBe('tok-2');
    expect(refreshes).toBe(2);
    await auth.logout();
  });

  test('logout, a new login and scope.stop leave zero live timers and emit no events', async () => {
    for (const end of ['logout', 'relogin', 'stop'] as const) {
      const fake = createFakeClock(0, 0);
      const scope = createSessionScope<string>();
      const events: SessionCredentialsEvent<string>[] = [];
      let refreshes = 0;
      const auth = createSessionCredentials<string, Creds>({
        scope,
        clock: fake.clock,
        refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
        onEvent: (event) => events.push(event),
        refresh: async () => {
          refreshes += 1;
          return { token: `tok-${refreshes}`, expiresAt: 1_000_000 };
        },
        storage: {
          read: async () => null,
          write: async () => undefined,
          clear: async () => undefined,
        },
      });

      await auth.login('A', { token: 'tok-0', expiresAt: 600_000 });
      expect(fake.liveCount()).toBe(1);
      if (end === 'logout') {
        await auth.logout();
        expect(fake.liveCount()).toBe(0);
      } else if (end === 'relogin') {
        await auth.login('B', { token: 'tok-b', expiresAt: null });
        expect(fake.liveCount()).toBe(0);
      } else {
        scope.stop();
        expect(fake.liveCount()).toBe(0);
      }
      await fake.advance(1_000_000);
      expect(refreshes).toBe(0);
      expect(events).toEqual([]);
    }
  });

  test('a timer callback does not re-arm once scope no longer owns the operation', async () => {
    let invalidateOnNextRead = false;
    const base = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    const clock: SessionClock = {
      now() {
        if (invalidateOnNextRead) {
          invalidateOnNextRead = false;
          scope.clear();
        }
        return base.clock.now();
      },
      monotonic: base.clock.monotonic,
      schedule: base.clock.schedule,
    };
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      refresh: async () => ({ token: 'tok-next', expiresAt: null }),
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    await auth.login('A', { token: 'tok-long', expiresAt: MAX_TIMER_MS + 1_000_000 });
    expect(base.liveCount()).toBe(1);
    invalidateOnNextRead = true;
    await base.advance(MAX_TIMER_MS);
    expect(base.liveCount()).toBe(0);
  });

  test('a rejected refresh stops proactive refresh, emits refresh-rejected and leaves scope and storage intact', async () => {
    for (const status of [401, 403] as const) {
      const fake = createFakeClock(0, 0);
      const scope = createSessionScope<string>();
      const events: SessionCredentialsEvent<string>[] = [];
      let clears = 0;
      const cause = new ApiError('TOKEN_REVOKED', { status });
      const auth = createSessionCredentials<string, Creds>({
        scope,
        clock: fake.clock,
        refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
        onEvent: (event) => events.push(event),
        refresh: async () => {
          throw cause;
        },
        storage: {
          read: async () => null,
          write: async () => undefined,
          clear: async () => {
            clears += 1;
          },
        },
      });

      const op = await auth.login('A', { token: 'tok-0', expiresAt: 120_000 });
      let caught: unknown;
      try {
        await auth.refresh(op);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionRefreshRejectedError);
      if (!(caught instanceof SessionRefreshRejectedError)) {
        throw new Error('Expected SessionRefreshRejectedError');
      }
      expect(caught.cause).toBe(cause);
      expect(clears).toBe(0);
      expect(scope.owns(op)).toBe(true);
      expect(auth.read(op).token).toBe('tok-0');
      expect(fake.liveCount()).toBe(0);
      expect(events).toEqual([{ type: 'refresh-rejected', operation: op, error: cause }]);
      // Wakeup does not restart proactive refresh once rejected for this generation.
      fake.shiftWall(200_000);
      expect(await auth.refreshIfDue(op)).toBeUndefined();
    }
  });

  test('a custom classifyRefreshFailure overrides the default classifier and never sees SessionExpiredError', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    const classified: unknown[] = [];
    const events: SessionCredentialsEvent<string>[] = [];
    const gate = deferred<Creds>();
    let step = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      classifyRefreshFailure: (error) => {
        classified.push(error);
        return error instanceof Error && error.message === 'CUSTOM_REVOKED'
          ? 'rejected'
          : 'unavailable';
      },
      onEvent: (event) => events.push(event),
      refresh: () => {
        step += 1;
        if (step === 1) return Promise.reject(new ApiError('FORBIDDEN', { status: 403 }));
        if (step === 2) return Promise.reject(new Error('CUSTOM_REVOKED'));
        return gate.promise;
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    const op1 = await auth.login('A', { token: 'tok-1', expiresAt: 600_000 });
    await expect(auth.refresh(op1)).rejects.toThrow('FORBIDDEN');
    expect(events.at(-1)?.type).toBe('refresh-unavailable');

    await expect(auth.refresh(op1)).rejects.toBeInstanceOf(SessionRefreshRejectedError);
    expect(events.at(-1)?.type).toBe('refresh-rejected');
    expect(classified).toHaveLength(2);

    const op2 = await auth.login('B', { token: 'tok-2', expiresAt: 600_000 });
    const pending = auth.refresh(op2).catch((error) => error);
    await auth.logout();
    gate.reject(new ApiError('UNAUTHORIZED', { status: 401 }));
    expect(await pending).toBeInstanceOf(SessionExpiredError);
    expect(classified).toHaveLength(2);
    expect(events).toHaveLength(2);
  });

  test('an unavailable refresh retries with configured backoff and keeps current credentials', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    const events: SessionCredentialsEvent<string>[] = [];
    let attempts = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      retry: { minDelayMs: 10_000, maxDelayMs: 40_000, jitter: 0 },
      onEvent: (event) => events.push(event),
      refresh: async () => {
        attempts += 1;
        if (attempts < 3) throw new ApiError('UNAVAILABLE', { status: 503 });
        return { token: 'tok-recovered', expiresAt: 1_000_000 };
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    const op = await auth.login('A', { token: 'tok-0', expiresAt: 120_000 });
    await fake.advance(60_000);
    expect(attempts).toBe(1);
    expect(auth.read(op).token).toBe('tok-0');
    expect(fake.pendingDelays()).toEqual([10_000]);

    await fake.advance(10_000);
    expect(attempts).toBe(2);
    expect(fake.pendingDelays()).toEqual([20_000]);

    await fake.advance(20_000);
    expect(attempts).toBe(3);
    expect(auth.read(op).token).toBe('tok-recovered');
    expect(events.map((event) => event.type)).toEqual([
      'refresh-unavailable',
      'refresh-unavailable',
      'refreshed',
    ]);
    await auth.logout();
  });

  test('a failed storage write after rotation resolves refresh, keeps new credentials and retries storage', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    const events: SessionCredentialsEvent<string>[] = [];
    let failWrites = 2;
    let stored: Creds | undefined;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      storageRetryMs: 4_000,
      onEvent: (event) => events.push(event),
      refresh: async () => ({ token: 'tok-rotated', expiresAt: null }),
      storage: {
        read: async () => (stored ? { session: 'A', credentials: stored } : null),
        write: async (_, value) => {
          if (stored !== undefined && failWrites > 0) {
            failWrites -= 1;
            throw new Error('keychain busy');
          }
          stored = value;
        },
        clear: async () => {
          stored = undefined;
        },
      },
    });

    const op = await auth.login('A', { token: 'tok-0', expiresAt: null });
    const rotated = await auth.refresh(op);
    expect(rotated.token).toBe('tok-rotated');
    expect(auth.read(op).token).toBe('tok-rotated');
    expect(stored?.token).toBe('tok-0');
    expect(fake.pendingDelays()).toEqual([4_000]);

    await fake.advance(4_000);
    expect(stored?.token).toBe('tok-0');
    expect(fake.pendingDelays()).toEqual([4_000]);

    await fake.advance(4_000);
    expect(stored?.token).toBe('tok-rotated');
    expect(fake.liveCount()).toBe(0);
    expect(events.filter((e) => e.type === 'storage-failed')).toHaveLength(2);
  });

  test('a rotation is never repeated while the previous rotation is still unstored', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    let failStorage = false;
    let refreshes = 0;
    let stored: Creds | undefined;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      storageRetryMs: 5_000,
      refresh: async () => {
        refreshes += 1;
        return { token: `tok-${refreshes}`, expiresAt: null };
      },
      storage: {
        read: async () => (stored ? { session: 'A', credentials: stored } : null),
        write: async (_, value) => {
          if (failStorage) throw new Error('disk full');
          stored = value;
        },
        clear: async () => {
          stored = undefined;
        },
      },
    });

    const op = await auth.login('A', { token: 'tok-0', expiresAt: null });
    failStorage = true;
    expect((await auth.refresh(op)).token).toBe('tok-1');
    expect(refreshes).toBe(1);

    // Next refresh must flush first; flush fails, so config.refresh is NOT called a second time.
    await expect(auth.refresh(op)).rejects.toThrow('disk full');
    expect(refreshes).toBe(1);
    expect(auth.read(op).token).toBe('tok-1');

    // Once storage recovers, flush persists tok-1 and the next rotation can proceed.
    failStorage = false;
    expect((await auth.refresh(op)).token).toBe('tok-2');
    expect(refreshes).toBe(2);
    expect(stored?.token).toBe('tok-2');
  });

  test('a flush and storage retry timer failing together leave a single retry pause', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    let loggedIn = false;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      storageRetryMs: 5_000,
      refresh: async () => ({ token: 'tok-1', expiresAt: null }),
      storage: {
        read: async () => null,
        write: async () => {
          if (!loggedIn) {
            loggedIn = true;
            return;
          }
          const gate = deferred<void>();
          gates.push(gate);
          return gate.promise;
        },
        clear: async () => undefined,
      },
    });

    const op = await auth.login('A', { token: 'tok-0', expiresAt: null });
    const initialRefresh = auth.refresh(op);
    await fake.flushMicrotasks();
    gates[0]?.reject(new Error('write-1 failed'));
    await initialRefresh;
    expect(fake.liveCount()).toBe(1);

    // Fire the storage retry timer so retry write #1 is in flight, then start a refresh flush.
    await fake.advance(5_000);
    const flushRefresh = auth.refresh(op).catch((error) => error);
    await fake.flushMicrotasks();
    gates[1]?.reject(new Error('timer write failed'));
    await fake.flushMicrotasks();
    gates[2]?.reject(new Error('flush write failed'));
    expect(await flushRefresh).toBeInstanceOf(Error);
    expect(fake.liveCount()).toBe(1);
    await auth.logout();
  });

  test('a deferred storage retry does not land after logout or a new login', async () => {
    for (const action of ['logout', 'relogin'] as const) {
      const fake = createFakeClock(0, 0);
      const scope = createSessionScope<string>();
      const writes: Array<{ session: string; token: string }> = [];
      let failOnce = false;
      const auth = createSessionCredentials<string, Creds>({
        scope,
        clock: fake.clock,
        storageRetryMs: 5_000,
        refresh: async () => ({ token: 'tok-old-rotated', expiresAt: null }),
        storage: {
          read: async () => null,
          write: async (session, value) => {
            if (failOnce) {
              failOnce = false;
              throw new Error('transient');
            }
            writes.push({ session, token: value.token });
          },
          clear: async () => undefined,
        },
      });

      const op = await auth.login('A', { token: 'tok-a', expiresAt: null });
      failOnce = true;
      await auth.refresh(op);
      expect(fake.liveCount()).toBe(1);
      if (action === 'logout') await auth.logout();
      else await auth.login('B', { token: 'tok-b', expiresAt: null });
      expect(fake.liveCount()).toBe(0);
      await fake.advance(10_000);
      expect(writes.some((entry) => entry.token === 'tok-old-rotated')).toBe(false);
    }
  });

  test('a newer rotation replaces a pending deferred write', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    let failFirst = true;
    let failSecond = true;
    let stored: Creds | undefined;
    let seq = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      storageRetryMs: 5_000,
      refresh: async () => {
        seq += 1;
        return { token: `rot-${seq}`, expiresAt: null };
      },
      storage: {
        read: async () => null,
        write: async (_, value) => {
          if (value.token === 'init') {
            stored = value;
            return;
          }
          if (value.token === 'rot-1' && failFirst) {
            failFirst = false;
            throw new Error('busy-1');
          }
          if (value.token === 'rot-2' && failSecond) {
            failSecond = false;
            throw new Error('busy-2');
          }
          stored = value;
        },
        clear: async () => {
          stored = undefined;
        },
      },
    });
    const op = await auth.login('A', { token: 'init', expiresAt: null });
    await auth.refresh(op);
    expect(stored?.token).toBe('init');
    expect(fake.liveCount()).toBe(1);
    // Second refresh flushes rot-1, rotates to rot-2, and rot-2's write fails and takes over the retry slot.
    await auth.refresh(op);
    expect(stored?.token).toBe('rot-1');
    expect(fake.liveCount()).toBe(1);
    await fake.advance(5_000);
    expect(stored?.token).toBe('rot-2');
    expect(fake.liveCount()).toBe(0);
    await auth.logout();
    expect(fake.liveCount()).toBe(0);
  });

  test('restore handles unreadable without clearing storage or scope, absent without changes, and present by arming refresh', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    let storageClearCalls = 0;
    let storageWriteCalls = 0;
    let refreshes = 0;
    let mode: 'unreadable' | 'absent' | 'present-fresh' | 'present-due' = 'unreadable';
    const readError = new Error('keychain locked');

    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      refresh: async () => {
        refreshes += 1;
        return { token: `refreshed-${refreshes}`, expiresAt: 10_000_000 };
      },
      storage: {
        read: async () => {
          if (mode === 'unreadable') throw readError;
          if (mode === 'absent') return null;
          if (mode === 'present-fresh') {
            return {
              session: 'A',
              credentials: { token: 'restored-fresh', expiresAt: 600_000 },
            };
          }
          return { session: 'B', credentials: { token: 'restored-due', expiresAt: -1_000 } };
        },
        write: async () => {
          storageWriteCalls += 1;
        },
        clear: async () => {
          storageClearCalls += 1;
        },
      },
    });

    // Establish an active generation first to prove unreadable does not call scope.clear() either.
    const existing = scope.replace('existing');
    const unreadable = await auth.restore();
    expect(unreadable).toEqual({ status: 'unreadable', error: readError });
    expect(storageClearCalls).toBe(0);
    expect(scope.owns(existing)).toBe(true);
    expect(fake.liveCount()).toBe(0);

    mode = 'absent';
    const absent = await auth.restore();
    expect(absent).toEqual({ status: 'absent' });
    expect(storageClearCalls).toBe(0);
    expect(scope.owns(existing)).toBe(true);

    mode = 'present-fresh';
    const fresh = await auth.restore();
    expect(fresh.status).toBe('present');
    if (fresh.status !== 'present') throw new Error('expected present');
    expect(auth.read(fresh.operation).token).toBe('restored-fresh');
    expect(storageWriteCalls).toBe(0);
    expect(fake.pendingDelays()).toEqual([540_000]);

    mode = 'present-due';
    const due = await auth.restore();
    expect(due.status).toBe('present');
    if (due.status !== 'present') throw new Error('expected present');
    expect(storageWriteCalls).toBe(0);
    expect(fake.pendingDelays()).toEqual([0]);
    await fake.advance(0);
    expect(refreshes).toBe(1);
    expect(auth.read(due.operation).token).toBe('refreshed-1');
    await auth.logout();
  });

  test('logout, scope.stop and refreshTimeoutMs during a pending flush leave zero unhandled rejections and zero live timers', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const end of ['logout', 'stop'] as const) {
        const fake = createFakeClock(0, 0);
        const scope = createSessionScope<string>();
        const flushGate = deferred<void>();
        let writeCount = 0;
        let refreshes = 0;
        const auth = createSessionCredentials<string, Creds>({
          scope,
          clock: fake.clock,
          refreshTimeoutMs: 50,
          storageRetryMs: 5_000,
          refresh: async () => {
            refreshes += 1;
            return { token: `tok-${refreshes}`, expiresAt: null };
          },
          storage: {
            read: async () => null,
            write: async () => {
              writeCount += 1;
              if (writeCount === 2) throw new Error('write failed');
              if (writeCount === 3) return flushGate.promise;
            },
            clear: async () => undefined,
          },
        });

        const op = await auth.login('A', { token: 'tok-0', expiresAt: null });
        await auth.refresh(op);
        expect(refreshes).toBe(1);

        const second = auth.refresh(op).catch((error) => error);
        await fake.flushMicrotasks();
        if (end === 'logout') {
          const logoutDone = auth.logout();
          expect(fake.liveCount()).toBe(1); // only bounded storage write deadline
          flushGate.resolve();
          await logoutDone;
        } else {
          scope.stop();
          flushGate.resolve();
        }
        expect(await second).toBeInstanceOf(SessionExpiredError);
        await fake.flushMicrotasks();
        expect(refreshes).toBe(1);
        expect(fake.liveCount()).toBe(0);
      }

      // Slow flush taking longer than refreshTimeoutMs must not consume the refresh deadline budget.
      const fake = createFakeClock(0, 0);
      const scope = createSessionScope<string>();
      const flushGate = deferred<void>();
      let writeCount = 0;
      let refreshes = 0;
      let signalAbortedAtRefreshStart: boolean | undefined;
      const auth = createSessionCredentials<string, Creds>({
        scope,
        clock: fake.clock,
        refreshTimeoutMs: 20,
        storageTimeoutMs: 500,
        storageRetryMs: 5_000,
        refresh: async (_, signal) => {
          refreshes += 1;
          signalAbortedAtRefreshStart = signal.aborted;
          return { token: `tok-${refreshes}`, expiresAt: null };
        },
        storage: {
          read: async () => null,
          write: async () => {
            writeCount += 1;
            if (writeCount === 2) throw new Error('transient');
            if (writeCount === 3) return flushGate.promise;
          },
          clear: async () => undefined,
        },
      });

      const op = await auth.login('A', { token: 'tok-0', expiresAt: null });
      await auth.refresh(op);
      const second = auth.refresh(op);
      await fake.flushMicrotasks();
      // Advance past refreshTimeoutMs (20 ms) while flush is still pending.
      await fake.advance(50);
      expect(refreshes).toBe(1);
      flushGate.resolve();
      const rotated = await second;
      expect(rotated.token).toBe('tok-2');
      expect(signalAbortedAtRefreshStart).toBe(false);
      expect(refreshes).toBe(2);
      expect(fake.liveCount()).toBe(0);
      await auth.logout();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('restore arms immediate refresh and marks refreshIfDue as due when restored token is within leadMs', async () => {
    const fake = createFakeClock(100_000, 0);
    const scope = createSessionScope<string>();
    let refreshes = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      refresh: async () => {
        refreshes += 1;
        return { token: `refreshed-${refreshes}`, expiresAt: fake.clock.now() + 600_000 };
      },
      storage: {
        read: async () => ({
          session: 'A',
          credentials: { token: 'restored-near', expiresAt: 130_000 },
        }),
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    const restored = await auth.restore();
    expect(restored.status).toBe('present');
    if (restored.status !== 'present') throw new Error('expected present');
    // expiresAt - now = 30_000 <= leadMs (60_000): immediate refresh, NOT half-life 15_000.
    expect(fake.pendingDelays()).toEqual([0]);
    const refreshed = await auth.refreshIfDue(restored.operation);
    expect(refreshed?.token).toBe('refreshed-1');
    expect(refreshes).toBe(1);
    await auth.logout();
    expect(fake.liveCount()).toBe(0);
  });

  test('restore serializes behind logout and rejects stale reads racing with logout, login or scope.stop', async () => {
    // 1. restore() queued behind an in-flight logout clear sees the cleared store (absent).
    {
      const fake = createFakeClock(0, 0);
      const scope = createSessionScope<string>();
      const clearGate = deferred<void>();
      let stored: { session: string; credentials: Creds } | null = null;
      const auth = createSessionCredentials<string, Creds>({
        scope,
        clock: fake.clock,
        refresh: async () => ({ token: 'tok', expiresAt: null }),
        storage: {
          read: async () => stored,
          write: async (session, credentials) => {
            stored = { session, credentials };
          },
          clear: async () => {
            await clearGate.promise;
            stored = null;
          },
        },
      });
      await auth.login('A', { token: 'tok-a', expiresAt: null });
      const loggingOut = auth.logout();
      const restoring = auth.restore();
      clearGate.resolve();
      await loggingOut;
      expect(await restoring).toEqual({ status: 'absent' });
    }

    // 2. restore() racing with logout, login or scope.stop while storage.read() is in flight rejects with SessionExpiredError.
    for (const race of ['logout', 'login', 'stop'] as const) {
      const fake = createFakeClock(0, 0);
      const scope = createSessionScope<string>();
      const readGate = deferred<{ session: string; credentials: Creds } | null>();
      const auth = createSessionCredentials<string, Creds>({
        scope,
        clock: fake.clock,
        refresh: async () => ({ token: 'tok', expiresAt: null }),
        storage: {
          read: () => readGate.promise,
          write: async () => undefined,
          clear: async () => undefined,
        },
      });
      const restoring = auth.restore().catch((error) => error);
      await fake.flushMicrotasks();
      let secondOp: ReturnType<typeof scope.capture> | undefined;
      if (race === 'logout') {
        const done = auth.logout();
        readGate.resolve({ session: 'stale', credentials: { token: 'old', expiresAt: null } });
        await done;
      } else if (race === 'login') {
        const done = auth.login('B', { token: 'fresh', expiresAt: null });
        readGate.resolve({ session: 'stale', credentials: { token: 'old', expiresAt: null } });
        secondOp = await done;
      } else {
        scope.stop();
        readGate.resolve({ session: 'stale', credentials: { token: 'old', expiresAt: null } });
      }
      expect(await restoring).toBeInstanceOf(SessionExpiredError);
      if (secondOp) {
        expect(scope.owns(secondOp)).toBe(true);
        expect(auth.read(secondOp).token).toBe('fresh');
      }
    }
  });

  test('a throwing onEvent never breaks refresh transitions, timers or error contracts', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    const seenEvents: string[] = [];
    let step = 0;
    let failWrite = false;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: { expiresAt: (creds) => creds.expiresAt, leadMs: 60_000 },
      retry: { minDelayMs: 10_000, maxDelayMs: 40_000, jitter: 0 },
      storageRetryMs: 5_000,
      onEvent: (event) => {
        seenEvents.push(event.type);
        throw new Error(`observer boom on ${event.type}`);
      },
      refresh: async () => {
        step += 1;
        if (step === 1) return { token: 'tok-1', expiresAt: 600_000 };
        if (step === 2) throw new ApiError('UNAVAILABLE', { status: 503 });
        throw new ApiError('REVOKED', { status: 401 });
      },
      storage: {
        read: async () => null,
        write: async () => {
          if (failWrite) throw new Error('disk full');
        },
        clear: async () => undefined,
      },
    });

    const op = await auth.login('A', { token: 'tok-0', expiresAt: 600_000 });
    failWrite = true;
    const rotated = await auth.refresh(op);
    expect(rotated.token).toBe('tok-1');
    expect(seenEvents).toEqual(['storage-failed', 'refreshed']);
    // Both proactive refresh timer and storage retry timer were armed despite throwing observer.
    expect(fake.liveCount()).toBe(2);

    // Recover storage so next refresh reaches config.refresh and fails with 503.
    failWrite = false;
    await expect(auth.refresh(op)).rejects.toThrow('UNAVAILABLE');
    expect(seenEvents).toEqual(['storage-failed', 'refreshed', 'refresh-unavailable']);
    expect(fake.pendingDelays()).toEqual([10_000]);

    // Next refresh fails with 401 -> SessionRefreshRejectedError (not observer error), 0 timers.
    await expect(auth.refresh(op)).rejects.toBeInstanceOf(SessionRefreshRejectedError);
    expect(seenEvents).toEqual([
      'storage-failed',
      'refreshed',
      'refresh-unavailable',
      'refresh-rejected',
    ]);
    expect(fake.liveCount()).toBe(0);
    await auth.logout();
  });

  test('late-settling writes reconcile across same-credentials relogin, direct scope.clear and rewrite failures', async () => {
    // 1. Two sessions with identical credentials: late write from session A rewrites session B.
    {
      const fake = createFakeClock(0, 0);
      const scope = createSessionScope<string>();
      const slowGate = deferred<void>();
      let stored: { session: string; token: string } | null = null;
      let holdNext = false;
      const auth = createSessionCredentials<string, Creds>({
        scope,
        clock: fake.clock,
        storageTimeoutMs: 20,
        refresh: async () => ({ token: 'same-token', expiresAt: null }),
        storage: {
          read: async () => null,
          write: async (session, credentials) => {
            if (holdNext) {
              holdNext = false;
              await slowGate.promise;
            }
            stored = { session, token: credentials.token };
          },
          clear: async () => {
            stored = null;
          },
        },
      });
      const shared: Creds = { token: 'same-token', expiresAt: null };
      const readStored = () => stored;
      const opA = await auth.login('A', shared);
      holdNext = true;
      const refreshA = auth.refresh(opA);
      await fake.flushMicrotasks();
      await fake.advance(20);
      await refreshA;
      await auth.login('B', shared);
      expect(readStored()).toEqual({ session: 'B', token: 'same-token' });
      // Session A's late write overwrites stored with 'A', then reconciliation rewrites 'B'.
      slowGate.resolve();
      await fake.flushMicrotasks();
      expect(readStored()).toEqual({ session: 'B', token: 'same-token' });
    }

    // 2. Direct scope.clear() causes late write reconciliation to clear storage.
    {
      const fake = createFakeClock(0, 0);
      const scope = createSessionScope<string>();
      const slowGate = deferred<void>();
      let stored: string | undefined;
      let holdNext = false;
      const auth = createSessionCredentials<string, Creds>({
        scope,
        clock: fake.clock,
        storageTimeoutMs: 20,
        refresh: async () => ({ token: 'tok-1', expiresAt: null }),
        storage: {
          read: async () => null,
          write: async (_, credentials) => {
            if (holdNext) {
              holdNext = false;
              await slowGate.promise;
            }
            stored = credentials.token;
          },
          clear: async () => {
            stored = undefined;
          },
        },
      });
      const op = await auth.login('A', { token: 'tok-0', expiresAt: null });
      holdNext = true;
      const r = auth.refresh(op);
      await fake.flushMicrotasks();
      await fake.advance(20);
      await r;
      scope.clear();
      slowGate.resolve();
      await fake.flushMicrotasks();
      expect(stored).toBeUndefined();
    }

    // 3. Failing late reconciliation rewrite marks unstored and arms storage retry.
    {
      const fake = createFakeClock(0, 0);
      const scope = createSessionScope<string>();
      const slowGate = deferred<void>();
      const events: SessionCredentialsEvent<string>[] = [];
      let stored: string | undefined;
      let writeIndex = 0;
      let seq = 0;
      const auth = createSessionCredentials<string, Creds>({
        scope,
        clock: fake.clock,
        storageTimeoutMs: 20,
        storageRetryMs: 5_000,
        onEvent: (event) => events.push(event),
        refresh: async () => {
          seq += 1;
          return { token: `tok-${seq}`, expiresAt: null };
        },
        storage: {
          read: async () => null,
          write: async (_, credentials) => {
            writeIndex += 1;
            if (writeIndex === 2) {
              await slowGate.promise;
              stored = credentials.token;
              return;
            }
            if (writeIndex === 5) throw new Error('reconcile failed');
            stored = credentials.token;
          },
          clear: async () => {
            stored = undefined;
          },
        },
      });
      const op = await auth.login('A', { token: 'tok-0', expiresAt: null });
      const first = auth.refresh(op); // write #2 hangs -> times out at 20 ms
      await fake.flushMicrotasks();
      await fake.advance(20);
      await first;
      // Refresh #2 flushes tok-1 (write #3) and writes tok-2 (write #4).
      await auth.refresh(op);
      expect(stored).toBe('tok-2');
      // Now write #2 lands late with tok-1 -> triggers rewriteStored() (write #5) which fails!
      slowGate.resolve();
      await fake.flushMicrotasks();
      expect(stored).toBe('tok-1');
      expect(events.filter((e) => e.type === 'storage-failed')).toHaveLength(2);
      expect(fake.pendingDelays()).toEqual([5_000]);
      // Storage retry (write #6) succeeds and converges back to tok-2!
      await fake.advance(5_000);
      expect(stored).toBe('tok-2');
      expect(fake.liveCount()).toBe(0);
      await auth.logout();
    }
  });

  test('refresh with rejected newly-rotated credentials during a slow post-rotation write waits and rotates again', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    const writeGate = deferred<void>();
    let refreshes = 0;
    let holdFirstRotationWrite = true;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      storageTimeoutMs: 5_000,
      refresh: async () => {
        refreshes += 1;
        return { token: `tok-${refreshes}`, expiresAt: null };
      },
      storage: {
        read: async () => null,
        write: async (_, credentials) => {
          if (credentials.token === 'tok-1' && holdFirstRotationWrite) {
            holdFirstRotationWrite = false;
            await writeGate.promise;
          }
        },
        clear: async () => undefined,
      },
    });

    const op = await auth.login('A', { token: 'tok-0', expiresAt: null });
    const firstFlight = auth.refresh(op);
    await fake.flushMicrotasks();
    // Memory already holds tok-1 while tok-1 is still being written to storage.
    const rotated = auth.read(op);
    expect(rotated.token).toBe('tok-1');

    // A caller rejects tok-1 during the slow write: must wait and rotate to tok-2, not return tok-1.
    const secondCall = auth.refresh(op, { rejected: rotated });
    writeGate.resolve();
    expect((await firstFlight).token).toBe('tok-1');
    expect((await secondCall).token).toBe('tok-2');
    expect(refreshes).toBe(2);
    await auth.logout();
  });

  test('refreshIfDue honours the short-token cooldown cap on wakeup', async () => {
    const fake = createFakeClock(0, 0);
    const scope = createSessionScope<string>();
    let refreshes = 0;
    const auth = createSessionCredentials<string, Creds>({
      scope,
      clock: fake.clock,
      refreshAhead: {
        expiresAt: (creds) => creds.expiresAt,
        leadMs: 60_000,
        cooldownMs: 30_000,
      },
      refresh: async () => {
        refreshes += 1;
        return { token: `short-${refreshes}`, expiresAt: fake.clock.now() + 20_000 };
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    const op = await auth.login('A', { token: 'short-0', expiresAt: 20_000 });
    // First refresh at t=10s produces short-1 expiring at t=30s (half-life = 10s < 30s cooldownMs)
    await fake.advance(10_000);
    expect(refreshes).toBe(1);
    // Simulate missed timer wakeup at t=20s (wall + monotonic advanced 10s without firing timers)
    fake.shiftWall(10_000);
    fake.shiftMonotonic(10_000);
    const refreshed = await auth.refreshIfDue(op);
    expect(refreshed?.token).toBe('short-2');
    expect(refreshes).toBe(2);
    await auth.logout();
  });
});
