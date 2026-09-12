import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBubblewrapSandboxBackend } from 'stitchkit/agent-runtime/sandbox';

const root = await mkdtemp(join(tmpdir(), 'packed-sandbox-'));
try {
  if (process.platform !== 'linux') {
    await assert.rejects(
      createBubblewrapSandboxBackend({
        stateDirectory: root,
        onBrokerError(cause) {
          console.error(cause);
        },
      }),
      { code: 'SANDBOX_UNAVAILABLE' },
    );
  } else {
    const backend = await createBubblewrapSandboxBackend({
      stateDirectory: root,
      onBrokerError(cause) {
        console.error(cause);
      },
    });
    const template = await backend.prewarm({ template: 'packed' });
    const probe = spawnSync('/usr/bin/bwrap', [
      '--unshare-all',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/lib',
      '/lib',
      '--ro-bind',
      '/lib64',
      '/lib64',
      '--',
      '/usr/bin/true',
    ]);
    if (probe.status !== 0) {
      await assert.rejects(
        backend.create({ template: template.templateKey, network: 'deny-all' }),
        { code: 'SANDBOX_UNAVAILABLE' },
      );
    } else {
      const handle = await backend.create({
        template: template.templateKey,
        network: 'deny-all',
      });
      try {
        await handle.session.writeTextFile('value', 'packed artifact');
        const state = handle.captureState();
        await handle.stop();
        const next = await backend.create({
          template: template.templateKey,
          state,
          network: 'deny-all',
        });
        try {
          assert.equal(await next.session.readTextFile('value'), 'packed artifact');
        } finally {
          await next.delete();
        }
      } finally {
        await handle.stop();
      }
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('packed sandbox backend: ok');
