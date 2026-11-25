import { describe, expect, test } from 'bun:test';
import {
  type DiagnosticJournalLockDiagnosis,
  formatDiagnosticJournalLockDiagnosis,
  readDiagnosticJournalLockDiagnosis,
} from '../src/entrypoints/application';

const SAMPLE_OWNER = {
  pid: 4242,
  host: 'node-a.internal',
  acquiredAt: '2026-11-23T10:00:00.000Z',
  machine: 'machine-uuid-1234',
} as const;

const ATTRIBUTIONS: readonly DiagnosticJournalLockDiagnosis['attribution'][] = [
  'this-machine',
  'another-machine',
  'unattributable',
];

const LIVENESSES: readonly DiagnosticJournalLockDiagnosis['liveness'][] = [
  'alive',
  'gone',
  'not-probed',
];

const IDENTITIES: readonly DiagnosticJournalLockDiagnosis['identity'][] = [
  undefined,
  'matched',
  'different-boot',
  'reused-pid',
  'pid-gone',
  'legacy',
  'unavailable',
  'descriptor-closed',
];

describe('formatDiagnosticJournalLockDiagnosis', () => {
  test('formats every combination of attribution x liveness x identity x owner without throwing or emitting fabricated labels', () => {
    for (const attribution of ATTRIBUTIONS) {
      for (const liveness of LIVENESSES) {
        for (const identity of IDENTITIES) {
          for (const owner of [null, SAMPLE_OWNER]) {
            const diagnosis: DiagnosticJournalLockDiagnosis = {
              attribution,
              liveness,
              owner,
              ...(identity !== undefined && { identity }),
            };
            const text = formatDiagnosticJournalLockDiagnosis(diagnosis);
            expect(typeof text).toBe('string');
            expect(text.length).toBeGreaterThan(15);
            expect(text.toLowerCase()).not.toContain('zombie');
            if (owner !== null) {
              expect(text).toContain('pid=4242');
              expect(text).toContain('host=node-a.internal');
            }
          }
        }
      }
    }
  });

  test('reports another-machine and unattributable truthfully without claiming liveness (I13)', () => {
    const remote = formatDiagnosticJournalLockDiagnosis({
      attribution: 'another-machine',
      liveness: 'not-probed',
      owner: SAMPLE_OWNER,
    });
    expect(remote).toContain('another machine');
    expect(remote).toContain('machine=machine-uuid-1234');
    expect(remote).toContain('not probed');
    expect(remote).not.toContain('actively held');

    const unreadable = formatDiagnosticJournalLockDiagnosis({
      attribution: 'unattributable',
      liveness: 'not-probed',
      owner: null,
    });
    expect(unreadable).toContain('missing or unreadable');
    expect(unreadable).toContain('not probed');

    const unattributableWithOwner = formatDiagnosticJournalLockDiagnosis({
      attribution: 'unattributable',
      liveness: 'not-probed',
      owner: { pid: 99, host: 'renamed-host', acquiredAt: '2026-11-23T09:00:00.000Z' },
    });
    expect(unattributableWithOwner).toContain('cannot be attributed to this machine');
    expect(unattributableWithOwner).toContain('not probed');
    expect(unattributableWithOwner).not.toContain('actively held');
  });

  test('distinguishes verified live holder from reused-pid, legacy, unavailable, descriptor-closed, different-boot, and pid-gone (I13)', () => {
    const matchedAlive = formatDiagnosticJournalLockDiagnosis({
      attribution: 'this-machine',
      liveness: 'alive',
      identity: 'matched',
      owner: SAMPLE_OWNER,
    });
    expect(matchedAlive).toContain('actively held');
    expect(matchedAlive).toContain('matching kernel process identity');

    const reusedPid = formatDiagnosticJournalLockDiagnosis({
      attribution: 'this-machine',
      liveness: 'gone',
      identity: 'reused-pid',
      owner: SAMPLE_OWNER,
    });
    expect(reusedPid).toContain('reused');
    expect(reusedPid).toContain('original owner is gone');
    expect(reusedPid).not.toContain('actively held');

    // Legacy alive PID MUST NOT claim it is proven to be the same holder
    const legacyAlive = formatDiagnosticJournalLockDiagnosis({
      attribution: 'this-machine',
      liveness: 'alive',
      identity: 'legacy',
      owner: SAMPLE_OWNER,
    });
    expect(legacyAlive).toContain('without kernel process identity');
    expect(legacyAlive).toContain('cannot prove');
    expect(legacyAlive).not.toContain('actively held');

    const unavailable = formatDiagnosticJournalLockDiagnosis({
      attribution: 'this-machine',
      liveness: 'not-probed',
      identity: 'unavailable',
      owner: SAMPLE_OWNER,
    });
    expect(unavailable).toContain('unavailable');
    expect(unavailable).not.toContain('actively held');

    const descriptorClosed = formatDiagnosticJournalLockDiagnosis({
      attribution: 'this-machine',
      liveness: 'gone',
      identity: 'descriptor-closed',
      owner: SAMPLE_OWNER,
    });
    expect(descriptorClosed).toContain('no open descriptor');
    expect(descriptorClosed).not.toContain('actively held');

    const differentBoot = formatDiagnosticJournalLockDiagnosis({
      attribution: 'this-machine',
      liveness: 'gone',
      identity: 'different-boot',
      owner: SAMPLE_OWNER,
    });
    expect(differentBoot).toContain('prior boot');
    expect(differentBoot).not.toContain('actively held');

    const pidGone = formatDiagnosticJournalLockDiagnosis({
      attribution: 'this-machine',
      liveness: 'gone',
      identity: 'pid-gone',
      owner: SAMPLE_OWNER,
    });
    expect(pidGone).toContain('no longer running');
    expect(pidGone).not.toContain('actively held');

    // Undefined identity with liveness: 'alive' must also avoid claiming verified ownership
    const noIdentityAlive = formatDiagnosticJournalLockDiagnosis({
      attribution: 'this-machine',
      liveness: 'alive',
      owner: SAMPLE_OWNER,
    });
    expect(noIdentityAlive).toContain('without kernel process identity');
    expect(noIdentityAlive).not.toContain('actively held');
  });

  test('integrates with readDiagnosticJournalLockDiagnosis on an EEXIST error', () => {
    const err = Object.assign(new Error('lock exists'), {
      code: 'EEXIST',
      journalLock: {
        attribution: 'this-machine',
        liveness: 'alive',
        identity: 'matched',
        owner: SAMPLE_OWNER,
      } satisfies DiagnosticJournalLockDiagnosis,
    });
    const diagnosis = readDiagnosticJournalLockDiagnosis(err);
    expect(diagnosis).toBeDefined();
    if (diagnosis === undefined) throw new Error('expected diagnosis');
    const formatted = formatDiagnosticJournalLockDiagnosis(diagnosis);
    expect(formatted).toContain('actively held');
    expect(formatted).toContain('pid=4242');
    expect(formatted).toContain('acquiredAt=2026-11-23T10:00:00.000Z');
  });
});
