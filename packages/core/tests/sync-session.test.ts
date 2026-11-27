/**
 * The cursor sync session, pinned by the cases a consuming offline-first app
 * already ships: the same scenarios, on the neutral request and page header.
 */
import { describe, expect, test } from 'bun:test';
import {
  createSyncSession,
  type SyncSessionPorts,
  type SyncSnapshotResume,
} from '../src/entrypoints/sync';
import type { SyncPageHeader, SyncPageRequest } from '../src/sync/protocol';

interface Timer {
  run: () => void;
  delay: number;
  cancelled: boolean;
}

/** A saved progress as an event: `progress:5` incremental, `progress:5@100` or `token:t@100` in a snapshot. */
const progressEvent = (progress: number | SyncSnapshotResume): string =>
  typeof progress === 'number'
    ? `progress:${progress}`
    : 'token' in progress
      ? `token:${progress.token}@${progress.from}`
      : `progress:${progress.after}@${progress.from}`;

function harness(
  input: {
    cursor?: SyncSessionPorts<SyncPageHeader>['readCursor'];
    apply?: SyncSessionPorts<SyncPageHeader>['apply'];
    send?: (request: SyncPageRequest) => void;
    saveCursor?: SyncSessionPorts<SyncPageHeader>['saveCursor'];
    progress?: boolean;
    begin?: SyncSessionPorts<SyncPageHeader>['beginFullSync'];
    saveProgress?: SyncSessionPorts<SyncPageHeader>['saveProgress'];
    deadlineMs?: number;
    now?: () => number;
    retry?: SyncSessionPorts<SyncPageHeader>['retry'];
    rebase?: (snapshot: string) => void | Promise<void>;
  } = {},
) {
  const sent: SyncPageRequest[] = [];
  const timers: Timer[] = [];
  const events: string[] = [];
  const logged: string[] = [];
  const state = { connected: true };
  let ids = 0;
  const session = createSyncSession({
    isConnected: () => state.connected,
    readCursor: input.cursor ?? (() => 3),
    beginFullSync: () => {
      events.push('begin');
      return input.begin?.();
    },
    send: input.send ?? ((request) => sent.push(request)),
    ...(input.progress
      ? {
          saveProgress: (progress: number | SyncSnapshotResume) => {
            events.push(progressEvent(progress));
            return input.saveProgress?.(progress);
          },
        }
      : {}),
    ...(input.rebase
      ? {
          rebasePending: (snapshot: string) => {
            events.push('rebase');
            return input.rebase?.(snapshot);
          },
        }
      : {}),
    apply: input.apply ?? (() => undefined),
    saveCursor:
      input.saveCursor ??
      ((version) => {
        events.push(`cursor:${version}`);
      }),
    log: {
      info: (m) => logged.push(m),
      warn: (m) => logged.push(m),
      error: (m) => logged.push(m),
    },
    schedule: (run, delay) => {
      // A timer that fired waits no longer: it cannot run twice.
      const timer: Timer = {
        run: () => {
          timer.cancelled = true;
          run();
        },
        delay,
        cancelled: false,
      };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    newId: () => `id-${++ids}`,
    now: input.now ?? (() => 1_000),
    ...(input.deadlineMs !== undefined && { deadlineMs: input.deadlineMs }),
    ...(input.retry !== undefined && { retry: input.retry }),
  });
  const live = () => timers.filter((timer) => !timer.cancelled);
  return { session, sent, timers, live, events, logged, state };
}

function page(request: SyncPageRequest, patch: Partial<SyncPageHeader> = {}): SyncPageHeader {
  return {
    sessionId: request.sessionId,
    requestId: request.requestId,
    hasMore: false,
    latestVersion: 7,
    ...patch,
  };
}

/** The request at `index` (negative from the end); a missing one fails the test. */
const at = (sent: SyncPageRequest[], index: number): SyncPageRequest => {
  const request = sent.at(index);
  if (!request) throw new Error(`no request at ${index}`);
  return request;
};

const first = (sent: SyncPageRequest[]) => {
  const request = sent[0];
  if (!request) throw new Error('no request was sent');
  return request;
};

describe('sync session', () => {
  test('with synchronous ports a step is finished before the call returns', () => {
    const h = harness({ cursor: () => 5 });
    h.session.requestSync();
    expect(h.sent).toHaveLength(1);
    h.session.handleResponse(page(first(h.sent), { latestVersion: 8 }));
    expect(h.events).toEqual(['cursor:8']);
    expect(h.session.diagnostics().mode).toBeNull();
  });

  test('a saved cursor starts an incremental session, no cursor starts a full one', async () => {
    for (const cursor of [0, 3, 12]) {
      const a = harness({ cursor: () => cursor });
      await a.session.requestSync();
      expect(first(a.sent)).toMatchObject({ after: cursor, full: false });
      expect(a.events).toEqual([]);
    }
    const b = harness({ cursor: () => null });
    await b.session.requestSync();
    expect(first(b.sent)).toMatchObject({ after: null, full: true });
    expect(b.events).toEqual(['begin']);
  });

  test('nothing starts while the transport is down', async () => {
    const h = harness();
    h.state.connected = false;
    await h.session.requestSync();
    await h.session.requestFullSync();
    expect(h.sent).toHaveLength(0);
  });

  test('an invalid stored number fails the cursor read before sending a page', async () => {
    for (const cursor of [-1, NaN, Infinity, 0.25, Number.MAX_SAFE_INTEGER + 1]) {
      const h = harness({ cursor: () => cursor });
      await h.session.requestSync();
      expect(h.sent).toEqual([]);
      expect(h.session.diagnostics().lastFailure?.reason).toBe('cursor_unavailable');
      h.session.stop();
    }
  });

  test('pages follow the continuation cursor with fresh request ids, the cursor is saved on the last', async () => {
    const h = harness({ cursor: () => null });
    await h.session.requestSync();
    const one = first(h.sent);
    await h.session.handleResponse(page(one, { hasMore: true, nextCursor: 5, full: true }));
    const two = at(h.sent, 1);
    expect(two).toMatchObject({ after: 5, sessionId: one.sessionId });
    expect(two?.requestId).not.toBe(one.requestId);
    expect(h.events).toEqual(['begin']);
    await h.session.handleResponse(page(two, { latestVersion: 7, full: true }));
    expect(h.events).toEqual(['begin', 'cursor:7']);
    expect(h.live()).toHaveLength(0);
    expect(h.session.diagnostics().mode).toBeNull();
  });

  // A divergence from the consuming app, which saved the last page's version: its
  // full pages list live rows only, so a row deleted after it was paged was lost.
  test('a snapshot that grew while it ran saves where it began and catches up from there', async () => {
    let saved: number | null = null;
    const h = harness({
      cursor: () => saved,
      saveCursor: (version) => {
        saved = version ?? saved;
        h.events.push(`cursor:${version}`);
      },
    });
    await h.session.requestSync();
    const one = first(h.sent);
    await h.session.handleResponse(
      page(one, { hasMore: true, nextCursor: 5, latestVersion: 7, full: true }),
    );
    const two = at(h.sent, 1);
    await h.session.handleResponse(page(two, { latestVersion: 9, full: true }));
    expect(h.events).toEqual(['begin', 'cursor:7']);
    const catchUp = h.sent[2];
    expect(catchUp).toMatchObject({ after: 7, full: false });
    await h.session.handleResponse(page(at(h.sent, 2), { latestVersion: 9 }));
    expect(h.events).toEqual(['begin', 'cursor:7', 'cursor:9']);
    expect(h.sent).toHaveLength(3);
  });

  test('a duplicate or foreign response is ignored', async () => {
    let applies = 0;
    const h = harness({
      apply: () => {
        applies += 1;
      },
    });
    await h.session.requestSync();
    const one = first(h.sent);
    await h.session.handleResponse(page(one, { sessionId: 'other' }));
    expect(applies).toBe(0);
    await h.session.handleResponse(page(one));
    await h.session.handleResponse(page(one));
    expect(applies).toBe(1);
  });

  test('a continuation cursor that is missing or does not advance fails, it does not loop the page', async () => {
    const h = harness({ cursor: () => 3 });
    await h.session.requestSync();
    await h.session.handleResponse(
      page(first(h.sent), { hasMore: true, nextCursor: undefined }),
    );
    expect(h.sent).toHaveLength(1);
    expect(h.session.diagnostics().lastFailure).toMatchObject({ reason: 'apply_failed' });
    const stuck = harness({ cursor: () => 3 });
    await stuck.session.requestSync();
    await stuck.session.handleResponse(
      page(first(stuck.sent), { hasMore: true, nextCursor: 3 }),
    );
    expect(stuck.sent).toHaveLength(1);
  });

  test('requests that arrive mid-session coalesce into one follow-up, a full one wins', async () => {
    const h = harness({ cursor: () => null });
    await h.session.requestSync();
    const one = first(h.sent);
    await h.session.requestSync();
    await h.session.requestFullSync();
    await h.session.requestSync();
    expect(h.sent).toHaveLength(1);
    await h.session.handleResponse(page(one, { full: true }));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.sessionId).not.toBe(one.sessionId);
    expect(h.sent[1]?.full).toBe(true);
  });

  test('two full-sync requests in a row open one session, the second waits for it', async () => {
    const h = harness({ cursor: () => null });
    h.session.requestFullSync();
    h.session.requestFullSync();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toHaveLength(1);
    expect(h.events.filter((event) => event === 'begin')).toHaveLength(1);
  });

  test('a version announced mid-session is caught up by the next session', async () => {
    const h = harness({ cursor: () => 4 });
    await h.session.requestSync();
    await h.session.requestSync();
    expect(h.sent).toHaveLength(1);
    await h.session.handleResponse(page(first(h.sent)));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.full).toBe(false);
  });

  test('an apply failure resets a full session and retries after a growing pause', async () => {
    let fail = true;
    const h = harness({
      cursor: () => null,
      apply: () => {
        if (fail) throw new Error('synthetic apply failure');
      },
    });
    await h.session.requestSync();
    await h.session.handleResponse(page(first(h.sent), { full: true }));
    expect(h.live().map((timer) => timer.delay)).toEqual([2_000]);
    expect(h.events.filter((event) => event === 'begin')).toHaveLength(2);
    // The next attempt: the pause grew.
    h.live()[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    const retry = at(h.sent, -1);
    expect(retry.full).toBe(true);
    await h.session.handleResponse(page(retry, { full: true }));
    expect(h.live().map((timer) => timer.delay)).toEqual([4_000]);
    fail = false;
    h.live()[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    await h.session.handleResponse(page(at(h.sent, -1), { full: true }));
    expect(h.session.diagnostics().lastFailure).toBeNull();
  });

  test('the pause stops growing at the ceiling', async () => {
    const h = harness({
      apply: () => {
        throw new Error('always');
      },
    });
    for (let i = 0; i < 8; i += 1) {
      await h.session.requestSync();
      await h.session.handleResponse(page(at(h.sent, -1)));
      h.live()[0]?.run();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(Math.max(...h.timers.map((timer) => timer.delay))).toBe(60_000);
  });

  test('the app’s own deadline, retry policy, clock and log replace the defaults', async () => {
    let clock = 1_000;
    const h = harness({
      deadlineMs: 5_000,
      retry: { minDelayMs: 100, maxDelayMs: 150, jitter: 0 },
      now: () => clock,
    });
    await h.session.requestSync();
    expect(h.live().map((timer) => timer.delay)).toEqual([5_000]);
    clock = 1_250;
    expect(h.session.diagnostics().ageMs).toBe(250);
    h.live()[0]?.run();
    expect(JSON.parse(h.logged.at(-1) ?? '{}')).toMatchObject({
      event: 'sync.retry',
      reason: 'deadline',
      ageMs: 250,
      delayMs: 100,
    });
    expect(h.live().map((timer) => timer.delay)).toEqual([100]);
    h.live()[0]?.run();
    await Promise.resolve();
    h.live()[0]?.run();
    expect(h.live().map((timer) => timer.delay)).toEqual([150]);
    expect(h.session.diagnostics().lastFailure?.reason).toBe('deadline');
  });

  test('a lost page of a full sync after progress is asked for again, not restarted from zero', async () => {
    const h = harness({ cursor: () => null });
    await h.session.requestSync();
    const one = first(h.sent);
    await h.session.handleResponse(page(one, { hasMore: true, nextCursor: 5, full: true }));
    const lost = at(h.sent, 1);
    const deadline = h.live().find((timer) => timer.delay === 30_000);
    expect(deadline).toBeDefined();
    deadline?.run();
    expect(h.events.filter((event) => event === 'begin')).toHaveLength(1);
    h.live()[0]?.run();
    const again = at(h.sent, 2);
    expect(again).toMatchObject({ after: 5, sessionId: lost.sessionId });
    expect(again.requestId).not.toBe(lost.requestId);
  });

  test('with a progress port each applied page saves the next cursor before it is requested', async () => {
    const h = harness({ cursor: () => null, progress: true });
    await h.session.requestSync();
    await h.session.handleResponse(
      page(first(h.sent), { hasMore: true, nextCursor: 5, full: true }),
    );
    await h.session.handleResponse(
      page(at(h.sent, 1), {
        hasMore: true,
        nextCursor: 9,
        full: true,
      }),
    );
    expect(h.events).toEqual(['begin', 'progress:5@7', 'progress:9@7']);
    expect(h.sent.map((request) => request.after)).toEqual([null, 5, 9]);
  });

  test('a disconnect after progress resumes the full snapshot from the saved cursor, not from zero', async () => {
    const h = harness({ cursor: () => null, progress: true });
    await h.session.requestSync();
    await h.session.handleResponse(
      page(first(h.sent), { hasMore: true, nextCursor: 5, full: true }),
    );
    h.session.onDisconnect();
    await h.session.onReconnect();
    expect(h.sent.at(-1)).toMatchObject({ after: 5, full: true });
    expect(h.events.filter((event) => event === 'begin')).toHaveLength(1);
  });

  test('a resumed snapshot catches up from where the snapshot began, not from where it was cut', async () => {
    // The snapshot began at version 100. A row changed while it ran, so the pages reached
    // version 102 before the connection dropped. A row the first page delivered was deleted
    // meanwhile at version 101: full pages never carry deletions, so only a catch-up that
    // starts at 100 brings that tombstone. Catching up from 102 would keep the row forever.
    const h = harness({ cursor: () => null, progress: true });
    await h.session.requestSync();
    await h.session.handleResponse(
      page(first(h.sent), { hasMore: true, nextCursor: 102, latestVersion: 100, full: true }),
    );
    h.session.onDisconnect();
    await h.session.onReconnect();
    expect(h.sent.at(-1)).toMatchObject({ after: 102, full: true });
    await h.session.handleResponse(
      page(at(h.sent, -1), { hasMore: false, latestVersion: 110, full: true }),
    );
    expect(h.events).toContain('cursor:100');
    expect(h.events).not.toContain('cursor:102');
  });

  test('an apply failure after progress resumes at the failing page; a failure of the first page starts over', async () => {
    let fail = false;
    const h = harness({
      cursor: () => null,
      progress: true,
      apply: () => {
        if (fail) throw new Error('synthetic apply failure');
      },
    });
    await h.session.requestSync();
    await h.session.handleResponse(
      page(first(h.sent), { hasMore: true, nextCursor: 5, full: true }),
    );
    fail = true;
    await h.session.handleResponse(page(at(h.sent, 1), { latestVersion: 9, full: true }));
    fail = false;
    h.live()[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent.at(-1)).toMatchObject({ after: 5, full: true });
    expect(h.events.filter((event) => event === 'begin')).toHaveLength(1);

    const fresh = harness({
      cursor: () => null,
      progress: true,
      apply: () => {
        throw new Error('synthetic apply failure');
      },
    });
    await fresh.session.requestSync();
    await fresh.session.handleResponse(
      page(first(fresh.sent), { full: true, hasMore: true, nextCursor: 5 }),
    );
    expect(fresh.events.filter((event) => event === 'begin')).toHaveLength(2);
  });

  test('a lost first page starts the session over', async () => {
    const h = harness({ cursor: () => 3 });
    await h.session.requestSync();
    h.live()
      .find((timer) => timer.delay === 30_000)
      ?.run();
    h.live()[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.sessionId).not.toBe(h.sent[0]?.sessionId);
  });

  test('a send that throws is a transport failure with its own pause', async () => {
    let calls = 0;
    const h = harness({
      send: () => {
        calls += 1;
        throw new Error('socket closed');
      },
    });
    await h.session.requestSync();
    expect(calls).toBe(1);
    expect(h.session.diagnostics().lastFailure).toMatchObject({ reason: 'send_failed' });
    expect(h.live()[0]?.delay).toBe(2_000);
  });

  test('a server sync_error recovers the matching request only', async () => {
    const h = harness();
    await h.session.requestSync();
    const one = first(h.sent);
    h.session.handleError({ sessionId: 'x', requestId: one.requestId, code: 'nope' });
    expect(h.session.diagnostics().lastFailure).toBeNull();
    h.session.handleError({
      sessionId: one.sessionId,
      requestId: one.requestId,
      code: 'SYNC_DENIED',
    });
    expect(h.session.diagnostics().lastFailure).toMatchObject({ reason: 'SYNC_DENIED' });
  });

  test('a disconnect drops the session; the interrupted full sync comes back as full', async () => {
    const h = harness({ cursor: () => null });
    await h.session.requestSync();
    h.session.onDisconnect();
    expect(h.session.diagnostics().mode).toBeNull();
    expect(h.live()).toHaveLength(0);
    await h.session.onReconnect();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.full).toBe(true);
  });

  test('stopping during the cursor read cannot send a page or schedule anything', async () => {
    const pending = Promise.withResolvers<number | null>();
    const h = harness({ cursor: () => pending.promise });
    const started = h.session.requestSync();
    h.session.stop();
    pending.resolve(42);
    await started;
    expect(h.sent).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
  });

  test('stopping an interrupted full sync does not begin another snapshot on the ports of a closed account', async () => {
    const h = harness({ cursor: () => null });
    await h.session.requestSync();
    expect(h.events).toEqual(['begin']);
    h.session.stop();
    expect(h.events).toEqual(['begin']);
    expect(h.session.diagnostics().mode).toBeNull();
  });

  test('a failing cursor read owns a retry and stopping suppresses it', async () => {
    const h = harness({
      cursor: () => {
        throw new Error('settings unavailable');
      },
    });
    await h.session.requestSync();
    expect(h.sent).toHaveLength(0);
    expect(h.live()[0]?.delay).toBe(2_000);
    h.session.stop();
    h.timers[0]?.run();
    expect(h.sent).toHaveLength(0);
  });

  test('stopping during apply cannot continue pagination or schedule a recovery', async () => {
    const pending = Promise.withResolvers<void>();
    let permitted: (() => boolean) | undefined;
    const h = harness({
      cursor: () => null,
      apply: async (_page, { current }) => {
        permitted = current;
        await pending.promise;
      },
    });
    await h.session.requestSync();
    const applying = h.session.handleResponse(
      page(first(h.sent), { hasMore: true, nextCursor: 5, full: true }),
    );
    h.session.stop();
    expect(permitted?.()).toBe(false);
    pending.resolve();
    await applying;
    expect(h.sent).toHaveLength(1);
    expect(h.live()).toHaveLength(0);
  });

  test('a disconnect during the last page’s apply saves no cursor for the dropped session', async () => {
    const pending = Promise.withResolvers<void>();
    const h = harness({
      cursor: () => 3,
      apply: async () => {
        await pending.promise;
      },
    });
    await h.session.requestSync();
    const applying = h.session.handleResponse(page(first(h.sent), { latestVersion: 9 }));
    h.session.onDisconnect();
    pending.resolve();
    await applying;
    expect(h.events.filter((event) => event.startsWith('cursor:'))).toEqual([]);
  });

  test('a full snapshot the server forces on an incremental session begins one and keeps it full', async () => {
    const h = harness({ cursor: () => 3 });
    await h.session.requestSync();
    const one = first(h.sent);
    expect(one).toMatchObject({ after: 3, full: false });
    await h.session.handleResponse(page(one, { full: true, hasMore: true, nextCursor: 4 }));
    expect(h.events).toEqual(['begin']);
    expect(h.session.diagnostics().mode).toBe('full');
    expect(h.sent[1]).toMatchObject({ after: 4, full: true });
  });

  test('a snapshot that cannot begin is retried as a full one after a pause', async () => {
    let refuse = true;
    const h = harness({
      begin: () => {
        if (refuse) throw new Error('disk is read-only');
      },
    });
    await h.session.requestFullSync();
    expect(h.session.diagnostics().lastFailure?.reason).toBe('begin_failed');
    expect(h.sent).toEqual([]);
    expect(h.live().map((timer) => timer.delay)).toEqual([2_000]);
    refuse = false;
    h.live()[0]?.run();
    expect(h.sent.at(-1)).toMatchObject({ after: null, full: true });
  });

  test('a success resets the pause, so the next failure waits the shortest again', async () => {
    let fail = true;
    const h = harness({
      apply: () => {
        if (fail) throw new Error('once');
      },
    });
    await h.session.requestSync();
    await h.session.handleResponse(page(first(h.sent)));
    expect(h.live().map((timer) => timer.delay)).toEqual([2_000]);
    fail = false;
    h.live()[0]?.run();
    await Promise.resolve();
    await h.session.handleResponse(page(at(h.sent, -1)));
    fail = true;
    await h.session.requestSync();
    await h.session.handleResponse(page(at(h.sent, -1)));
    expect(h.live().map((timer) => timer.delay)).toEqual([2_000]);
  });

  test('stopping while progress is saved asks for no further page', async () => {
    const saving = Promise.withResolvers<void>();
    const h = harness({
      cursor: () => null,
      progress: true,
      saveProgress: () => saving.promise,
    });
    await h.session.requestSync();
    const applying = h.session.handleResponse(
      page(first(h.sent), { full: true, hasMore: true, nextCursor: 5 }),
    );
    h.session.stop();
    saving.resolve();
    await applying;
    expect(h.sent).toHaveLength(1);
  });

  test('stopping while a snapshot begins sends no page', async () => {
    const beginning = Promise.withResolvers<void>();
    const h = harness({ cursor: () => null, begin: () => beginning.promise });
    const starting = h.session.requestSync();
    await Promise.resolve();
    h.session.stop();
    beginning.resolve();
    await starting;
    expect(h.sent).toEqual([]);
  });

  test('an explicit full snapshot starts from the beginning, not from an interrupted one', async () => {
    const h = harness({ cursor: () => null, progress: true });
    await h.session.requestSync();
    await h.session.handleResponse(
      page(first(h.sent), { full: true, hasMore: true, nextCursor: 5 }),
    );
    h.session.onDisconnect();
    await h.session.requestFullSync();
    expect(h.sent.at(-1)).toMatchObject({ after: null, full: true });
  });

  test('server promotion on page 1 resets the incremental cursor and pages through records below the old cursor', async () => {
    const applied: Array<number | null | undefined> = [];
    const h = harness({
      cursor: () => 50,
      progress: true,
      apply: (incoming) => {
        applied.push(incoming.nextCursor);
      },
    });
    await h.session.requestSync();
    const one = first(h.sent);
    expect(one).toMatchObject({ after: 50, full: false });

    await h.session.handleResponse(
      page(one, { full: true, hasMore: true, nextCursor: 10, latestVersion: 200 }),
    );
    expect(h.session.diagnostics().lastFailure).toBeNull();
    expect(h.session.diagnostics().mode).toBe('full');
    expect(h.events).toEqual(['begin', 'progress:10@200']);
    const two = at(h.sent, 1);
    expect(two).toMatchObject({ after: 10, full: true, sessionId: one.sessionId });

    await h.session.handleResponse(
      page(two, { full: true, hasMore: true, nextCursor: 50, latestVersion: 200 }),
    );
    const three = at(h.sent, 2);
    expect(three).toMatchObject({ after: 50, full: true, sessionId: one.sessionId });

    await h.session.handleResponse(
      page(three, { full: true, hasMore: false, nextCursor: null, latestVersion: 200 }),
    );
    expect(h.events).toEqual(['begin', 'progress:10@200', 'progress:50@200', 'cursor:200']);
    expect(applied).toEqual([10, 50, null]);
    expect(h.session.diagnostics().mode).toBeNull();
    expect(h.session.diagnostics().lastFailure).toBeNull();
  });

  test('a snapshot the server forces that cannot begin is a begin failure, retried as a full sync', async () => {
    let refuse = true;
    const h = harness({
      cursor: () => 3,
      begin: () => {
        if (refuse) throw new Error('disk is read-only');
      },
    });
    await h.session.requestSync();
    await h.session.handleResponse(
      page(first(h.sent), { full: true, hasMore: true, nextCursor: 4 }),
    );
    expect(h.session.diagnostics().lastFailure).toMatchObject({
      reason: 'begin_failed',
      message: 'disk is read-only',
    });
    refuse = false;
    h.live()[0]?.run();
    await Promise.resolve();
    expect(h.sent.at(-1)).toMatchObject({ after: null, full: true });
  });

  test('an incremental session with a progress port saves the next cursor of every page that has more', async () => {
    const h = harness({ cursor: () => 3, progress: true });
    await h.session.requestSync();
    await h.session.handleResponse(page(first(h.sent), { hasMore: true, nextCursor: 5 }));
    await h.session.handleResponse(page(at(h.sent, 1), { latestVersion: 9 }));
    expect(h.events).toEqual(['progress:5', 'cursor:9']);
  });

  test('server promotion on page 2 of an incremental session resets pageCursor, pagesApplied, and snapshotFrom', async () => {
    let saved: number | null = 50;
    const h = harness({
      cursor: () => saved,
      progress: true,
      saveCursor: (version) => {
        saved = version ?? saved;
        h.events.push(`cursor:${version}`);
      },
    });
    await h.session.requestSync();
    const incOne = first(h.sent);
    expect(incOne).toMatchObject({ after: 50, full: false });
    await h.session.handleResponse(
      page(incOne, { full: false, hasMore: true, nextCursor: 70, latestVersion: 200 }),
    );
    const incTwo = at(h.sent, 1);
    expect(incTwo).toMatchObject({ after: 70, full: false });

    await h.session.handleResponse(
      page(incTwo, { full: true, hasMore: true, nextCursor: 10, latestVersion: 250 }),
    );
    expect(h.session.diagnostics().lastFailure).toBeNull();
    expect(h.session.diagnostics().mode).toBe('full');
    expect(h.events).toEqual(['progress:70', 'begin', 'progress:10@250']);
    const fullTwo = at(h.sent, 2);
    expect(fullTwo).toMatchObject({ after: 10, full: true, sessionId: incOne.sessionId });

    await h.session.handleResponse(
      page(fullTwo, { full: true, hasMore: false, latestVersion: 260 }),
    );
    expect(h.events).toEqual(['progress:70', 'begin', 'progress:10@250', 'cursor:250']);
    const catchUp = at(h.sent, 3);
    expect(catchUp).toMatchObject({ after: 250, full: false });

    // If apply fails on a promoted page 2, reset must start a fresh full sync, not resume at 70.
    let failPromoted = false;
    const failed = harness({
      cursor: () => 50,
      progress: true,
      apply: () => {
        if (failPromoted) throw new Error('promoted apply failed');
      },
    });
    await failed.session.requestSync();
    await failed.session.handleResponse(
      page(first(failed.sent), {
        full: false,
        hasMore: true,
        nextCursor: 70,
        latestVersion: 200,
      }),
    );
    failPromoted = true;
    await failed.session.handleResponse(
      page(at(failed.sent, 1), {
        full: true,
        hasMore: true,
        nextCursor: 10,
        latestVersion: 250,
      }),
    );
    expect(failed.session.diagnostics().lastFailure).toMatchObject({
      reason: 'apply_failed',
      message: 'promoted apply failed',
    });
    failPromoted = false;
    failed.live()[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(failed.sent.at(-1)).toMatchObject({ after: null, full: true });
  });

  test('multi-page promoted full snapshot advances normally and rejects non-advancing cursors on page 2', async () => {
    const happy = harness({ cursor: () => 50, progress: true });
    await happy.session.requestSync();
    await happy.session.handleResponse(
      page(first(happy.sent), {
        full: true,
        hasMore: true,
        nextCursor: 10,
        latestVersion: 200,
      }),
    );
    await happy.session.handleResponse(
      page(at(happy.sent, 1), {
        full: true,
        hasMore: true,
        nextCursor: 30,
        latestVersion: 200,
      }),
    );
    await happy.session.handleResponse(
      page(at(happy.sent, 2), {
        full: true,
        hasMore: true,
        nextCursor: 60,
        latestVersion: 200,
      }),
    );
    await happy.session.handleResponse(
      page(at(happy.sent, 3), { full: true, hasMore: false, latestVersion: 200 }),
    );
    expect(happy.sent.map((r) => ({ after: r.after, full: r.full }))).toEqual([
      { after: 50, full: false },
      { after: 10, full: true },
      { after: 30, full: true },
      { after: 60, full: true },
    ]);
    expect(happy.events).toEqual([
      'begin',
      'progress:10@200',
      'progress:30@200',
      'progress:60@200',
      'cursor:200',
    ]);

    for (const staleNext of [10, 5]) {
      const h = harness({ cursor: () => 50, progress: true });
      await h.session.requestSync();
      await h.session.handleResponse(
        page(first(h.sent), { full: true, hasMore: true, nextCursor: 10, latestVersion: 200 }),
      );
      await h.session.handleResponse(
        page(at(h.sent, 1), {
          full: true,
          hasMore: true,
          nextCursor: staleNext,
          latestVersion: 200,
        }),
      );
      expect(h.session.diagnostics().lastFailure).toMatchObject({
        reason: 'apply_failed',
        message: 'Sync pagination cursor did not advance',
      });
      expect(h.sent).toHaveLength(2);
      expect(h.events).toEqual(['begin', 'progress:10@200']);
      h.live()[0]?.run();
      await Promise.resolve();
      await Promise.resolve();
      expect(h.sent.at(-1)).toMatchObject({ after: 10, full: true });
    }
  });

  test('promoted full snapshot accepts nextCursor: 0 on page 1 and rejects nextCursor: null without setting resumeCursor', async () => {
    const zero = harness({ cursor: () => 50, progress: true });
    await zero.session.requestSync();
    await zero.session.handleResponse(
      page(first(zero.sent), { full: true, hasMore: true, nextCursor: 0, latestVersion: 200 }),
    );
    expect(zero.session.diagnostics().lastFailure).toBeNull();
    expect(zero.events).toEqual(['begin', 'progress:0@200']);
    expect(at(zero.sent, 1)).toMatchObject({ after: 0, full: true });
    // Page 2 with nextCursor: 0 must not advance past pageCursor 0.
    await zero.session.handleResponse(
      page(at(zero.sent, 1), { full: true, hasMore: true, nextCursor: 0, latestVersion: 200 }),
    );
    expect(zero.session.diagnostics().lastFailure).toMatchObject({
      reason: 'apply_failed',
      message: 'Sync pagination cursor did not advance',
    });
    expect(zero.sent).toHaveLength(2);

    const zeroAdvances = harness({ cursor: () => 50, progress: true });
    await zeroAdvances.session.requestSync();
    await zeroAdvances.session.handleResponse(
      page(first(zeroAdvances.sent), {
        full: true,
        hasMore: true,
        nextCursor: 0,
        latestVersion: 200,
      }),
    );
    await zeroAdvances.session.handleResponse(
      page(at(zeroAdvances.sent, 1), {
        full: true,
        hasMore: false,
        latestVersion: 200,
      }),
    );
    expect(zeroAdvances.events).toEqual(['begin', 'progress:0@200', 'cursor:200']);
    expect(zeroAdvances.session.diagnostics().mode).toBeNull();

    const missing = harness({ cursor: () => 50, progress: true });
    await missing.session.requestSync();
    await missing.session.handleResponse(
      page(first(missing.sent), {
        full: true,
        hasMore: true,
        nextCursor: null,
        latestVersion: 200,
      }),
    );
    expect(missing.session.diagnostics().lastFailure).toMatchObject({
      reason: 'apply_failed',
      message: 'Sync pagination cursor did not advance',
    });
    expect(missing.events).toEqual(['begin', 'begin']);
    expect(missing.sent).toHaveLength(1);
    missing.live()[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(missing.sent.at(-1)).toMatchObject({ after: null, full: true });
  });

  test('saveProgress failure on page 1 or page 2 of a promoted full snapshot does not advance resumeCursor', async () => {
    let failPage1 = true;
    const p1 = harness({
      cursor: () => 50,
      progress: true,
      saveProgress: async () => {
        if (failPage1) throw new Error('progress failed on page 1');
      },
    });
    await p1.session.requestSync();
    await p1.session.handleResponse(
      page(first(p1.sent), { full: true, hasMore: true, nextCursor: 10, latestVersion: 200 }),
    );
    expect(p1.session.diagnostics().lastFailure).toMatchObject({
      reason: 'apply_failed',
      message: 'progress failed on page 1',
    });
    expect(p1.sent).toHaveLength(1);
    expect(p1.events.filter((event) => event === 'begin')).toHaveLength(2);
    failPage1 = false;
    p1.live()[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(p1.sent.at(-1)).toMatchObject({ after: null, full: true });

    let failPage2 = true;
    let savedPage2: number | null = 50;
    const p2 = harness({
      cursor: () => savedPage2,
      progress: true,
      saveProgress: async (progress) => {
        const cursor =
          typeof progress === 'object' && 'after' in progress ? progress.after : null;
        if (cursor === 30 && failPage2) throw new Error('progress failed on page 2');
      },
      saveCursor: (version) => {
        savedPage2 = version ?? savedPage2;
        p2.events.push(`cursor:${version}`);
      },
    });
    await p2.session.requestSync();
    await p2.session.handleResponse(
      page(first(p2.sent), { full: true, hasMore: true, nextCursor: 10, latestVersion: 200 }),
    );
    expect(at(p2.sent, 1)).toMatchObject({ after: 10, full: true });
    await p2.session.handleResponse(
      page(at(p2.sent, 1), { full: true, hasMore: true, nextCursor: 30, latestVersion: 200 }),
    );
    expect(p2.session.diagnostics().lastFailure).toMatchObject({
      reason: 'apply_failed',
      message: 'progress failed on page 2',
    });
    expect(p2.sent).toHaveLength(2);
    expect(p2.events.filter((event) => event === 'begin')).toHaveLength(1);
    failPage2 = false;
    p2.live()[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(p2.sent.at(-1)).toMatchObject({ after: 10, full: true });
    await p2.session.handleResponse(
      page(at(p2.sent, -1), { full: true, hasMore: true, nextCursor: 30, latestVersion: 200 }),
    );
    expect(p2.sent.at(-1)).toMatchObject({ after: 30, full: true });
    await p2.session.handleResponse(
      page(at(p2.sent, -1), { full: true, hasMore: false, latestVersion: 200 }),
    );
    expect(p2.events).toContain('cursor:10');
    expect(p2.sent.at(-1)).toMatchObject({ after: 10, full: false });
    await p2.session.handleResponse(
      page(at(p2.sent, -1), { hasMore: false, latestVersion: 200 }),
    );
    expect(p2.events.at(-1)).toBe('cursor:200');
    expect(p2.session.diagnostics().mode).toBeNull();
    expect(p2.session.diagnostics().lastFailure).toBeNull();
  });

  test('saveCursor failure on a single-page promoted or resumed final page does not increment pagesApplied before persistence', async () => {
    let failPromotedCursor = true;
    const promoted = harness({
      cursor: () => 50,
      progress: true,
      saveCursor: async (version) => {
        if (failPromotedCursor) throw new Error('cursor write failed');
        promoted.events.push(`cursor:${version}`);
      },
    });
    await promoted.session.requestSync();
    await promoted.session.handleResponse(
      page(first(promoted.sent), { full: true, hasMore: false, latestVersion: 200 }),
    );
    expect(promoted.session.diagnostics().lastFailure).toMatchObject({
      reason: 'apply_failed',
      message: 'cursor write failed',
    });
    expect(promoted.events.filter((event) => event === 'begin')).toHaveLength(2);
    failPromotedCursor = false;
    promoted.live()[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(promoted.sent.at(-1)).toMatchObject({ after: null, full: true });
    await promoted.session.handleResponse(
      page(at(promoted.sent, -1), { full: true, hasMore: false, latestVersion: 200 }),
    );
    expect(promoted.events.at(-1)).toBe('cursor:200');
    expect(promoted.session.diagnostics().mode).toBeNull();

    // Resumed final page: pageCursor is non-null (10), pagesApplied is 0; if saveCursor fails,
    // pagesApplied must stay 0 so reset does not silently treat the failing page as applied.
    let failResumedCursor = true;
    const resumed = harness({
      cursor: () => null,
      progress: true,
      saveCursor: async (version) => {
        if (failResumedCursor) throw new Error('resumed cursor write failed');
        resumed.events.push(`cursor:${version}`);
      },
    });
    await resumed.session.requestSync();
    await resumed.session.handleResponse(
      page(first(resumed.sent), {
        full: true,
        hasMore: true,
        nextCursor: 10,
        latestVersion: 200,
      }),
    );
    resumed.session.onDisconnect();
    await resumed.session.onReconnect();
    expect(resumed.sent.at(-1)).toMatchObject({ after: 10, full: true });
    await resumed.session.handleResponse(
      page(at(resumed.sent, -1), { full: true, hasMore: false, latestVersion: 200 }),
    );
    expect(resumed.session.diagnostics().lastFailure).toMatchObject({
      reason: 'apply_failed',
      message: 'resumed cursor write failed',
    });
    expect(resumed.events.filter((event) => event === 'begin')).toHaveLength(2);
    failResumedCursor = false;
    resumed.live()[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(resumed.sent.at(-1)).toMatchObject({ after: null, full: true });
  });
});

describe('a snapshot paged by token', () => {
  test('a stopped token snapshot saves version zero and the next session reads the feed from zero', async () => {
    const store: { cursor: number | SyncSnapshotResume | null } = { cursor: null };
    const open = () =>
      harness({
        cursor: () => store.cursor,
        progress: true,
        saveProgress(value) {
          store.cursor = value;
        },
        saveCursor(value) {
          if (value !== undefined) store.cursor = value;
        },
      });
    const firstRun = open();
    await firstRun.session.requestSync();
    const initial = first(firstRun.sent);
    expect(initial).toMatchObject({ full: true, after: null });
    await firstRun.session.handleResponse(
      page(initial, { hasMore: true, nextToken: 'next', latestVersion: 0 }),
    );
    expect(store.cursor).toMatchObject({ token: 'next', from: 0 });
    firstRun.session.stop();

    const resumed = open();
    await resumed.session.requestSync();
    const { sessionId, requestId, full, token } = first(resumed.sent);
    expect({ full, token }).toEqual({ full: true, token: 'next' });
    await resumed.session.handleResponse({ sessionId, requestId, hasMore: false });
    expect(store.cursor).toBe(0);
    resumed.session.stop();

    const reopened = open();
    await reopened.session.requestSync();
    expect(first(reopened.sent)).toMatchObject({ full: false, after: 0 });
    expect(reopened.events).toEqual([]);
    reopened.session.stop();
  });

  test('pages follow the token, each saved with the version the snapshot began at', async () => {
    const h = harness({ cursor: () => null, progress: true });
    await h.session.requestSync();
    expect(first(h.sent)).toMatchObject({ after: null, token: null, full: true });
    await h.session.handleResponse(
      page(first(h.sent), { hasMore: true, nextToken: 'records:r9', latestVersion: 100 }),
    );
    expect(at(h.sent, -1)).toMatchObject({ after: null, token: 'records:r9', full: true });
    await h.session.handleResponse(
      page(at(h.sent, -1), { hasMore: true, nextToken: 'blocks:b4', latestVersion: 100 }),
    );
    await h.session.handleResponse(page(at(h.sent, -1), { latestVersion: 100 }));
    expect(h.events).toEqual([
      'begin',
      'token:records:r9@100',
      'token:blocks:b4@100',
      'cursor:100',
    ]);
    expect(h.session.diagnostics().mode).toBeNull();
  });

  test('a token that does not change fails, it does not loop the page', async () => {
    const h = harness({ cursor: () => null, progress: true });
    await h.session.requestSync();
    await h.session.handleResponse(page(first(h.sent), { hasMore: true, nextToken: 't1' }));
    await h.session.handleResponse(page(at(h.sent, -1), { hasMore: true, nextToken: 't1' }));
    expect(h.session.diagnostics().lastFailure).toMatchObject({
      reason: 'apply_failed',
      message: 'Sync pagination token did not advance',
    });
  });

  test('a token outside a full snapshot is refused', async () => {
    const h = harness({ cursor: () => 4, progress: true });
    await h.session.requestSync();
    await h.session.handleResponse(page(first(h.sent), { hasMore: true, nextToken: 't1' }));
    expect(h.session.diagnostics().lastFailure).toMatchObject({
      reason: 'apply_failed',
      message: 'Sync pagination token outside a full snapshot',
    });
  });

  test('after a restart the snapshot continues from the saved token and ends where it began', async () => {
    const store: { saved: number | SyncSnapshotResume | null } = {
      saved: { snapshot: 'snapshot-1', token: 'blocks:b4', from: 100 },
    };
    const h = harness({
      cursor: () => store.saved,
      progress: true,
      saveCursor: (version) => {
        store.saved = version ?? null;
      },
    });
    await h.session.requestSync();
    expect(first(h.sent)).toMatchObject({ after: null, token: 'blocks:b4', full: true });
    await h.session.handleResponse(page(first(h.sent), { latestVersion: 105 }));
    // It saves where it began and catches up from there: the feed brings 101–105.
    expect(store.saved).toBe(100);
    expect(h.events).toEqual([]);
    expect(at(h.sent, -1)).toMatchObject({ after: 100, token: null, full: false });
  });

  test('a saved position that names no page is a cursor failure, not a session from zero', async () => {
    // A JavaScript store reaches past the type: what it hands back is read, not trusted.
    const untyped = (value: unknown): SyncSnapshotResume => JSON.parse(JSON.stringify(value));
    for (const saved of [
      { snapshot: 's', after: -1, from: 5 },
      { snapshot: 's', after: 9, from: 'five' },
      { snapshot: 's', token: '', from: 5 },
      { after: 9, from: 5 },
      { snapshot: '', token: 't', from: 5 },
    ]) {
      const h = harness({ cursor: () => untyped(saved), progress: true });
      await h.session.requestSync();
      expect(h.sent).toEqual([]);
      expect(h.session.diagnostics().lastFailure?.reason).toBe('cursor_unavailable');
    }
  });

  test('a page lost after progress asks for the same token again, not for the snapshot from zero', async () => {
    const h = harness({ cursor: () => null, progress: true });
    await h.session.requestSync();
    await h.session.handleResponse(
      page(first(h.sent), { hasMore: true, nextToken: 't1', latestVersion: 50 }),
    );
    h.session.onDisconnect();
    await h.session.onReconnect();
    expect(at(h.sent, -1)).toMatchObject({ after: null, token: 't1', full: true });
    expect(h.events.filter((event) => event === 'begin')).toHaveLength(1);
  });
});

describe('a cursor the server no longer keeps', () => {
  test('a stale feed from zero reloads and rebases the pending operation before saving zero', async () => {
    const pending = new Map([['local-edit', 'queued']]);
    const order: string[] = [];
    const h = harness({
      cursor: () => 0,
      begin: () => {
        order.push('begin');
      },
      rebase: () => {
        expect(pending.get('local-edit')).toBe('queued');
        pending.set('local-edit', 'rebased');
        order.push('rebase');
      },
      saveCursor: (v) => {
        order.push(`save:${v}`);
      },
    });
    await h.session.requestSync();
    const feed = first(h.sent);
    expect(feed).toMatchObject({ full: false, after: 0 });
    await h.session.handleError({ ...feed, code: 'stale_cursor' });
    const snapshot = at(h.sent, -1);
    expect(snapshot).toMatchObject({ full: true, after: null });
    await h.session.handleResponse(page(snapshot, { latestVersion: 0 }));
    expect(order).toEqual(['begin', 'rebase', 'save:0']);
    expect([...pending]).toEqual([['local-edit', 'rebased']]);
    h.session.stop();
  });

  test('stale_cursor loads a full snapshot at once, without a pause or a failure', async () => {
    const h = harness({ cursor: () => 4 });
    await h.session.requestSync();
    const request = first(h.sent);
    await h.session.handleError({ ...request, code: 'stale_cursor' });
    expect(h.events).toEqual(['begin']);
    expect(at(h.sent, -1)).toMatchObject({ after: null, token: null, full: true });
    expect(h.live()).toHaveLength(1); // only the new page's deadline
    expect(h.session.diagnostics()).toMatchObject({ mode: 'full', lastFailure: null });
  });

  test('stale_cursor inside a snapshot starts it over after a pause, not at the same page', async () => {
    const h = harness({ cursor: () => null, progress: true });
    await h.session.requestSync();
    await h.session.handleResponse(
      page(first(h.sent), { hasMore: true, nextCursor: 10, latestVersion: 50 }),
    );
    await h.session.handleError({ ...at(h.sent, -1), code: 'stale_cursor' });
    expect(h.session.diagnostics().lastFailure).toMatchObject({ reason: 'stale_cursor' });
    const pause = h.live().at(-1);
    if (!pause) throw new Error('no pause was scheduled');
    pause.run();
    await Bun.sleep(0);
    expect(at(h.sent, -1)).toMatchObject({ after: null, token: null, full: true });
    expect(h.events.filter((event) => event === 'begin').length).toBeGreaterThanOrEqual(2);
  });
});

describe('pending changes after a full snapshot', () => {
  test('every page of a snapshot and its rebase name one id, kept across a dropped connection', async () => {
    const named: (string | null)[] = [];
    const rebased: { id: string | null } = { id: null };
    let saved: number | null = null;
    const h = harness({
      cursor: () => saved,
      saveCursor: (version) => {
        saved = version ?? saved;
      },
      progress: true,
      apply: (_page, { snapshot }) => void named.push(snapshot),
      rebase: (snapshot) => {
        rebased.id = snapshot;
      },
    });
    await h.session.requestSync();
    await h.session.handleResponse(
      page(first(h.sent), { hasMore: true, nextCursor: 5, full: true, latestVersion: 9 }),
    );
    h.session.onDisconnect();
    await h.session.onReconnect();
    await h.session.handleResponse(page(at(h.sent, -1), { full: true, latestVersion: 9 }));
    const id = named[0] ?? null;
    expect(typeof id).toBe('string');
    expect(named).toEqual([id, id]);
    expect(rebased.id).toBe(id);
    // The catch-up from where it began belongs to no snapshot; the next snapshot is another one.
    expect(at(h.sent, -1)).toMatchObject({ after: 5, full: false });
    await h.session.handleResponse(page(at(h.sent, -1), { latestVersion: 9 }));
    expect(named.at(-1)).toBeNull();
    await h.session.requestFullSync();
    await h.session.handleResponse(page(at(h.sent, -1), { full: true, latestVersion: 9 }));
    expect(named.at(-1)).toEqual(expect.any(String));
    expect(named.at(-1)).not.toBe(id);
  });

  test('a full snapshot rebases pending changes after its last page, before its cursor', async () => {
    const h = harness({ cursor: () => null, rebase: () => undefined });
    await h.session.requestSync();
    await h.session.handleResponse(page(first(h.sent), { hasMore: true, nextCursor: 2 }));
    expect(h.events).toEqual(['begin']);
    await h.session.handleResponse(page(at(h.sent, -1), { latestVersion: 7 }));
    expect(h.events).toEqual(['begin', 'rebase', 'cursor:7']);
  });

  test('one the server forces rebases too; an incremental session never does', async () => {
    const forced = harness({ cursor: () => 4, rebase: () => undefined });
    await forced.session.requestSync();
    await forced.session.handleResponse(page(first(forced.sent), { full: true }));
    expect(forced.events).toEqual(['begin', 'rebase', 'cursor:7']);
    const incremental = harness({ cursor: () => 4, rebase: () => undefined });
    await incremental.session.requestSync();
    await incremental.session.handleResponse(page(first(incremental.sent)));
    expect(incremental.events).toEqual(['cursor:7']);
  });

  test('a rebase that fails saves no cursor and is retried as its own failure', async () => {
    let fail = true;
    const h = harness({
      cursor: () => null,
      rebase: () => {
        if (fail) throw new Error('merge refused');
      },
    });
    await h.session.requestSync();
    await h.session.handleResponse(page(first(h.sent)));
    // No cursor is saved; a one-page snapshot that failed begins again.
    expect(h.events).toEqual(['begin', 'rebase', 'begin']);
    expect(h.session.diagnostics().lastFailure).toMatchObject({
      reason: 'rebase_failed',
      message: 'merge refused',
    });
    fail = false;
    const pause = h.live().at(-1);
    if (!pause) throw new Error('no pause was scheduled');
    pause.run();
    await Bun.sleep(0);
    await h.session.handleResponse(page(at(h.sent, -1)));
    expect(h.events.slice(-2)).toEqual(['rebase', 'cursor:7']);
  });
});
