/**
 * The rules every sync server store keeps, as a check an application runs on
 * its own store: `expect(await checkSyncStore(make)).toEqual([])`. Each rule
 * uses scopes of its own and touches nothing outside them — `prune` included —
 * so it can run on a database that holds other data, and twice.
 */
import type { SyncApply, SyncServerStore } from './server-store';

interface Change {
  readonly id: string;
  readonly text: string;
}

type Rule<TX> = (
  store: SyncServerStore<TX>,
  scope: (name: string) => string,
) => Promise<string | undefined>;

/** The app's decision for a change it accepts; the effect is the change's id. */
function appliedFor<TX>(): SyncApply<TX, Change, string> {
  return async (_tx, change) => ({ outcome: 'applied', effect: change.id });
}

function feedRules<TX>(): Record<string, Rule<TX>> {
  return {
    'versions are consecutive, increasing and per scope': async (store, scope) => {
      const a = scope('a');
      const first = await store.transaction((tx) => store.allocateVersions(tx, a, 2));
      const second = await store.transaction((tx) => store.allocateVersions(tx, a, 1));
      const other = await store.transaction((tx) => store.allocateVersions(tx, scope('b'), 1));
      const none = await store.transaction((tx) => store.allocateVersions(tx, a, 0));
      const all = [...first, ...second];
      if (all.some((version, index) => index > 0 && version !== (all[index - 1] ?? 0) + 1))
        return `versions ${JSON.stringify(all)} are not consecutive`;
      if (other[0] !== first[0]) return 'another scope did not start from the same place';
      if (none.length !== 0) return 'zero versions returned some';
      return undefined;
    },
    'a rolled-back transaction leaves no version and no feed row': async (store, scope) => {
      const s = scope('rollback');
      await store
        .transaction(async (tx) => {
          await store.publish(tx, s, [{ entity: 'task', entityId: 'x', deleted: false }]);
          throw new Error('roll back');
        })
        .catch(() => undefined);
      const page = await store.changesAfter(s, null, { limit: 10 });
      const next = await store.transaction((tx) => store.allocateVersions(tx, s, 1));
      const empty = await store.changesAfter(scope('never'), null, { limit: 10 });
      if (page.changes.length > 0) return 'a rolled-back publish is in the feed';
      if (next[0] !== empty.latestVersion + 1)
        return 'a rolled-back allocation used up a version';
      return undefined;
    },
    'the feed keeps one row per entity, at its newest version': async (store, scope) => {
      const s = scope('feed');
      await store.transaction((tx) =>
        store.publish(tx, s, [
          { entity: 'task', entityId: 'a', deleted: false },
          { entity: 'task', entityId: 'b', deleted: false },
        ]),
      );
      const [last] = await store.transaction((tx) =>
        store.publish(tx, s, [{ entity: 'task', entityId: 'a', deleted: true }]),
      );
      const page = await store.changesAfter(s, null, { limit: 10 });
      const ids = page.changes.map(
        (change) => `${change.entityId}@${change.version}:${change.deleted}`,
      );
      if (
        ids.length !== 2 ||
        page.changes.at(-1)?.entityId !== 'a' ||
        page.changes.at(-1)?.version !== last
      )
        return `feed is ${JSON.stringify(ids)}`;
      if (page.latestVersion !== last)
        return `latestVersion ${page.latestVersion}, not ${last}`;
      const full = await store.changesAfter(s, null, { limit: 10, full: true });
      if (full.changes.some((change) => change.deleted))
        return 'a full read listed a deleted entity';
      return undefined;
    },
    'pages follow the cursor to the end': async (store, scope) => {
      const s = scope('pages');
      await store.transaction((tx) =>
        store.publish(
          tx,
          s,
          ['a', 'b', 'c'].map((entityId) => ({ entity: 'task', entityId, deleted: false })),
        ),
      );
      const first = await store.changesAfter(s, null, { limit: 2 });
      const second = await store.changesAfter(s, first.nextCursor, { limit: 2 });
      if (!first.hasMore || first.changes.length !== 2)
        return 'the first page was not cut at its limit';
      if (
        second.hasMore ||
        second.nextCursor !== null ||
        second.changes.map((c) => c.entityId).join() !== 'c'
      )
        return 'the second page did not end the feed';
      return undefined;
    },
  };
}

