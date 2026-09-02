import { describe, expect, test } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDiagnosticJournal } from '../src/application/diagnostic-journal';
import type { DiagnosticJournalLimits } from '../src/application/diagnostic-journal-contract';
import {
  type DiagnosticJournalLockDiagnosis,
  readDiagnosticJournalLockDiagnosis,
} from '../src/application/diagnostic-journal-contract';
import {
  parsePlatformUuid,
  readDarwinPlatformUuid,
} from '../src/application/diagnostic-journal-lock';

const EventSchema = z.object({ message: z.string() }).strict();
const limits: DiagnosticJournalLimits = {
  maxEventBytes: 1_024,
  maxPendingItems: 8,
  maxPendingBytes: 8_192,
  maxFileBytes: 4_096,
  maxFiles: 2,
};

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'stitchkit-journal-lock-'));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A PID that is genuinely absent rather than one assumed to be.
 *
 * Spawning and reaping a process yields an identity the kernel has just released, which is what
 * the reclaim path has to recognise. Inventing a large number instead would test a guess about
 * the platform's PID range, and asserting on `kill` would test the mock.
 */
async function reapedPid(): Promise<number> {
  const child = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
  const { pid } = child;
  await child.exited;
  return pid;
}

function ownerRecord(owner: { pid: number; host?: string; machine?: string }): string {
  return `${JSON.stringify({
    pid: owner.pid,
    host: owner.host ?? hostname(),
    acquiredAt: new Date().toISOString(),
    ...(owner.machine !== undefined && { machine: owner.machine }),
  })}\n`;
}

/**
 * A machine renames itself; it does not become another machine.
 *
 * The test renames the name **recorded in the lock**, never the machine, because the failure this
 * covers is a live one: a Mac whose `os.hostname()` changed from `ml-mbp-m5.local` to
 * `ML-MBP-M5.ts.net lan` on a Tailscale transition was classified as foreign to itself, and a
 * supervisor restarted the service 127 times in 1h47m against a pid that had not existed for
 * hours.
 */
const FORMER_NAME = `${hostname()}-before-the-rename`;
const OUR_MACHINE = 'test-machine-identity';
const ANOTHER_MACHINE = 'a-genuinely-different-machine';

