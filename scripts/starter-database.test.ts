import { describe, expect, test } from 'bun:test';
import {
  LANE_NAMESPACE,
  LANE_SWEEP_ENABLED,
  laneNamespace,
  laneNamespaceDigest,
  laneOwnerPid,
  laneRecordStem,
  selectAbandonedLaneRecords,
} from './starter-database';

// The namespace this boot stamps into every name it creates.
const here = LANE_NAMESPACE;
const elsewhere = here === 'aaaaaaaa' ? 'bbbbbbbb' : 'aaaaaaaa';
const dead = 999_001;
const alive = 999_002;
const isAlive = (pid: number) => pid === alive;

const record = (name: string, connections = 0) => ({ name, connections });

describe('the namespace is what makes a pid readable', () => {
  const bootId = 'e4f0a2c8-1111-2222-3333-444455556666';

  test('two containers of one kernel do not share a namespace', () => {
    // The defect. `boot_id` is a property of the KERNEL, and containers of one
    // kernel share it while having separate pid namespaces — so a live
    // neighbour's pid looked dead from here, and its idle database became a
    // `DROP DATABASE` candidate.
    const host = laneNamespaceDigest({ bootId, pidNamespace: 'pid:[4026531836]' });
    const container = laneNamespaceDigest({ bootId, pidNamespace: 'pid:[4026532187]' });
    expect(host).toBeDefined();
    expect(container).toBeDefined();
    expect(container).not.toBe(host);
  });

  test("a neighbour's record is not a candidate, however dead its pid looks", () => {
    const container = laneNamespaceDigest({ bootId, pidNamespace: 'pid:[4026532187]' });
    expect(
      selectAbandonedLaneRecords(
        [record(`sk_lane_${container}_${dead}_target_ab12_db`)],
        () =>
          // Answered from a namespace where that pid genuinely does not exist.
          false,
      ),
    ).toEqual([]);
  });

  test('the same boot and the same namespace is the same identity', () => {
    expect(laneNamespaceDigest({ bootId, pidNamespace: 'pid:[4026531836]' })).toBe(
      laneNamespaceDigest({ bootId, pidNamespace: 'pid:[4026531836]' }),
    );
  });

  test('a missing fact proves nothing, and nothing is what it returns', () => {
    // Both facts are required. The version this replaced took either one via
    // `??`, which is how the promise ("machine-id and boot-id") and the code
    // ("whichever is readable") came apart on a destructive operation.
    expect(laneNamespaceDigest({ bootId, pidNamespace: undefined })).toBeUndefined();
    expect(
      laneNamespaceDigest({ bootId: undefined, pidNamespace: 'pid:[1]' }),
    ).toBeUndefined();
  });

  test('this machine can prove its own identity', () => {
    // If it could not, the sweep would be off here — worth knowing, because a
    // silently disabled sweep is how the leaked databases came back.
    expect(LANE_SWEEP_ENABLED).toBeTrue();
    expect(LANE_NAMESPACE).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('a lane name says who created it', () => {
  test('the pid is read out of the name of both objects a lane creates', () => {
    expect(laneOwnerPid(`sk_lane_${here}_12345_target_deadbeef_db`)).toBe(12345);
    expect(laneOwnerPid(`sk_lane_${here}_12345_target_deadbeef_role`)).toBe(12345);
  });

  test('a name from somewhere else has no owner and no stem', () => {
    // Everything downstream refuses to touch what it cannot read, so this is
    // the guard that keeps the sweep off a database nobody here created.
    for (const name of ['postgres', `sk_lane_${here}_x_target_db`, 'app_production', '']) {
      expect(laneOwnerPid(name)).toBeUndefined();
      expect(laneRecordStem(name)).toBeUndefined();
    }
  });

  test('a role and its database share one stem', () => {
    expect(laneRecordStem(`sk_lane_${here}_7_target_ab12_db`)).toBe(
      `sk_lane_${here}_7_target_ab12`,
    );
    expect(laneRecordStem(`sk_lane_${here}_7_target_ab12_role`)).toBe(
      `sk_lane_${here}_7_target_ab12`,
    );
  });
});

describe('abandoned is decided on two facts, never on one', () => {
  test('a dead creator and no connections is the only case that is swept', () => {
    expect(
      selectAbandonedLaneRecords([record(`sk_lane_${here}_${dead}_target_ab12_db`)], isAlive),
    ).toEqual([`sk_lane_${here}_${dead}_target_ab12_db`]);
  });

  test('a live sibling run survives its neighbour housekeeping', () => {
    // The whole reason this is not a `DROP … LIKE 'sk_lane_%'`: two lanes share
    // one PostgreSQL, and the second one starting must not delete the first
    // one's database out from under it.
    expect(
      selectAbandonedLaneRecords([record(`sk_lane_${here}_${alive}_target_ab12_db`)], isAlive),
    ).toEqual([]);
  });

  test('a database still in use is left alone even when its creator is gone', () => {
    // The role outlived the lane that started it — that is a process to reap,
    // not a database to drop from under a live connection.
    expect(
      selectAbandonedLaneRecords(
        [record(`sk_lane_${here}_${dead}_target_ab12_db`, 2)],
        isAlive,
      ),
    ).toEqual([]);
  });

  test('an idle lane between steps is not mistaken for a dead one', () => {
    // A run holds no connection at all while it installs dependencies, so
    // "nobody is connected" alone would delete a database in the middle of a
    // live run. The liveness of the creator is what separates them.
    expect(
      selectAbandonedLaneRecords(
        [record(`sk_lane_${here}_${alive}_target_ab12_db`, 0)],
        isAlive,
      ),
    ).toEqual([]);
  });

  test('a record from another machine or another boot is never a candidate', () => {
    // The reason the namespace is in the NAME. A pid is a fact about one
    // running kernel: through an SSH tunnel, a port-forward or a container
    // bridge, a live sibling's pid looks dead from here, and its database sits
    // at zero connections for minutes at a time while it installs.
    expect(
      selectAbandonedLaneRecords(
        [record(`sk_lane_${elsewhere}_${dead}_target_ab12_db`)],
        () => false,
      ),
    ).toEqual([]);
    expect(laneNamespace(`sk_lane_${elsewhere}_${dead}_target_ab12_db`)).toBe(elsewhere);
  });

  test('this process never sweeps its own records', () => {
    expect(
      selectAbandonedLaneRecords(
        [record(`sk_lane_${here}_${process.pid}_target_ab12_db`)],
        () => false,
      ),
    ).toEqual([]);
  });

  test('a database that is not a lane database is never a candidate', () => {
    expect(
      selectAbandonedLaneRecords(
        [record('postgres'), record('app_production'), record('template1')],
        () => false,
      ),
    ).toEqual([]);
  });

  test('a mixed list yields exactly the abandoned names', () => {
    expect(
      selectAbandonedLaneRecords(
        [
          record(`sk_lane_${here}_${dead}_target_ab12_db`),
          record(`sk_lane_${here}_${alive}_target_cd34_db`),
          record(`sk_lane_${here}_${dead}_head_ef56_db`, 1),
          record(`sk_lane_${here}_${dead}_agent_store_7890_db`),
          record('postgres'),
        ],
        isAlive,
      ),
    ).toEqual([
      `sk_lane_${here}_${dead}_target_ab12_db`,
      `sk_lane_${here}_${dead}_agent_store_7890_db`,
    ]);
  });
});
