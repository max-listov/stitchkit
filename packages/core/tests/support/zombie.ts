/** A real zombie process for a test of what proves a process gone, read by an oracle of its own. */
import { expect } from 'bun:test';
import { readFile } from 'node:fs/promises';

/** A real zombie: `perl` forks, the child exits, the parent never reaps it. */
export async function withZombie(body: (pid: number) => Promise<void>): Promise<void> {
  const parent = Bun.spawn(
    [
      'perl',
      '-e',
      'my $p = fork(); if ($p) { $| = 1; print "$p\\n"; sleep 60 } else { exit 0 }',
    ],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  try {
    const { value } = await parent.stdout.getReader().read();
    const pid = Number(new TextDecoder().decode(value ?? new Uint8Array()).trim());
    expect(Number.isInteger(pid)).toBe(true);

    // Wait for the STATE, never for a duration: the pid is printed before the child has exited,
    // and a fixture that starts measuring immediately measures a running process. Read
    // independently of the function under test — a fixture that polls its own subject proves
    // nothing about it.
    let waited = 0;
    while ((await stateOf(pid)) !== 'Z' && waited < 5_000) {
      await Bun.sleep(25);
      waited += 25;
    }
    expect(await stateOf(pid)).toBe('Z');
    await body(pid);
  } finally {
    parent.kill();
    await parent.exited;
  }
}

/** The independent oracle: `/proc` where it exists, `ps` elsewhere. */
async function stateOf(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat
      .slice(stat.lastIndexOf(')') + 1)
      .trimStart()
      .charAt(0);
  } catch {
    const ps = Bun.spawn(['ps', '-o', 'state=', '-p', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = await new Response(ps.stdout).text();
    await ps.exited;
    return text.trim().charAt(0) || null;
  }
}