describe('diagnostic journal lock policy', () => {
  test('records its owner and still refuses a present lock by default', async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'diagnostic.jsonl');
      const config = { eventSchema: EventSchema, path, limits };
      const journal = await createDiagnosticJournal(config);

      const recorded: unknown = JSON.parse(await readFile(`${path}.lock`, 'utf8'));
      expect(recorded).toMatchObject({ pid: process.pid, host: hostname() });
      expect(journal.getStatus().lock).toEqual({
        policy: 'refuse',
        reclaimedStale: false,
      });

      await expect(createDiagnosticJournal(config)).rejects.toThrow();
      await expect(createDiagnosticJournal({ ...config, lock: 'refuse' })).rejects.toThrow();
      await journal.close();
    });
  });

  test('reclaims a lock whose recorded owner is provably gone, and says so', async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'diagnostic.jsonl');
      await writeFile(`${path}.lock`, ownerRecord({ pid: await reapedPid() }), {
        mode: 0o600,
      });

      const journal = await createDiagnosticJournal({
        eventSchema: EventSchema,
        path,
        limits,
        lock: 'reclaim-stale',
      });
      expect(journal.getStatus().lock).toEqual({
        policy: 'reclaim-stale',
        reclaimedStale: true,
      });

      // A reclaimed journal is a working journal, and it owns the lock it took.
      expect(journal.submit({ message: 'after-reclaim' }).outcome).toBe('accepted');
      await journal.flush();
      expect(JSON.parse(await readFile(`${path}.lock`, 'utf8'))).toMatchObject({
        pid: process.pid,
      });
      await journal.close();
      await expect(access(`${path}.lock`)).rejects.toThrow();
    });
  });

  test('refuses a live owner, an ownerless lock and another host under the same policy', async () => {
    await withDirectory(async (directory) => {
      const alive = join(directory, 'alive.jsonl');
      const ownerless = join(directory, 'ownerless.jsonl');
      const foreign = join(directory, 'foreign.jsonl');
      const reclaim = { eventSchema: EventSchema, limits, lock: 'reclaim-stale' } as const;

      // The case the lock exists for: a second writer while the first is running.
      await writeFile(`${alive}.lock`, ownerRecord({ pid: process.pid }), { mode: 0o600 });
      await expect(createDiagnosticJournal({ ...reclaim, path: alive })).rejects.toThrow();

      // A lock written before this policy existed proves nothing about its owner.
      await writeFile(`${ownerless}.lock`, '', { mode: 0o600 });
      await expect(createDiagnosticJournal({ ...reclaim, path: ownerless })).rejects.toThrow();

      // A dead PID on another machine is a live process here, or nothing at all; neither is
      // knowable from this host, so a shared filesystem never reclaims across it.
      await writeFile(
        `${foreign}.lock`,
        ownerRecord({ pid: await reapedPid(), host: `${hostname()}-elsewhere` }),
        { mode: 0o600 },
      );
      await expect(createDiagnosticJournal({ ...reclaim, path: foreign })).rejects.toThrow();
    });
  });

  describe('a renamed host is still this machine', () => {
    // The identity is declared rather than detected so the test states a machine's name without
    // depending on whether this kernel offers one, and so no global has to be restored afterwards.
    const identified = {
      eventSchema: EventSchema,
      limits,
      machineIdentity: OUR_MACHINE,
    } as const;

    test('reclaims a lock recorded under a name this machine no longer carries', async () => {
      await withDirectory(async (directory) => {
        const path = join(directory, 'renamed.jsonl');
        await writeFile(
          `${path}.lock`,
          ownerRecord({ pid: await reapedPid(), host: FORMER_NAME, machine: OUR_MACHINE }),
          { mode: 0o600 },
        );

        const journal = await createDiagnosticJournal({
          ...identified,
          path,
          lock: 'reclaim-stale',
        });
        expect(journal.getStatus().lock).toEqual({
          policy: 'reclaim-stale',
          reclaimedStale: true,
        });
        await journal.close();
      });
    });

    test('a live owner still refuses, under the old name and the new one alike', async () => {
      await withDirectory(async (directory) => {
        const reclaim = { ...identified, lock: 'reclaim-stale' } as const;
        for (const host of [FORMER_NAME, hostname()]) {
          const path = join(directory, `alive-${host.replaceAll(/\W/g, '-')}.jsonl`);
          await writeFile(
            `${path}.lock`,
            ownerRecord({ pid: process.pid, host, machine: OUR_MACHINE }),
            { mode: 0o600 },
          );
          await expect(createDiagnosticJournal({ ...reclaim, path })).rejects.toThrow();
        }
      });
    });

    test('a different machine identity is refused even when its pid is gone here', async () => {
      // The guarantee the host check was there for, now resting on identity: a pid recorded on
      // another machine is either nothing here or an unrelated live process, and neither answers
      // the question. This is the case a shared filesystem produces.
      await withDirectory(async (directory) => {
        const path = join(directory, 'elsewhere.jsonl');
        await writeFile(
          `${path}.lock`,
          ownerRecord({ pid: await reapedPid(), host: hostname(), machine: ANOTHER_MACHINE }),
          { mode: 0o600 },
        );
        await expect(
          createDiagnosticJournal({ ...identified, path, lock: 'reclaim-stale' }),
        ).rejects.toThrow();
      });
    });

    test('a lock written before the identity field falls back to the host name', async () => {
      // The stated rule for older locks: with nothing better to go on, the host name decides, and
      // a mismatch is reported as unattributable rather than as a foreign machine. It is the same
      // refusal as before — what changed is that the caller can now tell which one it got.
      await withDirectory(async (directory) => {
        const reclaim = { ...identified, lock: 'reclaim-stale' } as const;

        const matching = join(directory, 'legacy-same-name.jsonl');
        await writeFile(`${matching}.lock`, ownerRecord({ pid: await reapedPid() }), {
          mode: 0o600,
        });
        const journal = await createDiagnosticJournal({ ...reclaim, path: matching });
        expect(journal.getStatus().lock.reclaimedStale).toBe(true);
        await journal.close();

        const renamed = join(directory, 'legacy-other-name.jsonl');
        await writeFile(
          `${renamed}.lock`,
          ownerRecord({ pid: await reapedPid(), host: FORMER_NAME }),
          { mode: 0o600 },
        );
        await expect(createDiagnosticJournal({ ...reclaim, path: renamed })).rejects.toThrow();
      });
    });

    test('the refusal says which refusal it is', async () => {
      // "The owner is alive" and "this lock is not attributable to this host" are different facts
      // and used to be the same silence. The consumer that met the second printed "another process
      // is running against this state" — a sentence it had no evidence for.
      await withDirectory(async (directory) => {
        const reclaim = { ...identified, lock: 'reclaim-stale' } as const;
        const cases: Array<[string, string, DiagnosticJournalLockDiagnosis]> = [
          [
            'alive',
            ownerRecord({ pid: process.pid, machine: OUR_MACHINE }),
            { attribution: 'this-machine', liveness: 'alive', owner: null },
          ],
          [
            'legacy-foreign-name',
            ownerRecord({ pid: await reapedPid(), host: FORMER_NAME }),
            { attribution: 'unattributable', liveness: 'not-probed', owner: null },
          ],
          [
            'other-machine',
            ownerRecord({ pid: await reapedPid(), machine: ANOTHER_MACHINE }),
            { attribution: 'another-machine', liveness: 'not-probed', owner: null },
          ],
        ];

        for (const [name, record, expected] of cases) {
          const path = join(directory, `${name}.jsonl`);
          await writeFile(`${path}.lock`, record, { mode: 0o600 });
          const error = await createDiagnosticJournal({ ...reclaim, path }).then(
            () => undefined,
            (thrown: unknown) => thrown,
          );
          const diagnosis = readDiagnosticJournalLockDiagnosis(error);
          expect(diagnosis?.attribution).toBe(expected.attribution);
          expect(diagnosis?.liveness).toBe(expected.liveness);
          // The owner travels with the diagnosis, so a caller can name the pid it is waiting on
          // instead of describing a process it never identified.
          expect(diagnosis?.owner?.pid).toBeGreaterThan(0);
        }
      });
    });
  });

  test('a clean start under the reclaim policy reports no reclaim', async () => {
    await withDirectory(async (directory) => {
      const journal = await createDiagnosticJournal({
        eventSchema: EventSchema,
        path: join(directory, 'diagnostic.jsonl'),
        limits,
        lock: 'reclaim-stale',
      });
      expect(journal.getStatus().lock).toEqual({
        policy: 'reclaim-stale',
        reclaimedStale: false,
      });
      await journal.close();
    });
  });
});

