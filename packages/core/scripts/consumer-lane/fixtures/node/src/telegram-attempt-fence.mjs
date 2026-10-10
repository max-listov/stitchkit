import assert from 'node:assert/strict';
import { createTelegramUpdateIntake, memoryTelegramUpdateStore } from 'stitchkit/telegram';

const body = (updateId, text) =>
  JSON.stringify({ update_id: updateId, message: { chat: { id: 1 }, text } });

const contexts = [];
const intake = createTelegramUpdateIntake({
  store: memoryTelegramUpdateStore(),
  handleAttempt: (_update, context) => contexts.push(context),
});
await intake.start();
assert.equal(await intake.accept(body(1, 'owned')), 'accepted');
await intake.idle();
await intake.close();
assert.equal(contexts.length, 1);
assert.equal(typeof contexts[0].claimId, 'string');
assert.deepEqual(contexts[0].fence, {
  updateId: 1,
  attempt: 1,
  claimId: contexts[0].claimId,
});
assert.equal(contexts[0].ownerLost.aborted, false);

const store = memoryTelegramUpdateStore();
await store.add({ updateId: 7, body: body(7, 'first'), receivedAt: 0 });
const first = await store.claimOwned(7, { now: 0, leaseUntil: 10, maxAttempts: 2 });
assert.ok(first);
assert.equal(await store.settleOwned(first, { state: 'completed', at: 1 }), true);
assert.equal(await store.prune(2), 1);
await store.add({ updateId: 7, body: body(7, 'recycled'), receivedAt: 2 });
const recycled = await store.claimOwned(7, { now: 2, leaseUntil: 20, maxAttempts: 2 });
assert.ok(recycled);
assert.equal(recycled.attempt, first.attempt);
assert.notEqual(recycled.claimId, first.claimId);
assert.equal(await store.owns(first, 3), false);
assert.equal(await store.renewOwned(first, 30, 3), false);
assert.equal(await store.settleOwned(first, { state: 'completed', at: 3 }), false);
assert.equal(await store.owns(recycled, 3), true);

await store.add({ updateId: 8, body: body(8, 'terminal'), receivedAt: 0 });
const terminal = await store.claimOwned(8, { now: 0, leaseUntil: 10, maxAttempts: 1 });
assert.ok(terminal);
assert.equal(await store.exhaust(terminal, { at: 1, error: 'terminal refusal' }), true);
const [exhaustion] = await store.dueExhaustions({ limit: 10 });
assert.ok(exhaustion);
assert.equal(
  await store.acknowledgeExhaustion(
    { ...exhaustion, claimId: `${exhaustion.claimId}-wrong` },
    2,
  ),
  false,
);
assert.equal(await store.acknowledgeExhaustion(exhaustion, 2), true);

console.log('packed Telegram attempt fence and exhaustion: ok');
