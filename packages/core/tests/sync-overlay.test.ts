/**
 * Pending local edits on top of remote rows, deletes that win until
 * acknowledged, and the protocol a client reads one result at a time — on the
 * rules a consuming offline-first app pins.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { applyOverlay, deriveOverlay, type OverlaySpec } from '../src/sync/overlay';
import {
  classifyChangeResults,
  mergeStreamCursors,
  SyncPageHeaderSchema,
  syncPushRequestSchema,
} from '../src/sync/protocol';
import {
  decideRemoteRow,
  dependentRowVisible,
  orphansOf,
  staleAfterFullSync,
} from '../src/sync/tombstones';

interface Task {
  id: string;
  text: string;
  done: boolean;
  priority: string | null;
  updatedAt: string;
}
const TaskUpdate = z
  .object({ text: z.string(), done: z.boolean(), priority: z.string() })
  .partial()
  .strict();
const spec: OverlaySpec<Task> = {
  parse: (payload) => {
    const parsed = TaskUpdate.safeParse(payload);
    return parsed.success ? { values: parsed.data } : undefined;
  },
  keep: { priority: (current) => current.priority ?? undefined },
};
const current: Task = {
  id: 't',
  text: 'local',
  done: true,
  priority: null,
  updatedAt: '2026-11-22T01:00:00Z',
};
const remote: Task = {
  id: 't',
  text: 'remote',
  done: false,
  priority: 'high',
  updatedAt: '2026-11-22T00:00:00Z',
};

describe('the overlay of pending edits', () => {
  test('with a local row, its current values of the touched fields win; untouched fields refresh', () => {
    const overlay = deriveOverlay(
      [{ payload: { text: 'typed' }, createdAt: '2026-11-22T00:30:00Z' }],
      { current: current, spec },
    );
    expect(overlay).toEqual({ text: 'local', updatedAt: current.updatedAt });
    expect(applyOverlay(remote, overlay)).toEqual({
      ...remote,
      text: 'local',
      updatedAt: current.updatedAt,
    });
  });

  test('without a local row the pending payload is the value, the newest edit last', () => {
    const overlay = deriveOverlay(
      [
        { payload: { text: 'first' }, createdAt: 'a' },
        { payload: { text: 'second', done: true }, createdAt: 'b' },
      ],
      { current: null, spec },
    );
    expect(overlay).toEqual({ text: 'second', done: true, updatedAt: 'b' });
  });

  test('a payload that is not an update is skipped; nothing pending means nothing on top', () => {
    expect(
      deriveOverlay([{ payload: { unknown: 1 }, createdAt: 'a' }], { current: current, spec }),
    ).toEqual({});
    expect(deriveOverlay([], { current: current, spec })).toEqual({});
  });

  test('a keep rule may keep nothing: a null priority does not hide the server’s', () => {
    const overlay = deriveOverlay([{ payload: { priority: 'low' }, createdAt: 'a' }], {
      current: current,
      spec,
    });
    expect(overlay).toEqual({ updatedAt: current.updatedAt });
  });

  test('a field an edit protects without carrying its value is kept from the local row', () => {
    const protecting: OverlaySpec<Task> = {
      parse: () => ({ values: {}, protects: ['text'] }),
    };
    expect(
      deriveOverlay([{ payload: {}, createdAt: 'a' }], { current: current, spec: protecting }),
    ).toEqual({
      text: 'local',
      updatedAt: current.updatedAt,
    });
  });
});

test('a pending key without a value does not erase the remote field', () => {
  const sparse: OverlaySpec<Task> = {
    parse: () => ({ values: { text: undefined, done: true } }),
  };
  const overlay = deriveOverlay([{ payload: {}, createdAt: 'a' }], {
    current: null,
    spec: sparse,
  });
  expect(overlay).toEqual({ done: true, updatedAt: 'a' });
  expect(applyOverlay(remote, overlay).text).toBe('remote');
});

describe('tombstones', () => {
  test('a local delete wins, a remote one yields to a live row, no tombstone applies', () => {
    expect(decideRemoteRow('local')).toBe('skip');
    expect(decideRemoteRow('remote')).toBe('resurrect');
    expect(decideRemoteRow(null)).toBe('apply');
  });

  test('a child of a parent deleted in this page, or tombstoned and not brought back, is hidden', () => {
    const base = { tombstone: null, deletedInPage: false, resurrectedInPage: false } as const;
    expect(dependentRowVisible(base)).toBe(true);
    expect(dependentRowVisible({ ...base, deletedInPage: true })).toBe(false);
    expect(dependentRowVisible({ ...base, tombstone: 'local' })).toBe(false);
    expect(
      dependentRowVisible({ ...base, tombstone: 'remote', resurrectedInPage: true }),
    ).toBe(true);
  });

  test('a completed snapshot makes stale only what the server lacks and nothing protects', () => {
    expect(
      staleAfterFullSync({
        local: ['a', 'b', 'c'],
        server: new Set(['a']),
        protectedIds: new Set(['c']),
      }),
    ).toEqual(['b']);
  });

  test('children of a parent that is gone are orphans', () => {
    expect(
      orphansOf(
        [
          { id: 'x', parent: 'p1' },
          { id: 'y', parent: 'p2' },
        ],
        { ids: new Set(['p1']), of: (child) => child.parent },
      ),
    ).toEqual(['y']);
  });
});

describe('the protocol', () => {
  test('each result is read on its own: an unknown outcome is retried, a malformed entry is counted', () => {
    const { results, invalid } = classifyChangeResults([
      { changeId: 'a', outcome: 'applied' },
      { changeId: 'b', outcome: 'replayed' },
      { changeId: 'c', outcome: 'terminal_rejected', code: 'conflict_new_server_code' },
      { changeId: 'd', outcome: 'deferred_by_a_newer_server' },
      { changeId: 'e', outcome: 'retryable_failed', code: null },
      { outcome: 'applied' },
    ]);
    expect(invalid).toBe(1);
    expect(
      results.map((result) => [result.changeId, result.outcome, result.known, result.action]),
    ).toEqual([
      ['a', 'applied', true, 'acknowledge'],
      ['b', 'replayed', true, 'acknowledge'],
      ['c', 'terminal_rejected', true, 'hold'],
      ['d', 'retryable_failed', false, 'retry'],
      ['e', 'retryable_failed', true, 'retry'],
    ]);
    expect(results[2]?.code).toBe('conflict_new_server_code');
    expect(results[4]).not.toHaveProperty('code');
  });

  test('an unknown outcome is held once it came back holdAfter times; a known failure never is', () => {
    const seen = new Map([
      ['twice', 2],
      ['once', 1],
      ['known', 9],
    ]);
    const { results } = classifyChangeResults(
      [
        { changeId: 'twice', outcome: 'new_outcome' },
        { changeId: 'once', outcome: 'new_outcome' },
        { changeId: 'known', outcome: 'retryable_failed' },
      ],
      { holdAfter: 3, unknownOutcomesOf: (id) => seen.get(id) ?? 0 },
    );
    expect(results.map((result) => result.action)).toEqual(['hold', 'retry', 'retry']);
    expect(classifyChangeResults([{ changeId: 'x', outcome: 'new' }]).results[0]?.action).toBe(
      'retry',
    );
  });

  test('a rejection waits for a person by default; an app whose rows stand alone acknowledges it', () => {
    const answer = [{ changeId: 'E1', outcome: 'terminal_rejected', code: 'not_allowed' }];
    expect(classifyChangeResults(answer).results[0]).toMatchObject({
      action: 'hold',
      code: 'not_allowed',
    });
    expect(classifyChangeResults(answer, { rejected: 'acknowledge' }).results[0]?.action).toBe(
      'acknowledge',
    );
    expect(() =>
      // @ts-expect-error — a rejection is acknowledged or held.
      classifyChangeResults(answer, { rejected: 'drop' }),
    ).toThrow(RangeError);
  });

  test('a known failure is held after holdAfterFailures answers, when the app asks for it', () => {
    const failures = new Map([
      ['poison', 7],
      ['fresh', 0],
    ]);
    const { results } = classifyChangeResults(
      [
        { changeId: 'poison', outcome: 'retryable_failed' },
        { changeId: 'fresh', outcome: 'retryable_failed' },
      ],
      { holdAfterFailures: 8, failuresOf: (id) => failures.get(id) ?? 0 },
    );
    expect(results.map((result) => result.action)).toEqual(['hold', 'retry']);
    expect(() => classifyChangeResults([], { holdAfterFailures: 8 })).toThrow(RangeError);
    expect(() =>
      classifyChangeResults([], { holdAfterFailures: 0, failuresOf: () => 0 }),
    ).toThrow(RangeError);
  });

  test('the version an acknowledged change got comes with its result', () => {
    const { results, invalid } = classifyChangeResults([
      { changeId: 'a', outcome: 'applied', version: 12 },
      { changeId: 'b', outcome: 'replayed', version: 9 },
      { changeId: 'c', outcome: 'applied' },
      { changeId: 'd', outcome: 'terminal_rejected', version: null },
      { changeId: 'e', outcome: 'applied', version: -1 },
    ]);
    expect(results.map((result) => [result.changeId, result.version])).toEqual([
      ['a', 12],
      ['b', 9],
      ['c', undefined],
      ['d', undefined],
    ]);
    expect(results[2]).not.toHaveProperty('version');
    expect(invalid).toBe(1);
  });

  test('several streams make one cursor that no stream skips past', () => {
    expect(
      mergeStreamCursors([
        { lastVersion: 40, truncated: true },
        { lastVersion: 25, truncated: true },
        { lastVersion: 10, truncated: false },
        { lastVersion: 90, truncated: false },
      ]),
    ).toEqual({ hasMore: true, nextCursor: 25, latestVersion: 90 });
    expect(mergeStreamCursors([{ lastVersion: null, truncated: false }])).toEqual({
      hasMore: false,
      nextCursor: null,
    });
  });

  test('a merged cursor fits the page header; a stream cut without a version is refused', () => {
    const empty = mergeStreamCursors([{ lastVersion: null, truncated: false }]);
    expect(
      SyncPageHeaderSchema.safeParse({ sessionId: 's', requestId: 'r', ...empty }).success,
    ).toBe(true);
    expect(() => mergeStreamCursors([{ lastVersion: null, truncated: true }])).toThrow(
      'names its last version',
    );
  });

  test('a push refuses more changes or more bytes than its limits', () => {
    const Push = syncPushRequestSchema(z.object({ id: z.string() }), {
      maxChanges: 2,
      maxBytes: 30,
    });
    expect(Push.safeParse({ changes: [{ id: 'a' }, { id: 'b' }] }).success).toBe(true);
    expect(Push.safeParse({ changes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }).success).toBe(
      false,
    );
    expect(Push.safeParse({ changes: [{ id: 'x'.repeat(40) }] }).success).toBe(false);
    expect(Push.safeParse({ changes: [] }).success).toBe(false);
  });

  test('a page header keeps the app’s rows and refuses a negative cursor', () => {
    const Page = SyncPageHeaderSchema.extend({ tasks: z.array(z.string()) });
    expect(
      Page.parse({ sessionId: 's', requestId: 'r', hasMore: false, tasks: ['t'] }).tasks,
    ).toEqual(['t']);
    expect(
      Page.safeParse({
        sessionId: 's',
        requestId: 'r',
        hasMore: true,
        nextCursor: -1,
        tasks: [],
      }).success,
    ).toBe(false);
  });
});
