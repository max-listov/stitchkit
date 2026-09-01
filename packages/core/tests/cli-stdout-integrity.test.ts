import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Importing the CLI surface must not truncate the process's stdout.
 *
 * `import process from 'node:process'` switches Bun's stdout to the Node-compatible stream, and a
 * large `console.log` then loses everything past 64 KiB when the reader is slow — silently, exit
 * code 0, empty stderr. The consumer that reported it had a `--json` transcript cut mid-document
 * and spent the search on its transport, because nothing in the failing process had called a CLI
 * command at all: the module only had to be in the graph.
 *
 * The root cause is the runtime's, not ours. The fix is to stop triggering it — the import bought
 * nothing, since the global `process` is the same object — and this test pins that we do not
 * reacquire it by habit.
 *
 * The slow reader is the whole experiment. With a fast one the tail usually survives, which is
 * why the defect reached a consumer looking like "sometimes broken JSON" rather than a bug.
 */
async function bytesThroughSlowReader(source: string): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), 'sk-stdout-'));
  try {
    const file = join(directory, 'probe.ts');
    await writeFile(file, source);
    // The reader has to be a real pipe whose consumer does not open for two seconds. Reading the
    // child's stdout from inside this process does NOT reproduce it — measured: the truncation
    // needs the shell pipeline the defect was found with, and an approximation of it stays green
    // on a broken build, which is worse than no test.
    const shell = Bun.spawn(['sh', '-c', `bun ${file} | (sleep 2; wc -c)`], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = await new Response(shell.stdout).text();
    await shell.exited;
    return Number(text.trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const PAYLOAD = "const big = 'x'.repeat(200_000);\nconsole.log(big);\n";
const CLI = join(import.meta.dir, '../src/cli.ts');

describe('importing the CLI surface leaves stdout intact', () => {
  test('a large write survives the import, and the control proves the probe can fail', async () => {
    const withoutImport = await bytesThroughSlowReader(PAYLOAD);
    // The denominator: if the harness could not deliver 200 001 bytes even without the import,
    // the assertion below would pass for the wrong reason.
    expect(withoutImport).toBe(200_001);

    const withImport = await bytesThroughSlowReader(`import '${CLI}';\n${PAYLOAD}`);
    expect(withImport).toBe(200_001);
  }, 30_000);
});
