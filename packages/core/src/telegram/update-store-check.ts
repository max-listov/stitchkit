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

import type {
  TelegramUpdateDurableStore,
  TelegramUpdateFencedStore,
  TelegramUpdateStore,
} from './update-store';

type Rule = (store: TelegramUpdateStore, violated: (what: string) => void) => Promise<void>;

function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const claim = { maxAttempts: 2 };

function fenced(store: TelegramUpdateStore): store is TelegramUpdateFencedStore {
  return (
    'claimOwned' in store &&
    typeof store.claimOwned === 'function' &&
    'renewOwned' in store &&
    typeof store.renewOwned === 'function' &&
    'owns' in store &&
    typeof store.owns === 'function' &&
    'settleOwned' in store &&
    typeof store.settleOwned === 'function'
  );
}

function durable(store: TelegramUpdateStore): store is TelegramUpdateDurableStore {
  return (
    fenced(store) &&
    'exhaust' in store &&
    typeof store.exhaust === 'function' &&
    'dueExhaustions' in store &&
    typeof store.dueExhaustions === 'function' &&
    'acknowledgeExhaustion' in store &&
    typeof store.acknowledgeExhaustion === 'function'
  );
}

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
    const owned = fenced(store) ? store : undefined;
    const firstIdentity = owned
      ? await owned.claimOwned(1, { ...claim, now: 0, leaseUntil: 10 })
      : undefined;
    if (!owned) await store.claim(1, { ...claim, now: 0, leaseUntil: 10 });
    if (
      firstIdentity &&
      owned &&
      (await owned.settleOwned(firstIdentity, { state: 'completed', at: 11 }))
    ) {
      violated('an attempt whose lease expired settled the update');
    }
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
    await store.claim(3, { ...claim, now: 0, leaseUntil: 100 });
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
  'of concurrent fenced claims exactly one takes the update': async (store, violated) => {
    if (!fenced(store)) return;
    await store.add({ updateId: 19, body: 'b', receivedAt: 0 });
    const taken = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.claimOwned(19, { maxAttempts: 5, now: 1, leaseUntil: 100 }),
      ),
    );
    if (taken.filter((identity) => identity !== undefined).length !== 1) {
      violated(
        `${taken.filter((identity) => identity !== undefined).length} of 8 concurrent fenced claims took one update`,
      );
    }
  },
  'renewal never shortens a live lease': async (store, violated) => {
    await store.add({ updateId: 18, body: 'b', receivedAt: 0 });
    const identity = fenced(store)
      ? await store.claimOwned(18, { ...claim, now: 0, leaseUntil: 10 })
      : undefined;
    if (!identity) await store.claim(18, { ...claim, now: 0, leaseUntil: 10 });
    if (!(await store.renew(18, 1, 30, 1))) {
      violated('the live attempt could not extend its lease');
      return;
    }
    if (!(await store.renew(18, 1, 20, 2))) {
      violated('an older live renewal was not accepted');
      return;
    }
    if ((await store.due({ now: 21, pendingBefore: 0, limit: 10 })).length !== 0) {
      violated('an older renewal shortened the current lease');
    }
    if (identity && fenced(store)) {
      if (!(await store.renewOwned(identity, 40, 3))) {
        violated('the fenced attempt could not extend its lease');
        return;
      }
      if (!(await store.renewOwned(identity, 35, 4))) {
        violated('an older fenced renewal was not accepted');
        return;
      }
      if (!(await store.owns(identity, 39))) {
        violated('an older fenced renewal shortened the current lease');
      }
    }
  },
  'an attempt fence expires and never adopts a later claim': async (store, violated) => {
    if (!fenced(store)) return;
    await store.add({ updateId: 10, body: 'b', receivedAt: 0 });
    const first = await store.claimOwned(10, { ...claim, now: 0, leaseUntil: 10 });
    if (!first) {
      violated('the first fenced claim was not taken');
      return;
    }
    if (!(await store.owns(first, 10)))
      violated('the current attempt did not own its lease at the bound');
    const wrongFirst = { ...first, claimId: `${first.claimId}-wrong` };
    if (await store.owns(wrongFirst, 10))
      violated('a different claim token owned the current attempt');
    if (await store.renewOwned(wrongFirst, 10, 0))
      violated('a different claim token renewed the current attempt');
    if (await store.owns(first, 11)) violated('an expired attempt still owned its lease');
    if (await store.renewOwned(first, 50, 11))
      violated('an expired attempt resurrected its lease');
    const second = await store.claimOwned(10, { ...claim, now: 11, leaseUntil: 30 });
    if (!second) {
      violated('the later fenced claim was not taken');
      return;
    }
    if (await store.owns(first, 12)) violated('the old attempt adopted the later claim');
    if (!(await store.owns(second, 12))) violated('the later attempt did not own its claim');
    if (!(await store.settleOwned(second, { state: 'completed', at: 12 })))
      violated('the later attempt could not settle its claim');
    if ((await store.prune(13)) !== 1) {
      violated('the settled fenced attempt could not be pruned');
      return;
    }
    await store.add({ updateId: 10, body: 'new b', receivedAt: 13 });
    const recycled = await store.claimOwned(10, { ...claim, now: 13, leaseUntil: 30 });
    if (!recycled) {
      violated('the recycled update_id could not be claimed');
      return;
    }
    if (recycled.attempt !== first.attempt)
      violated('the recycled update_id did not restart its attempt number');
    const wrongRecycled = { ...recycled, claimId: `${recycled.claimId}-wrong` };
    if (await store.renewOwned(wrongRecycled, 40, 14))
      violated('a different claim token renewed a recycled update_id');
    if (await store.settleOwned(wrongRecycled, { state: 'completed', at: 14 }))
      violated('a different claim token settled a recycled update_id');
    if (await store.owns(first, 14))
      violated('a pruned claim identity adopted a recycled update_id');
    if (await store.renewOwned(first, 40, 14))
      violated('a pruned claim identity renewed a recycled update_id');
    if (await store.settleOwned(first, { state: 'completed', at: 14 }))
      violated('a pruned claim identity settled a recycled update_id');
  },
  'durable exhaustion survives owner loss until its exact acknowledgement': async (
    store,
    violated,
  ) => {
    if (!durable(store)) return;
    await store.add({ updateId: 11, body: 'crash', receivedAt: 0 });
    const first = await store.claimOwned(11, {
      now: 0,
      leaseUntil: 10,
      maxAttempts: 1,
      durableExhaustion: true,
    });
    if (!first) {
      violated('the durable claim was not taken');
      return;
    }
    if (
      (await store.claimOwned(11, {
        now: 11,
        leaseUntil: 20,
        maxAttempts: 1,
        durableExhaustion: true,
      })) !== undefined
    ) {
      violated('an attempts-spent update was claimed again');
    }
    const [exhaustion] = await store.dueExhaustions({ limit: 10 });
    if (
      exhaustion?.updateId !== 11 ||
      exhaustion.attempt !== 1 ||
      exhaustion.body !== 'crash'
    ) {
      violated(
        'the attempts-spent abandonment was not recoverable with its identity and body',
      );
      return;
    }
    if ((await store.prune(1_000)) !== 0)
      violated('prune removed an unacknowledged exhaustion');
    if (
      await store.acknowledgeExhaustion(
        { ...exhaustion, claimId: `${exhaustion.claimId}-wrong` },
        20,
      )
    ) {
      violated('a different claim token acknowledged the exhaustion');
    }
    if (await store.acknowledgeExhaustion({ ...exhaustion, attempt: 2 }, 20))
      violated('a different attempt acknowledged the exhaustion');
    if (!(await store.acknowledgeExhaustion(exhaustion, 20)))
      violated('the exact attempt could not acknowledge the exhaustion');
    if ((await store.dueExhaustions({ limit: 10 })).length !== 0)
      violated('an acknowledged exhaustion remained due');
    if ((await store.prune(21)) !== 1)
      violated('an acknowledged exhaustion could not be pruned');

    await store.add({ updateId: 12, body: 'terminal', receivedAt: 0 });
    const terminal = await store.claimOwned(12, { now: 0, leaseUntil: 10, maxAttempts: 2 });
    if (!terminal) {
      violated('the terminal claim was not taken');
      return;
    }
    if (
      await store.exhaust(
        { ...terminal, claimId: `${terminal.claimId}-wrong` },
        { at: 1, error: 'wrong terminal refusal' },
      )
    ) {
      violated('a different claim token persisted terminal exhaustion');
    }
    if (!(await store.exhaust(terminal, { at: 1, error: 'terminal refusal' }))) {
      violated('the holding attempt could not persist its terminal exhaustion');
    }
    if ((await store.dueExhaustions({ limit: 10 }))[0]?.error !== 'terminal refusal')
      violated('the terminal exhaustion did not preserve its reason');

    await store.add({ updateId: 13, body: 'expired', receivedAt: 0 });
    const expired = await store.claimOwned(13, { now: 0, leaseUntil: 10, maxAttempts: 2 });
    if (!expired) {
      violated('the expiring claim was not taken');
      return;
    }
    if (await store.exhaust(expired, { at: 11, error: 'late terminal refusal' })) {
      violated('an expired attempt persisted a terminal exhaustion');
    }
    if (
      (await store.claimOwned(13, { now: 11, leaseUntil: 20, maxAttempts: 2 }))?.attempt !== 2
    )
      violated('an expired terminal attempt prevented a later claim');

    await store.add({ updateId: 14, body: 'next terminal', receivedAt: 0 });
    const next = await store.claimOwned(14, { now: 0, leaseUntil: 10, maxAttempts: 2 });
    if (!next) {
      violated('the next terminal claim was not taken');
      return;
    }
    await store.exhaust(next, { at: 1, error: 'next terminal refusal' });
    if (
      !same(
        (await store.dueExhaustions({ limit: 10, afterUpdateId: 12 })).map(
          ({ updateId }) => updateId,
        ),
        [14],
      )
    ) {
      violated('exhaustion pagination did not continue after its update_id cursor');
    }

    await store.add({ updateId: 15, body: 'base durable', receivedAt: 0 });
    if (
      (await store.claim(15, {
        now: 0,
        leaseUntil: 10,
        maxAttempts: 1,
        durableExhaustion: true,
      })) !== 1
    ) {
      violated('the base durable claim was not taken');
      return;
    }
    await store.claim(15, {
      now: 11,
      leaseUntil: 20,
      maxAttempts: 1,
      durableExhaustion: true,
    });
    const baseExhaustion = (await store.dueExhaustions({ limit: 20 })).find(
      ({ updateId }) => updateId === 15,
    );
    if (!baseExhaustion) {
      violated('a base durable claim became an invisible exhaustion');
      return;
    }
    if (!(await store.acknowledgeExhaustion(baseExhaustion, 20)))
      violated('a base durable exhaustion could not be acknowledged');
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
