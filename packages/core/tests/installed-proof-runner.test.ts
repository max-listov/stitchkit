import { expect, test } from 'bun:test';
import { runInstalledConsumerProofs } from '../scripts/consumer-lane/installed-proof-runner';
import {
  type InstalledConsumerProof,
  installedConsumerProofs,
} from '../scripts/consumer-lane/installed-proofs';

const minimal = installedConsumerProofs.filter(
  (proof) => proof.fixture === 'minimal' && proof.platforms.includes('linux'),
);
const runs = minimal.reduce(
  (total, proof) => total + (proof.kind === 'declarations' ? 1 : proof.runtimes.length),
  0,
);

test('the pool never exceeds its width and starts the longest proofs first', async () => {
  let active = 0;
  let widest = 0;
  const started: InstalledConsumerProof[] = [];
  await runInstalledConsumerProofs({
    fixture: 'minimal',
    platform: 'linux',
    uid: 1000,
    concurrency: 3,
    run: async (proof) => {
      if (proof.idle === true) return proof.marker;
      started.push(proof);
      active += 1;
      widest = Math.max(widest, active);
      await Bun.sleep(1);
      active -= 1;
      return proof.marker;
    },
    verdict: () => undefined,
  });
  expect(started).toHaveLength(runs - minimal.filter((proof) => proof.idle === true).length);
  expect(widest).toBe(3);
  const expected = started.map((proof) => proof.expectedMs ?? 0);
  expect(expected[0]).toBe(Math.max(...expected));
  expect(expected[0]).toBeGreaterThan(0);
  expect(expected).toEqual([...expected].sort((a, b) => b - a));
});

test('a failure starts nothing new, lets proofs in flight settle and is thrown', async () => {
  const settled: string[] = [];
  let starts = 0;
  const outcome = runInstalledConsumerProofs({
    fixture: 'node',
    platform: 'linux',
    uid: 1000,
    concurrency: 2,
    run: async (proof, runtime) => {
      starts += 1;
      if (starts === 1) {
        await Bun.sleep(1);
        throw new Error(`refused ${proof.id}/${runtime}`);
      }
      await Bun.sleep(20);
      settled.push(`${proof.id}/${runtime}`);
      return proof.marker;
    },
    verdict: () => undefined,
  });
  await expect(outcome).rejects.toThrow('refused');
  expect(starts).toBe(2);
  expect(settled).toHaveLength(1);
});

test('one proof at a time remains the default', async () => {
  let active = 0;
  let widest = 0;
  await runInstalledConsumerProofs({
    fixture: 'minimal',
    platform: 'linux',
    uid: 1000,
    run: async (proof) => {
      active += 1;
      widest = Math.max(widest, active);
      await Bun.sleep(0);
      active -= 1;
      return proof.marker;
    },
    verdict: () => undefined,
  });
  expect(widest).toBe(1);
});

test('an exclusive proof runs with nothing else in flight', async () => {
  const node = installedConsumerProofs.filter(
    (proof) => proof.fixture === 'node' && proof.platforms.includes('darwin'),
  );
  expect(node.some((proof) => proof.exclusive === true)).toBe(true);
  let active = 0;
  const besideExclusive: number[] = [];
  await runInstalledConsumerProofs({
    fixture: 'node',
    platform: 'darwin',
    uid: 501,
    concurrency: 4,
    run: async (proof) => {
      active += 1;
      if (proof.exclusive === true) besideExclusive.push(active - 1);
      await Bun.sleep(1);
      active -= 1;
      return proof.marker;
    },
    verdict: () => undefined,
  });
  expect(besideExclusive.length).toBeGreaterThan(0);
  expect(besideExclusive.every((others) => others === 0)).toBe(true);
});

test('an idle proof starts first and may run beside an exclusive one', async () => {
  const running = new Set<string>();
  const besideExclusive: string[][] = [];
  const order: string[] = [];
  let releaseIdle = (): void => undefined;
  const idleHeld = new Promise<void>((resolve) => {
    releaseIdle = resolve;
  });
  await runInstalledConsumerProofs({
    fixtures: ['minimal'],
    platform: 'darwin',
    uid: 501,
    concurrency: 3,
    run: async (proof, runtime) => {
      const key = `${proof.id}/${runtime}`;
      order.push(key);
      running.add(key);
      if (proof.exclusive === true)
        besideExclusive.push([...running].filter((k) => k !== key));
      if (proof.idle === true) await idleHeld;
      else await Bun.sleep(1);
      running.delete(key);
      if (proof.exclusive === true) releaseIdle();
      return proof.marker;
    },
    verdict: () => undefined,
  });
  const idle = installedConsumerProofs.find((proof) => proof.idle === true);
  expect(idle).toBeDefined();
  expect(order[0]).toBe(`${idle?.id}/node`);
  expect(besideExclusive.length).toBeGreaterThan(0);
  expect(besideExclusive[0]).toEqual([`${idle?.id}/node`]);
  for (const others of besideExclusive)
    expect(others.every((key) => key === `${idle?.id}/node`)).toBe(true);
});

test('several fixtures share one pool and no other fixture runs', async () => {
  const fixtures = new Set<string>();
  await runInstalledConsumerProofs({
    fixtures: ['minimal', 'node'],
    platform: 'linux',
    uid: 1000,
    concurrency: 4,
    run: async (proof) => {
      fixtures.add(proof.fixture);
      return proof.marker;
    },
    verdict: () => undefined,
  });
  expect([...fixtures].sort()).toEqual(['minimal', 'node']);
});
