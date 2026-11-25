/**
 * `stitchkit/sync` and the SQLite migrations on the engine of a phone app: the
 * installed package bundled for the browser target, without `node:crypto` or a
 * driver. Execute a sync step and migrations against a recording ledger in the
 * real Hermes VM; check the same observations in the host runtime.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermesCompiler, resolveHermesVmBinary } from './hermes-vm.mjs';
import { syncStep } from './sync-hermes-client.mjs';

const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'stitchkit-sync-hermes-'));
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
try {
  const entry = fileURLToPath(new URL('./sync-hermes-vm-entry.mjs', import.meta.url));
  const output = join(root, 'sync.js');
  const built = run('bun', [
    'build',
    entry,
    '--target=browser',
    '--format=iife',
    '--outfile',
    output,
  ]);
  assert.equal(built.status, 0, built.stderr);
  assert.doesNotMatch(
    readFileSync(output, 'utf8'),
    /node:crypto|createHash|node:sqlite|bun:sqlite|node:async_hooks/,
  );
  const babel = await import('@babel/core');
  const transformed = await babel.transformFileAsync(output, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-async-generator-functions')],
  });
  assert.ok(transformed?.code, 'the async-generator transform emitted JavaScript');
  writeFileSync(output, transformed.code);
  const bytecode = join(root, 'sync.hbc');
  const compiled = run(hermesCompiler, ['-emit-binary', '-out', bytecode, output]);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.ok(statSync(bytecode).size > 0, 'the real compiler emitted bytecode');

  // The compiler refuses what a phone cannot run: a computed dynamic import.
  const negative = join(root, 'computed-import.js');
  writeFileSync(
    negative,
    "const peer = 'node:crypto'; globalThis.load = () => import(peer);\n",
  );
  const refused = run(hermesCompiler, [
    '-emit-binary',
    '-out',
    join(root, 'bad.hbc'),
    negative,
  ]);
  assert.notEqual(refused.status, 0, 'computed imports must be refused');

  const vm = resolveHermesVmBinary();
  if (vm.path) {
    const executed = run(vm.path, ['-w', bytecode]);
    assert.equal(executed.status, 0, executed.stderr);
    verifyStep(JSON.parse(executed.stdout));
    console.log('packed Hermes V1 VM sync and SQLite migration planning: ok');
  } else {
    console.log('packed Hermes V1 VM sync and SQLite migration planning: skipped locally');
  }
  verifyStep(syncStep());
  console.log('packed Hermes sync client: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}

function verifyStep(step) {
  assert.equal(step.sent[0]?.after, 5);
  assert.deepEqual(step.saved, [9]);
  assert.equal(step.batch.send.length, 1);
  assert.deepEqual(
    step.results.map((result) => [result.outcome, result.known]),
    [
      ['applied', true],
      ['retryable_failed', false],
    ],
  );
  assert.deepEqual(step.applied, [2, 10]);
  assert.deepEqual(step.replayed, []);
  assert.ok(step.executed.some((sql) => sql.startsWith('CREATE TABLE tasks')));
}