/*
 * The macOS identity branch, proved off macOS.
 *
 * It is the branch that decides identity for the machines this policy was fixed for — the reported
 * crash-loop was a Mac — and until now nothing executed it: the only covered path was a declared
 * `machineIdentity`. `ioreg` exists on darwin alone, so the branch is reachable here through the
 * command seam, which is the whole reason the seam exists.
 */
describe('the darwin machine identity', () => {
  const DUMP = [
    '+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000241, registered, matched, active>',
    '    {',
    '      "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"',
    '      "IOPlatformUUID" = "1AB2C3D4-5E6F-7890-ABCD-EF1234567890"',
    '      "IOPlatformSerialNumber" = "C02XY1234567"',
    '    }',
  ].join('\n');

  async function withCommand(
    body: string,
    use: (command: string) => Promise<void>,
  ): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-ioreg-'));
    const command = join(directory, 'fake-ioreg');
    try {
      await writeFile(command, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      await use(command);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  test('reads IOPlatformUUID out of a registry dump', async () => {
    await withCommand(`cat <<'EOF'\n${DUMP}\nEOF`, async (command) => {
      expect(await readDarwinPlatformUuid(command)).toBe(
        '1AB2C3D4-5E6F-7890-ABCD-EF1234567890',
      );
    });
  });

  test('a dump without the key is no identity, not a wrong one', async () => {
    // The negative control. Without it, a parser that returned the first quoted string on the line
    // would pass the case above and answer `IOPolledInterface`'s text on a real Mac.
    expect(parsePlatformUuid(DUMP.replace('IOPlatformUUID', 'IOSomethingElse'))).toBeNull();
    expect(parsePlatformUuid('')).toBeNull();
  });

  test('a missing ioreg answers "no identity" rather than throwing', async () => {
    // The lock must survive a platform that cannot answer: `attribute` treats a null identity as
    // `unattributable`, which refuses, while a throw here would abort the acquisition itself.
    expect(await readDarwinPlatformUuid(join(tmpdir(), 'stitchkit-no-such-ioreg'))).toBeNull();
  });

  test('a registry read that hangs is abandoned, not waited on', async () => {
    // The bound is the point: a lock acquisition blocked on a wedged `ioreg` is the same outage the
    // policy exists to end. Asserted in elapsed time, because a null alone would also be returned
    // by a call that waited the full ten seconds first.
    await withCommand('sleep 10', async (command) => {
      const started = Date.now();
      expect(await readDarwinPlatformUuid(command)).toBeNull();
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });
});
