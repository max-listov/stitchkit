import { expect, test } from 'bun:test';
import { createCommandDeadline } from '../src/process/group';

test('a restarted command deadline grants its new budget from the restart', async () => {
  const deadline = createCommandDeadline(20, 'expired');
  await Bun.sleep(10);
  deadline.restart(40);
  await Bun.sleep(25);
  // 35 ms after creation: past the first budget, inside the restarted one.
  expect(deadline.signal.aborted).toBe(false);
  await Bun.sleep(30);
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.signal.reason).toBe('expired');
  deadline.cancel();
});

test('an expired command deadline stays expired when restarted', async () => {
  const deadline = createCommandDeadline(5, 'expired');
  await Bun.sleep(15);
  expect(deadline.signal.aborted).toBe(true);
  deadline.restart(1000);
  expect(deadline.signal.aborted).toBe(true);
  deadline.cancel();
  expect(() => deadline.restart(0)).toThrow(RangeError);
});
