/**
 * `stitchkit/realtime` with `bindRealtimeClient` on the engine of a phone app:
 * 1. Walks the installed module graph from the subpath file by file, as Metro
 *    bundles it (no tree shaking): the root entry is not reached and no module
 *    holds a computed `import()`. Control: the same walk from the root entry
 *    finds its default peer loader.
 * 2. Bundles the client for the browser target, runs the React Native 0.88 Babel
 *    transforms, compiles with the real `hermesc` and executes the bytecode in the
 *    real Hermes V1 VM behind the RN 0.88 globals prelude. Control: the root
 *    entry's bundle is refused by the same compiler.
 * 3. When `STITCHKIT_REQUIRE_HERMES_VM=1` or `STITCHKIT_HERMES_VM` is set, a
 *    missing Hermes V1 VM binary fails the proof loudly.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermesCompiler, resolveHermesVmBinary, rnPreludeSource } from './hermes-vm.mjs';
import { bindSharedSocket, expectedBinding } from './realtime-hermes-client.mjs';

const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'stitchkit-realtime-hermes-'));
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
const babel = await import('@babel/core');
const babelPlugins = [
  require.resolve('@babel/plugin-transform-async-generator-functions'),
  require.resolve('@babel/plugin-transform-block-scoping'),
];

/** Dynamic `import()` specifiers that are not a literal, in one parsed module. */
function computedImports(ast) {
  const found = [];
  const literal = (node) =>
    node?.type === 'StringLiteral' ||
    (node?.type === 'TemplateLiteral' && node.expressions.length === 0);
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ImportExpression' && !literal(node.source))
      found.push(node.source?.type);
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Import' &&
      !literal(node.arguments[0])
    )
      found.push(node.arguments[0]?.type);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast.program);
  return found;
}

/** Every installed module Metro loads from `entry`, with the computed imports each holds. */
async function metroGraph(entry) {
  const dist = resolve(dirname(entry), '..');
  const modules = new Map();
  const visit = async (file) => {
    if (modules.has(file)) return;
    modules.set(file, []);
    const code = readFileSync(file, 'utf8');
    const ast = await babel.parseAsync(code, {
      babelrc: false,
      configFile: false,
      sourceType: 'module',
    });
    modules.set(file, computedImports(ast));
    for (const match of code.matchAll(/(?:import|from)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g))
      await visit(resolve(dirname(file), match[1]));
  };
  await visit(entry);
  return new Map([...modules].map(([file, found]) => [relative(dist, file), found]));
}

async function hermesSource(entry, name) {
  const output = join(root, `${name}.js`);
  const built = run('bun', [
    'build',
    entry,
    '--target=browser',
    '--format=iife',
    '--outfile',
    output,
  ]);
  assert.equal(built.status, 0, built.stderr);
  const transformed = await babel.transformFileAsync(output, {
    babelrc: false,
    configFile: false,
    plugins: babelPlugins,
  });
  assert.ok(transformed?.code, `the Hermes Babel transforms emitted ${name}`);
  return transformed.code;
}

try {
  // 1. The graph Metro bundles, module by module.
  const subpath = fileURLToPath(import.meta.resolve('stitchkit/realtime'));
  const rootEntry = fileURLToPath(import.meta.resolve('stitchkit'));
  const graph = await metroGraph(subpath);
  assert.ok(graph.size > 1, 'the walk followed the subpath into its chunks');
  assert.ok(!graph.has(relative(resolve(dirname(subpath), '..'), rootEntry)));
  assert.deepEqual(
    [...graph].filter(([, found]) => found.length > 0),
    [],
    'no module reachable from stitchkit/realtime holds a computed import()',
  );
  const rootGraph = await metroGraph(rootEntry);
  assert.ok(
    [...rootGraph.values()].some((found) => found.includes('Identifier')),
    'control: the root graph holds the computed default peer import',
  );

  // 2. The real compiler and the real VM.
  const vmEntry = fileURLToPath(new URL('./realtime-hermes-vm-entry.mjs', import.meta.url));
  const code = await hermesSource(vmEntry, 'realtime');
  assert.doesNotMatch(code, /SOCKET_IO_CLIENT|webpackIgnore/);
  const source = join(root, 'realtime-all.js');
  writeFileSync(source, `${rnPreludeSource()}\n${code}\n`);
  const bytecode = join(root, 'realtime.hbc');
  const compiled = run(hermesCompiler, ['-emit-binary', '-out', bytecode, source]);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.ok(statSync(bytecode).size > 0, 'the real Hermes V1 compiler emitted bytecode');

  const rootProbe = join(root, 'root-entry.mjs');
  // The installed root entry by its resolved path: the probe lives outside the consumer.
  writeFileSync(
    rootProbe,
    `import * as root from ${JSON.stringify(rootEntry)};\nglobalThis.rootSurface = Object.keys(root);\n`,
  );
  const rootSource = join(root, 'root-all.js');
  writeFileSync(rootSource, await hermesSource(rootProbe, 'root'));
  const refused = run(hermesCompiler, [
    '-emit-binary',
    '-out',
    join(root, 'root.hbc'),
    rootSource,
  ]);
  assert.notEqual(refused.status, 0, 'control: hermesc refuses the root entry bundle');
  assert.match(refused.stderr, /Invalid expression/);

  const vm = resolveHermesVmBinary();
  if (vm.path) {
    const executed = run(vm.path, ['-w', bytecode]);
    assert.equal(
      executed.status,
      0,
      `Hermes V1 VM execution failed (exit ${executed.status}):\nstdout: ${executed.stdout}\nstderr: ${executed.stderr}`,
    );
    assert.ok(
      executed.stdout.split(/\r?\n/).includes('HERMES_VM_REALTIME_BIND_OK'),
      `Hermes V1 VM did not emit the binding marker:\nstdout: ${executed.stdout}\nstderr: ${executed.stderr}`,
    );
    console.log('packed Hermes V1 VM realtime binding: ok');
  } else {
    console.log(
      'packed Hermes V1 VM realtime binding: skipped locally (set STITCHKIT_HERMES_VM or run bun scripts/ensure-hermes-vm.ts)',
    );
  }

  // 3. The same client code in the host runtime.
  assert.equal(JSON.stringify(await bindSharedSocket()), expectedBinding);
  console.log('packed Hermes realtime binding: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
