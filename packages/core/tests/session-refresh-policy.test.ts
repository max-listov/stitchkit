import { describe, expect, test } from 'bun:test';
import { ApiError } from '../src/browser/api-error';
import { createSessionScope } from '../src/browser/session';
import { createSessionCredentials } from '../src/browser/session-credentials';
import {
  DEFAULT_REFRESH_LEAD_MS,
  DEFAULT_REFRESH_RETRY_POLICY,
  DEFAULT_REFRESH_TIMEOUT_MS,
  DEFAULT_STORAGE_RETRY_MS,
  defaultClassifyRefreshFailure,
  refreshDelayMs,
  refreshDue,
} from '../src/browser/session-refresh-policy';
import { runWithRefreshDeadline } from '../src/browser/session-refresh-timer';
import { AppError } from '../src/contract/errors';

describe('session refresh policy', () => {
  test('refreshDelayMs starts at exp minus lead and never earlier than 0', () => {
    expect(refreshDelayMs(15 * 60_000, 0, 0)).toBe(14 * 60_000);
    expect(refreshDelayMs(1_000_000, 0, 0)).toBe(1_000_000 - DEFAULT_REFRESH_LEAD_MS);
    expect(refreshDelayMs(1_000_000, 0, 939_999)).toBe(1);
    expect(refreshDelayMs(1_000_000, 0, 940_000)).toBe(0);
    expect(refreshDelayMs(1_000_000, 0, 990_000)).toBe(0);
    expect(refreshDelayMs(1_000_000, 0, 2_000_000)).toBe(0);
  });

  test('refreshDelayMs caps lead at half the token lifetime when a token is shorter than leadMs', () => {
    expect(refreshDelayMs(20_000, 0, 0, 60_000)).toBe(10_000);
    expect(refreshDelayMs(20_000, 0, 9_999, 60_000)).toBe(1);
    expect(refreshDelayMs(20_000, 0, 10_000, 60_000)).toBe(0);
    expect(refreshDelayMs(110_000, 100_000, 100_000, 60_000)).toBe(5_000);
  });

  test('refreshDelayMs returns 0 immediately for an already-expired token or restored token within leadMs', () => {
    expect(refreshDelayMs(50_000, 100_000, 100_000, 60_000)).toBe(0);
    expect(refreshDelayMs(100_000, 100_000, 100_000, 60_000)).toBe(0);
    expect(refreshDelayMs(30_000, undefined, 0, 60_000)).toBe(0);
    expect(refreshDelayMs(90_000, undefined, 0, 60_000)).toBe(30_000);
  });

  test('refreshDue returns false when expiresAt is null or non-finite, and true at or inside lead', () => {
    const now = 1_000_000;
    expect(refreshDue(null, now)).toBe(false);
    expect(refreshDue(Number.NaN, now)).toBe(false);
    expect(refreshDue(Number.POSITIVE_INFINITY, now)).toBe(false);
    expect(refreshDue(now + 10 * 60_000, now)).toBe(false);
    expect(refreshDue(now + DEFAULT_REFRESH_LEAD_MS + 1, now)).toBe(false);
    expect(refreshDue(now + DEFAULT_REFRESH_LEAD_MS, now)).toBe(true);
    expect(refreshDue(now + 30_000, now)).toBe(true);
    expect(refreshDue(now - 1, now)).toBe(true);
    expect(refreshDue(now + 20_000, now, 60_000, now)).toBe(false);
    expect(refreshDue(now + 20_000, now + 10_000, 60_000, now)).toBe(true);
  });

  test('defaultClassifyRefreshFailure classifies 401 and 403 as rejected and every other failure as unavailable', () => {
    expect(defaultClassifyRefreshFailure({ status: 401 })).toBe('rejected');
    expect(defaultClassifyRefreshFailure({ status: 403 })).toBe('rejected');
    expect(defaultClassifyRefreshFailure(new ApiError('UNAUTHORIZED', { status: 401 }))).toBe(
      'rejected',
    );
    expect(defaultClassifyRefreshFailure(new ApiError('FORBIDDEN', { status: 403 }))).toBe(
      'rejected',
    );
    expect(defaultClassifyRefreshFailure(new AppError('UNAUTHORIZED', { status: 401 }))).toBe(
      'rejected',
    );
    expect(defaultClassifyRefreshFailure(new AppError('FORBIDDEN', { status: 403 }))).toBe(
      'rejected',
    );

    for (const status of [0, 400, 404, 408, 429, 500, 502, 503]) {
      expect(defaultClassifyRefreshFailure({ status })).toBe('unavailable');
      expect(defaultClassifyRefreshFailure(new ApiError('ERR', { status }))).toBe(
        'unavailable',
      );
    }

    expect(defaultClassifyRefreshFailure(new Error('no status'))).toBe('unavailable');
    expect(defaultClassifyRefreshFailure(new TypeError('network down'))).toBe('unavailable');
    expect(
      defaultClassifyRefreshFailure(new DOMException('Refresh timed out', 'TimeoutError')),
    ).toBe('unavailable');
    expect(defaultClassifyRefreshFailure(null)).toBe('unavailable');
    expect(defaultClassifyRefreshFailure(undefined)).toBe('unavailable');
    expect(defaultClassifyRefreshFailure({ status: '401' })).toBe('unavailable');
  });

  test('default refresh timeout, first retry pause and storage retry stay inside a 120 s replay window', () => {
    // Representative default budget — actual replay windows are a server property
    // and callers with tighter server windows override refreshTimeoutMs, retry and storageRetryMs.
    const representativeReplayWindowMs = 120_000;
    expect(DEFAULT_REFRESH_TIMEOUT_MS + DEFAULT_REFRESH_RETRY_POLICY.minDelayMs).toBeLessThan(
      representativeReplayWindowMs,
    );
    expect(DEFAULT_STORAGE_RETRY_MS).toBeLessThan(representativeReplayWindowMs);
  });

  test('option validation rejects out-of-range refreshAhead and storageRetryMs with RangeError naming the option', () => {
    const base = () => ({
      scope: createSessionScope<string>(),
      refresh: async () => 'tok',
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });

    expect(() =>
      createSessionCredentials({
        ...base(),
        refreshAhead: { expiresAt: () => 1000, leadMs: 0 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      createSessionCredentials({
        ...base(),
        refreshAhead: { expiresAt: () => 1000, leadMs: 0 },
      }),
    ).toThrow('leadMs');

    expect(() =>
      createSessionCredentials({
        ...base(),
        refreshAhead: { expiresAt: () => 1000, cooldownMs: -1 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      createSessionCredentials({
        ...base(),
        refreshAhead: { expiresAt: () => 1000, cooldownMs: -1 },
      }),
    ).toThrow('cooldownMs');

    expect(() =>
      createSessionCredentials({
        ...base(),
        storageRetryMs: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createSessionCredentials({
        ...base(),
        storageRetryMs: 0,
      }),
    ).toThrow('storageRetryMs');
  });
});

test('a refresh deadline holds no listener on the session operation once the exchange settles', async () => {
  const operation = createSessionScope<string>().replace('session');
  let attached = 0;
  const add = operation.signal.addEventListener.bind(operation.signal);
  const remove = operation.signal.removeEventListener.bind(operation.signal);
  operation.signal.addEventListener = (type: string, ...rest: [never, never?]) => {
    if (type === 'abort') attached += 1;
    add(type, ...rest);
  };
  operation.signal.removeEventListener = (type: string, ...rest: [never, never?]) => {
    if (type === 'abort') attached -= 1;
    remove(type, ...rest);
  };
  const scheduled: Array<() => void> = [];
  const clock = {
    now: () => 0,
    monotonic: () => 0,
    schedule: (run: () => void) => {
      scheduled.push(run);
      return { cancel: () => undefined };
    },
  };
  for (let refresh = 0; refresh < 3; refresh += 1) {
    await expect(
      runWithRefreshDeadline(operation, clock, 1_000, async () => 'token'),
    ).resolves.toBe('token');
  }
  expect(attached).toBe(0);
  const hung = runWithRefreshDeadline(
    operation,
    clock,
    1_000,
    () => new Promise<never>(() => undefined),
  );
  scheduled.at(-1)?.();
  await expect(hung).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(attached).toBe(0);
});
