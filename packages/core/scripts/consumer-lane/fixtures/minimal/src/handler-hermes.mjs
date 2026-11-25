/**
 * Portable `stitchkit/handler` + `serveBridge` + `createBridgeFetch` on Hermes V1:
 * 1. Packs the installed package with `--target=browser --format=iife`, runs the
 *    React Native 0.88 Babel transforms (async generators + block scoping), compiles
 *    with real `hermesc` (Hermes V1), and verifies computed dynamic imports are refused.
 * 2. Executes the compiled Hermes V1 bytecode (`.hbc`) inside the real Hermes V1 VM
 *    (`hermes`) with an RN 0.88 globals prelude (`whatwg-fetch@3.6.20`, RN URL model,
 *    `AbortController`, `crypto.getRandomValues`, no `DOMException`/`Buffer`/`node:*`)
 *    and proves a live `createClient` -> `createBridgeFetch` -> `serveBridge` ->
 *    `createHandler` round-trip plus a negative control (`process.hrtime.bigint()` fails
 *    inside the VM naming the missing symbol).
 * 3. When `STITCHKIT_REQUIRE_HERMES_VM=1` or `STITCHKIT_HERMES_VM` is set, a
 *    missing or non-functional Hermes V1 VM binary fails the proof loudly.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostAndClient } from './handler-hermes-graph.mjs';
import { hermesCompiler, resolveHermesVmBinary, rnPreludeSource } from './hermes-vm.mjs';

const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'stitchkit-handler-hermes-'));
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });

try {
  const babel = await import('@babel/core');
  const babelPlugins = [
    require.resolve('@babel/plugin-transform-async-generator-functions'),
    require.resolve('@babel/plugin-transform-block-scoping'),
  ];

  // 1. Compiler + graph proof (retains barrel exports and hermesc checks).
  const entry = fileURLToPath(new URL('./handler-hermes-graph.mjs', import.meta.url));
  const output = join(root, 'handler.js');
  const built = run('bun', [
    'build',
    entry,
    '--target=browser',
    '--format=iife',
    '--outfile',
    output,
  ]);
  assert.equal(built.status, 0, built.stderr);
  const bundled = readFileSync(output, 'utf8');
  assert.doesNotMatch(bundled, /node:async_hooks|node:fs|node:crypto|process\.hrtime/);

  const transformed = await babel.transformFileAsync(output, {
    babelrc: false,
    configFile: false,
    plugins: babelPlugins,
  });
  assert.ok(transformed?.code, 'the Hermes Babel transforms emitted JavaScript');
  writeFileSync(output, transformed.code);

  const bytecode = join(root, 'handler.hbc');
  const compiled = run(hermesCompiler, ['-emit-binary', '-out', bytecode, output]);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.ok(statSync(bytecode).size > 0, 'the real Hermes V1 compiler emitted bytecode');

  const negative = join(root, 'computed-import.js');
  writeFileSync(
    negative,
    "const mod = 'node:async_hooks'; globalThis.load = () => import(mod);\n",
  );
  const refused = run(hermesCompiler, [
    '-emit-binary',
    '-out',
    join(root, 'bad.hbc'),
    negative,
  ]);
  assert.notEqual(refused.status, 0, 'computed dynamic imports must be refused by hermesc');

  // 2. Real Hermes V1 VM execution + negative control.
  const vm = resolveHermesVmBinary();
  if (vm.path) {
    const vmEntry = fileURLToPath(new URL('./handler-hermes-vm-entry.mjs', import.meta.url));
    const vmBundle = join(root, 'handler-vm-raw.js');
    const vmBuilt = run('bun', [
      'build',
      vmEntry,
      '--target=browser',
      '--format=iife',
      '--outfile',
      vmBundle,
    ]);
    assert.equal(vmBuilt.status, 0, vmBuilt.stderr);
    const vmRaw = readFileSync(vmBundle, 'utf8');
    assert.doesNotMatch(vmRaw, /node:async_hooks|node:fs|node:crypto|process\.hrtime/);

    const vmTransformed = await babel.transformFileAsync(vmBundle, {
      babelrc: false,
      configFile: false,
      plugins: babelPlugins,
    });
    assert.ok(vmTransformed?.code, 'the Hermes VM bundle transformed cleanly');

    const prelude = rnPreludeSource();
    const combinedSource = join(root, 'handler-vm-all.js');
    writeFileSync(combinedSource, `${prelude}\n${vmTransformed.code}\n`);

    const vmBytecode = join(root, 'handler-vm.hbc');
    const vmCompiled = run(hermesCompiler, [
      '-emit-binary',
      '-out',
      vmBytecode,
      combinedSource,
    ]);
    assert.equal(vmCompiled.status, 0, vmCompiled.stderr);
    assert.ok(statSync(vmBytecode).size > 0, 'hermesc emitted runnable VM bytecode');

    const vmExecuted = run(vm.path, ['-w', vmBytecode]);
    assert.equal(
      vmExecuted.status,
      0,
      `Hermes V1 VM execution failed (exit ${vmExecuted.status}, signal ${vmExecuted.signal}, error ${vmExecuted.error?.message ?? 'none'}):\nstdout: ${vmExecuted.stdout}\nstderr: ${vmExecuted.stderr}`,
    );
    assert.ok(
      vmExecuted.stdout.split(/\r?\n/).includes('HERMES_VM_ROUNDTRIP_OK'),
      `Hermes V1 VM did not emit round-trip marker:\nstdout: ${vmExecuted.stdout}\nstderr: ${vmExecuted.stderr}`,
    );

    // Negative control: `process.hrtime.bigint()` must fail inside the real Hermes V1 VM
    // AFTER the RN prelude completes. Neutral filenames ensure the path itself cannot
    // satisfy the error assertion via debug stack frames.
    const negSource = join(root, 'negative-control.js');
    writeFileSync(
      negSource,
      `${prelude}\nprint('PRELUDE_READY');\nvar t = process.hrtime.bigint();\nprint('UNEXPECTED_NEGATIVE_OK ' + t);\n`,
    );
    const negBytecode = join(root, 'negative-control.hbc');
    const negCompiled = run(hermesCompiler, ['-emit-binary', '-out', negBytecode, negSource]);
    assert.equal(negCompiled.status, 0, negCompiled.stderr);
    const negExecuted = run(vm.path, ['-w', negBytecode]);
    const negOutput = `${negExecuted.stdout}\n${negExecuted.stderr}`;
    assert.notEqual(
      negExecuted.status,
      0,
      `process.hrtime.bigint() must fail in Hermes V1 VM:\n${negOutput}`,
    );
    assert.ok(
      negExecuted.stdout.split(/\r?\n/).includes('PRELUDE_READY'),
      `RN prelude failed before reaching process.hrtime.bigint():\n${negOutput}`,
    );
    assert.doesNotMatch(negOutput, /UNEXPECTED_NEGATIVE_OK/);
    const firstErrorLine =
      negOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith('Uncaught ')) ?? '';
    assert.match(
      firstErrorLine,
      /^Uncaught TypeError:.*bigint/i,
      `Hermes V1 VM error line must name missing bigint on undefined hrtime, got "${firstErrorLine}":\n${negOutput}`,
    );
    console.log('packed Hermes V1 VM execution: ok');
  } else {
    console.log(
      'packed Hermes V1 VM execution: skipped locally (set STITCHKIT_HERMES_VM or run bun scripts/ensure-hermes-vm.ts)',
    );
  }

  // 3. MessageChannel bridge protocol control in the host runtime.
  const pair = createHostAndClient();
  try {
    // Allow the initial MessageChannel `hello` frame to deliver before firing requests.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await pair.client.ping(), { pong: true });
    assert.deepEqual(await pair.client.echo({ text: 'Привет 🚀' }), { echoed: 'Привет 🚀' });
  } finally {
    pair.close();
  }
  console.log('packed Hermes portable handler and bridge: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
