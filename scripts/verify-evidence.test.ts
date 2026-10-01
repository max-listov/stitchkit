import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGreenGate, greenGateKey, readGreenGates } from './gate-memo';
import { saveGreenEvidence } from './verify-evidence';
import { FAST_GATE, FAST_STEPS, PROFILES, releaseProfile } from './verify-profiles';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verify-evidence-'));
  roots.push(root);
  return root;
}
const record = {
  tree: 'exact-tree',
  toolchain: 'bun:1 node:24 pg:18 browsers:chromium',
  at: '2026-10-01T00:00:00.000Z',
  commit: 'before-commit',
};
const runtime = 'bun:1 node:24';

test('a full gate certifies the fast subset without weakening its heavy environment key', async () => {
  const memo = join(await directory(), 'memo.json');
  await saveGreenEvidence(PROFILES.full, record, runtime, memo);
  const fast = await readGreenGates(FAST_GATE, memo);
  expect(
    findGreenGate(fast, greenGateKey({ tree: record.tree, toolchain: runtime })),
  ).toBeDefined();
  expect(
    findGreenGate(fast, greenGateKey({ tree: 'changed-tree', toolchain: runtime })),
  ).toBeUndefined();
  expect(
    findGreenGate(fast, greenGateKey({ tree: record.tree, toolchain: 'bun:2 node:24' })),
  ).toBeUndefined();
  const full = await readGreenGates(PROFILES.full.gate, memo);
  expect(findGreenGate(full, greenGateKey(record))).toBeDefined();
  expect(
    findGreenGate(
      full,
      greenGateKey({ ...record, toolchain: `${runtime} pg:19 browsers:chromium` }),
    ),
  ).toBeUndefined();
});

test('every selected release target certifies fast only after every fast step is included', async () => {
  for (const target of ['core', 'tui', 'create-stitchkit']) {
    const root = await directory();
    await writeFile(
      join(root, 'release-train.json'),
      JSON.stringify({
        schemaVersion: 1,
        releases: [{ target, version: '0.1.1' }],
      }),
    );
    const profile = await releaseProfile(root);
    expect(FAST_STEPS.every((step) => profile.steps.includes(step))).toBe(true);
    const memo = join(root, 'memo.json');
    await saveGreenEvidence(profile, record, runtime, memo);
    expect(await readGreenGates(FAST_GATE, memo)).toHaveLength(1);
  }
});

test('a HEAD-only gate and a profile missing lockfile cannot certify fast', async () => {
  for (const profile of [
    PROFILES.head,
    {
      gate: 'verify:release:incomplete',
      steps: ['lint', 'check', 'test', 'build'],
      usesLaneEnvironment: true,
    },
  ]) {
    const memo = join(await directory(), 'memo.json');
    await saveGreenEvidence(profile, record, runtime, memo);
    expect(await readGreenGates(FAST_GATE, memo)).toEqual([]);
  }
});