function pushRules<TX>(): Record<string, Rule<TX>> {
  const applied = appliedFor<TX>();
  return {
    'a change runs once; its repeat gets the stored outcome': async (store, scope) => {
      const request = {
        scope: scope('push'),
        replicaId: 'r1',
        changes: [{ id: 'c1', text: 'hi' }],
      };
      let runs = 0;
      const counting: SyncApply<TX, Change, string> = async (tx, change) => {
        runs += 1;
        return applied(tx, change);
      };
      const first = await store.push(request, counting);
      const again = await store.push(request, counting);
      if (first.results[0]?.outcome !== 'applied' || first.effects.join() !== 'c1')
        return `the first push was ${JSON.stringify(first)}`;
      if (again.results[0]?.outcome !== 'replayed' || again.effects.length > 0 || runs !== 1)
        return `the repeat was ${JSON.stringify(again)} after ${runs} runs`;
      const otherReplica = await store.push({ ...request, replicaId: 'r2' }, counting);
      if (otherReplica.results[0]?.outcome !== 'applied')
        return 'the same id from another replica was not its own change';
      return undefined;
    },
    'an applied change names the newest version it took; its replay names it too': async (
      store,
      scope,
    ) => {
      const s = scope('version');
      const writing: SyncApply<TX, Change, string> = async (tx, change) => {
        await store.publish(tx, s, [
          { entity: 'task', entityId: `${change.id}-a`, deleted: false },
          { entity: 'task', entityId: `${change.id}-b`, deleted: false },
        ]);
        return { outcome: 'applied' };
      };
      const request = { scope: s, replicaId: 'r', changes: [{ id: 'v', text: '' }] };
      const first = await store.push(request, writing);
      const page = await store.changesAfter(s, null, { limit: 10 });
      const again = await store.push(request, writing);
      const silent = await store.push(
        { scope: s, replicaId: 'r', changes: [{ id: 'quiet', text: '' }] },
        applied,
      );
      if (first.results[0]?.version !== page.latestVersion)
        return `applied named ${first.results[0]?.version}, the feed is at ${page.latestVersion}`;
      if (again.results[0]?.version !== page.latestVersion)
        return `the replay named ${again.results[0]?.version}`;
      if (silent.results[0] && 'version' in silent.results[0])
        return 'a change that took no version named one';
      return undefined;
    },
    'the same id with other content is refused': async (store, scope) => {
      const s = scope('reuse');
      await store.push(
        { scope: s, replicaId: 'r', changes: [{ id: 'c', text: 'one' }] },
        applied,
      );
      const reused = await store.push(
        { scope: s, replicaId: 'r', changes: [{ id: 'c', text: 'two' }] },
        applied,
      );
      const result = reused.results[0];
      if (result?.outcome !== 'terminal_rejected' || result.code !== 'change_id_reused')
        return `a reused id got ${JSON.stringify(result)}`;
      return undefined;
    },
    'a rejection is recorded; a throw rolls back and is retried': async (store, scope) => {
      const s = scope('reject');
      let runs = 0;
      const reject: SyncApply<TX, Change, string> = async () => {
        runs += 1;
        return { outcome: 'terminal_rejected', code: 'not_allowed' };
      };
      await store.push(
        { scope: s, replicaId: 'r', changes: [{ id: 'no', text: '' }] },
        reject,
      );
      const repeat = await store.push(
        { scope: s, replicaId: 'r', changes: [{ id: 'no', text: '' }] },
        reject,
      );
      if (repeat.results[0]?.code !== 'not_allowed' || runs !== 1)
        return 'a recorded rejection ran again';
      const failing: SyncApply<TX, Change, string> = async (tx) => {
        await store.publish(tx, s, [{ entity: 'task', entityId: 'half', deleted: false }]);
        throw new Error('database hiccup');
      };
      const failed = await store.push(
        { scope: s, replicaId: 'r', changes: [{ id: 'f', text: '' }] },
        failing,
      );
      if (failed.results[0]?.outcome !== 'retryable_failed')
        return 'a throw was not retryable_failed';
      if ((await store.changesAfter(s, null, { limit: 10 })).changes.length > 0)
        return 'a failed change left its writes';
      const retried = await store.push(
        { scope: s, replicaId: 'r', changes: [{ id: 'f', text: '' }] },
        applied,
      );
      if (retried.results[0]?.outcome !== 'applied') return 'a failed change was recorded';
      return undefined;
    },
    'a replica the authentication does not name changes nothing': async (store, scope) => {
      let runs = 0;
      const result = await store.push(
        {
          scope: scope('replica'),
          replicaId: 'r1',
          claimedReplicaId: 'r2',
          changes: [{ id: 'c', text: '' }],
        },
        async (tx, change) => {
          runs += 1;
          return applied(tx, change);
        },
      );
      if (result.results[0]?.code !== 'replica_mismatch' || runs !== 0)
        return 'a mismatched replica ran';
      return undefined;
    },
    'prune forgets old records of the scope it names only': async (store, scope) => {
      const s = scope('prune');
      const other = scope('kept');
      await store.push(
        { scope: s, replicaId: 'r', changes: [{ id: 'old', text: '' }] },
        applied,
      );
      await store.push(
        { scope: other, replicaId: 'r', changes: [{ id: 'k', text: '' }] },
        applied,
      );
      const kept = await store.prune({ before: 0, scope: s });
      if (kept !== 0) return `prune before 0 removed ${kept}`;
      const removed = await store.prune({ before: Number.MAX_SAFE_INTEGER, scope: s });
      if (removed !== 1) return `prune of one scope removed ${removed}`;
      const again = await store.push(
        { scope: s, replicaId: 'r', changes: [{ id: 'old', text: '' }] },
        applied,
      );
      if (again.results[0]?.outcome !== 'applied')
        return 'a forgotten change was still remembered';
      const untouched = await store.push(
        { scope: other, replicaId: 'r', changes: [{ id: 'k', text: '' }] },
        applied,
      );
      if (untouched.results[0]?.outcome !== 'replayed') return 'prune reached another scope';
      return undefined;
    },
    'a rejection rolls back what apply wrote': async (store, scope) => {
      const s = scope('rejected-writes');
      const result = await store.push(
        { scope: s, replicaId: 'r', changes: [{ id: 'no', text: '' }] },
        async (tx) => {
          await store.publish(tx, s, [{ entity: 'task', entityId: 'half', deleted: false }]);
          return { outcome: 'terminal_rejected', code: 'not_allowed' };
        },
      );
      if (result.results[0]?.code !== 'not_allowed') return 'the rejection was not returned';
      if ((await store.changesAfter(s, null, { limit: 10 })).changes.length > 0)
        return 'a rejected change kept its writes';
      return undefined;
    },
    'a failure carries its cause for the server, not in the result': async (store, scope) => {
      const failed = await store.push(
        { scope: scope('cause'), replicaId: 'r', changes: [{ id: 'f', text: '' }] },
        async () => {
          throw new Error('disk full');
        },
      );
      const cause = failed.failures[0]?.error;
      if (!(cause instanceof Error) || cause.message !== 'disk full')
        return 'the failure did not carry its cause';
      if ('error' in (failed.results[0] ?? {})) return 'the cause leaked into the result';
      return undefined;
    },
  };
}

