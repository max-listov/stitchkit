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
  let killed = false;
  const realKill = process.kill;
  const originalPath = process.env.PATH;
  const controller = new AbortController();
  process.env.PATH = `${root}:${originalPath}`;
  process.kill = (target, signal) => {
    // The first KILL really terminates our child. Further group probes and
    // re-signals model the same synthetic live group until ps refuses it;
    // they must not signal a now-reusable id of a child we already killed.
    if (target === -group && signal === 0) return true;
    if (target === -group && signal === 'SIGKILL' && killed) return true;
    const sent = realKill(target, signal);
    if (target === -group && signal === 'SIGKILL') killed = true;
    return sent;
  };
  try {
    const pending = runNativeCommand({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
      timeoutMs: 3000,
      cleanupTimeoutMs: 2000,
      signal: controller.signal,
      // Skip SIGTERM: a cooperative exit before SIGKILL legitimately bypasses
      // settlement observation. This control must reach the injected observer.
      stop: { target: 'group', graceMs: 0, killOn: controller.signal },
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
      assert.equal(killed, true, 'the real owned child received SIGKILL');
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
