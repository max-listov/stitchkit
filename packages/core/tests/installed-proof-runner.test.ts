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

test('the pool never exceeds its width and starts the long proofs first', async () => {
  let active = 0;
  let widest = 0;
  const started: InstalledConsumerProof[] = [];
  await runInstalledConsumerProofs({
    fixture: 'minimal',
    platform: 'linux',
    uid: 1000,
    concurrency: 3,
    run: async (proof) => {
      started.push(proof);
      active += 1;
      widest = Math.max(widest, active);
      await Bun.sleep(1);
      active -= 1;
      return proof.marker;
    },
    verdict: () => undefined,
  });
  expect(started).toHaveLength(runs);
  expect(widest).toBe(3);
  const firstShort = started.findIndex((proof) => proof.long !== true);
  expect(firstShort).toBeGreaterThan(0);
  expect(started.slice(firstShort).some((proof) => proof.long === true)).toBe(false);
});

test('a failure starts nothing new, lets proofs in flight settle and is thrown', async () => {
  const settled: string[] = [];
  let starts = 0;
  const outcome = runInstalledConsumerProofs({
    fixture: 'minimal',
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