function concurrencyRules<TX>(): Record<string, Rule<TX>> {
  const applied = appliedFor<TX>();
  return {
    'a reader never sees a later version before an earlier one commits': async (
      store,
      scope,
    ) => {
      const s = scope('order');
      const hold = Promise.withResolvers<void>();
      const took = Promise.withResolvers<void>();
      const first = store.transaction(async (tx) => {
        await store.publish(tx, s, [{ entity: 'task', entityId: 'first', deleted: false }]);
        took.resolve();
        await hold.promise;
      });
      await took.promise;
      const second = store.transaction((tx) =>
        store.publish(tx, s, [{ entity: 'task', entityId: 'second', deleted: false }]),
      );
      const during = store.changesAfter(s, null, { limit: 10 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      hold.resolve();
      await Promise.all([first, second]);
      const seen = (await during).changes.map((change) => change.entityId);
      if (seen.includes('second') && !seen.includes('first'))
        return 'a reader saw the later version while the earlier one was open';
      const all = (await store.changesAfter(s, null, { limit: 10 })).changes;
      if (all.map((change) => change.entityId).join() !== 'first,second')
        return `versions committed as ${JSON.stringify(all)}`;
      return undefined;
    },
    'two concurrent pushes of one change apply it once': async (store, scope) => {
      const request = {
        scope: scope('twice'),
        replicaId: 'r',
        changes: [{ id: 'c', text: '' }],
      };
      const both = await Promise.all([
        store.push(request, applied),
        store.push(request, applied),
      ]);
      const outcomes = both.map((outcome) => outcome.results[0]?.outcome);
      if (outcomes.filter((outcome) => outcome === 'applied').length !== 1)
        return `outcomes were ${JSON.stringify(outcomes)}`;
      const again = await store.push(request, applied);
      if (again.results[0]?.outcome !== 'replayed') return 'the change was not recorded once';
      return undefined;
    },
  };
}

function rulesFor<TX>(): Record<string, Rule<TX>> {
  return { ...feedRules<TX>(), ...pushRules<TX>(), ...concurrencyRules<TX>() };
}

/** Run every rule on stores from `make`; returns the broken rules, `[]` when all hold. */
export async function checkSyncStore<TX>(
  make: () => SyncServerStore<TX> | Promise<SyncServerStore<TX>>,
): Promise<string[]> {
  const failures: string[] = [];
  const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  for (const [index, [name, rule]] of Object.entries(rulesFor<TX>()).entries()) {
    const store = await make();
    try {
      const failure = await rule(store, (part) => `check-${run}-${index}-${part}`);
      if (failure) failures.push(`${name}: ${failure}`);
    } catch (error) {
      failures.push(
        `${name}: threw ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}
