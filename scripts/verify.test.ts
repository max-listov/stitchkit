import { expect, test } from 'bun:test';
import { runBounded } from './verify';

test('bounded release lanes never exceed the declared local concurrency', async () => {
  let active = 0;
  let peak = 0;
  const completed: string[] = [];
  await runBounded(['a', 'b', 'c', 'd', 'e'], 2, async (step) => {
    active += 1;
    peak = Math.max(peak, active);
    await Bun.sleep(5);
    completed.push(step);
    active -= 1;
  });
  expect(peak).toBe(2);
  expect(completed.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
});
