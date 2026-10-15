import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { runNativeCommand } from 'stitchkit/process';

/** Deterministic refusal, not a reproduction of a historical Darwin state. */
export async function verifySettlementDiagnostics(root) {
  const ps = join(root, 'ps');
  let group;
  const realKill = process.kill;
  const originalPath = process.env.PATH;
  const controller = new AbortController();
  process.env.PATH = `${root}:${originalPath}`;
  process.kill = (target, signal) => {
    // Only the observation of our owned group is injected. Actual termination
    // signals still reach the real child, which cannot survive this control.
    if (target === -group && signal === 0) return true;
    return realKill(target, signal);
  };
  try {
    const pending = runNativeCommand({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
      timeoutMs: 3000,
      cleanupTimeoutMs: 2000,
      signal: controller.signal,
      stop: { target: 'group', graceMs: 0 },
      onLeaderStarted({ pid }) {
        group = pid;
        const rows = Array(32).fill(`${pid} R`).join('\n');
        writeFileSync(
          ps,
          `#!/bin/sh\nif [ -f "$0.once" ]; then exit 73; fi\n: > "$0.once"\n/bin/cat <<'STATES'\n${rows}\nSTATES\n`,
          {
            mode: 0o755,
          },
        );
      },
      onOutput() {
        controller.abort(new Error('diagnostic control cancelled'));
      },
    });
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'COMMAND_CLEANUP');
      const rendered = inspect(error);
      assert.match(rendered, /"failure":"observation"/);
      assert.ok(rendered.includes(`"groupId":${group}`));
      assert.match(rendered, /"lastStates":\["R"/);
      assert.match(rendered, /"elapsedMs":/);
      assert.ok(rendered.includes(Array(16).fill('"R"').join(',')));
      assert.ok(!rendered.includes(Array(17).fill('"R"').join(',')));
      return true;
    });
    console.log('packed bounded settlement diagnostics: ok');
  } finally {
    process.kill = realKill;
    process.env.PATH = originalPath;
    await rm(ps, { force: true });
    await rm(`${ps}.once`, { force: true });
  }
}
