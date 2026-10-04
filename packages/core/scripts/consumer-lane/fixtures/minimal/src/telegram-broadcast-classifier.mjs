import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTelegramBroadcast } from 'stitchkit/telegram';

const root = await mkdtemp(join(tmpdir(), 'packed-broadcast-policy-'));
const base = (name, extra = {}) => ({
  name,
  directory: root,
  recipients: () => [1],
  send: async () => undefined,
  ...extra,
});
try {
  const attempts = [];
  const waits = [];
  let clock = 0;
  const retried = await runTelegramBroadcast(
    base('flood', {
      send: async ({ attempt }) => {
        attempts.push(attempt);
        if (attempt === 1) throw new Error('FLOOD_WAIT_2');
      },
      classify: () => ({ kind: 'retry-after', retryAfterMs: 2_000, reason: 'rate-limit' }),
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      maxRetryDelayMs: 2_000,
    }),
  );
  assert.equal(retried.delivered, 1);
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(waits, [2_000]);
  let unknownSends = 0;
  const unknown = base('unknown', {
    send: async () => {
      unknownSends++;
      throw new TypeError('unknown effect');
    },
  });
  assert.equal((await runTelegramBroadcast(unknown)).uncertain, 1);
  assert.equal((await runTelegramBroadcast(unknown)).uncertain, 1);
  assert.equal(unknownSends, 1);
  let budgetSends = 0;
  const halted = await runTelegramBroadcast(
    base('budget', {
      send: async () => {
        budgetSends++;
        throw new Error('wait');
      },
      classify: () => ({ kind: 'retry-after', retryAfterMs: 2_001 }),
      maxRetryDelayMs: 2_000,
      sleep: async () => {
        throw new Error('must not clamp the wait');
      },
    }),
  );
  assert.equal(halted.outcome, 'halted');
  assert.equal(halted.pending, 1);
  assert.equal(budgetSends, 1);
  const controller = new AbortController();
  let entered;
  const sleeping = new Promise((resolve) => {
    entered = resolve;
  });
  let sends = 0;
  const aborted = runTelegramBroadcast(
    base('abort', {
      signal: controller.signal,
      send: async () => {
        sends++;
        throw new Error('certified transient');
      },
      classify: () => ({ kind: 'transient' }),
      sleep: async (_, signal) => {
        assert.equal(signal, controller.signal);
        entered();
        await new Promise(() => undefined);
      },
    }),
  );
  await sleeping;
  controller.abort();
  assert.equal((await aborted).outcome, 'stopped');
  assert.equal(sends, 1);
  await assert.rejects(runTelegramBroadcast(base('invalid', { maxRetryDelayMs: Infinity })));
  console.log('packed injected broadcast classification: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
