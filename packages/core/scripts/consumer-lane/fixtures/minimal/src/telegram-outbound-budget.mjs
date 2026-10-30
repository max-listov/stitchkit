import assert from 'node:assert/strict';
import { classifyTelegramSendFailure, telegramOutboundBudget } from 'stitchkit/telegram';

/** A synchronous fake clock: the budget's own sleep seam moves time. */
function manualBudget(messagesPerSecond = 24) {
  let now = 0;
  return {
    get now() {
      return now;
    },
    budget: telegramOutboundBudget({
      token: `fixture-${crypto.randomUUID()}`,
      messagesPerSecond,
      now: () => now,
      sleep: async (milliseconds) => {
        // Let the send admitted at the current instant run before time moves.
        await Promise.resolve();
        now += milliseconds;
      },
    }),
  };
}

const first = manualBudget();
const times = [];
await Promise.all(
  Array.from({ length: 24 }, () =>
    first.budget.run('sendMessage', {}, undefined, async () => {
      times.push(first.now);
    }),
  ),
);
assert.equal(times.length, 24);
assert.equal(times[0], 0);
assert.ok(Math.abs((times[1] ?? 0) - 1_000 / 24) < 0.001);
assert.ok(Math.abs((times.at(-1) ?? 0) - (23 * 1_000) / 24) < 0.001);

const album = manualBudget();
let albumAt;
let ctaAt;
await album.budget.run('sendMediaGroup', { media: [1, 2, 3] }, undefined, async () => {
  albumAt = album.now;
});
await album.budget.run('sendMessage', {}, undefined, async () => {
  ctaAt = album.now;
});
assert.equal(albumAt, 0);
assert.ok(Math.abs((ctaAt ?? 0) - 125) < 0.001);

const limited = manualBudget();
const rateLimit = Object.assign(new Error('Too Many Requests'), {
  error_code: 429,
  description: 'Too Many Requests',
  parameters: { retry_after: 1 },
});
await limited.budget
  .run('sendMessage', {}, undefined, async () => {
    throw rateLimit;
  })
  .catch(() => undefined);
let afterPause;
await limited.budget.run('sendMessage', {}, undefined, async () => {
  afterPause = limited.now;
});
assert.equal(afterPause, 1_000);

const failure = classifyTelegramSendFailure({
  error_code: 400,
  description: 'Bad Request: USER_BOT_TO_BOT_DISABLED',
});
assert.equal(failure.reason, 'bot-to-bot-disabled');
assert.equal(failure.retryable, false);
assert.equal(failure.recipientUnreachable, false);

console.log('packed telegram outbound budget: ok');
