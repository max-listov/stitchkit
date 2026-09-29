/**
 * The rules of `TelegramUpdateStore`, as a check any store can be put
 * through — the ones shipped here and an application's own over its ORM.
 *
 * A store is five conditional statements, and each is easy to write almost
 * right: a claim that does not check the lease, a settle that does not check
 * the attempt, a claim read and then written in two statements so that two
 * processes both take one update. Nothing fails in a test with one process;
 * the update simply runs twice in production. So the check runs every rule on
 * a fresh store, and races claims against each other.
 *
 * It does not depend on a test framework: it returns what was violated, and
 * an empty list is a store that keeps the rules.
 */

import type { TelegramUpdateStore } from './update-store';

type Rule = (store: TelegramUpdateStore, violated: (what: string) => void) => Promise<void>;

function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const claim = { maxAttempts: 2 };

const RULES: Readonly<Record<string, Rule>> = {
  'one record per update_id': async (store, violated) => {
    if (!(await store.add({ updateId: 7, body: 'b', receivedAt: 0 })))
      violated('add of a new update returned false');
    if (await store.add({ updateId: 7, body: 'other', receivedAt: 1 }))
      violated('add of a recorded update_id returned true');
  },
  'a live lease is not taken, a lapsed one is': async (store, violated) => {
    await store.add({ updateId: 7, body: 'b', receivedAt: 0 });
    if ((await store.claim(7, { ...claim, now: 10, leaseUntil: 100 })) !== 1)
      violated('the first claim was not attempt 1');
    if ((await store.claim(7, { ...claim, now: 50, leaseUntil: 150 })) !== undefined)
      violated('a claim took an update under a live lease');
    if (!same(await store.due({ now: 50, pendingBefore: 50, limit: 10 }), []))
      violated('due listed an update under a live lease');
    if (
      !same(await store.due({ now: 101, pendingBefore: 0, limit: 10 }), [
        { updateId: 7, body: 'b' },
      ])
    )
      violated('due did not list an update whose lease lapsed, with its body');
    if ((await store.claim(7, { ...claim, now: 101, leaseUntil: 200 })) !== 2)
      violated('a lapsed lease was not taken as attempt 2');
  },
  'only the attempt holding the update renews or settles it': async (store, violated) => {
    await store.add({ updateId: 1, body: 'b', receivedAt: 0 });
    await store.claim(1, { ...claim, now: 0, leaseUntil: 10 });
    await store.claim(1, { ...claim, now: 11, leaseUntil: 50 });
    if (await store.renew(1, 1, 500)) violated('an attempt that lost its lease renewed it');
    if (!(await store.renew(1, 2, 60))) violated('the holding attempt could not renew');
    await store.settle(1, 1, { state: 'completed', at: 20 });
    if ((await store.due({ now: 61, pendingBefore: 0, limit: 10 })).length !== 1)
      violated('an attempt that lost its lease settled the update');
    await store.settle(1, 2, { state: 'completed', at: 30 });
    if (!same(await store.due({ now: 1_000, pendingBefore: 1_000, limit: 10 }), []))
      violated('a completed update is still due');
  },
  'a failed update is due at its retry, spent attempts abandon it': async (
    store,
    violated,
  ) => {
    await store.add({ updateId: 2, body: 'b', receivedAt: 0 });
    await store.add({ updateId: 1, body: 'a', receivedAt: 5 });
    await store.claim(2, { ...claim, now: 0, leaseUntil: 10 });
    await store.settle(2, 1, { state: 'failed', at: 1, retryAt: 30, error: 'x' });
    if (!same(await store.due({ now: 29, pendingBefore: 0, limit: 10 }), []))
      violated('a failed update was due before its retry, or a pending one before its grace');
    const due = await store.due({ now: 30, pendingBefore: 5, limit: 10 });
    if (
      !same(
        due.map((row) => row.updateId),
        [1, 2],
      )
    )
      violated('due did not list a retry and a pending update in update_id order');
    if ((await store.due({ now: 30, pendingBefore: 5, limit: 1 })).length !== 1)
      violated('due ignored its limit');
    await store.claim(2, { ...claim, now: 30, leaseUntil: 40 });
    await store.settle(2, 2, { state: 'failed', at: 31, retryAt: 35, error: 'x' });
    if ((await store.claim(2, { ...claim, now: 36, leaseUntil: 50 })) !== undefined)
      violated('an update past maxAttempts was claimed');
    if (!same(await store.due({ now: 100, pendingBefore: 0, limit: 10 }), []))
      violated('an update past maxAttempts was not abandoned');
  },
  'settled updates are forgotten after they are pruned': async (store, violated) => {
    await store.add({ updateId: 3, body: 'b', receivedAt: 0 });
    await store.claim(3, { ...claim, now: 0, leaseUntil: 10 });
    await store.settle(3, 1, { state: 'abandoned', at: 36, error: 'x' });
    await store.add({ updateId: 4, body: 'b', receivedAt: 0 });
    if ((await store.prune(36)) !== 0) violated('prune forgot an update settled at its bound');
    if ((await store.prune(37)) !== 1)
      violated('prune did not forget exactly the settled update before its bound');
    if (!(await store.add({ updateId: 3, body: 'b', receivedAt: 40 })))
      violated('a pruned update_id could not be recorded again');
    if (await store.add({ updateId: 4, body: 'b', receivedAt: 40 }))
      violated('prune forgot an update that was never settled');
  },
  'of concurrent claims exactly one takes the update': async (store, violated) => {
    await store.add({ updateId: 9, body: 'b', receivedAt: 0 });
    const taken = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.claim(9, { maxAttempts: 5, now: 1, leaseUntil: 100 }),
      ),
    );
    if (taken.filter((attempt) => attempt !== undefined).length !== 1)
      violated(
        `${taken.filter((attempt) => attempt !== undefined).length} of 8 concurrent claims took one update`,
      );
  },
};

/**
 * Put a store through every rule, each on a fresh store from `make`. Resolves
 * with the violations — `"<rule>: <what happened>"` — empty when the store
 * keeps them all. A store that throws violates the rule it threw in.
 */
export async function checkTelegramUpdateStore(
  make: () => TelegramUpdateStore | Promise<TelegramUpdateStore>,
): Promise<string[]> {
  const violations: string[] = [];
  for (const [name, rule] of Object.entries(RULES)) {
    try {
      await rule(await make(), (what) => violations.push(`${name}: ${what}`));
    } catch (error) {
      violations.push(
        `${name}: threw ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return violations;
}
