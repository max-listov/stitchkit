import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const marker = 'Darwin artifact native controls: ok';
const entry = path.join(import.meta.dirname, 'darwin-artifact-controls.mjs');
const fixture = path.resolve(import.meta.dirname, '..');
const packageRoot = path.resolve(
  fileURLToPath(import.meta.resolve('stitchkit/process')),
  '../../..',
);
const native = path.join(packageRoot, 'native', `darwin-${process.arch}.node`);
const savedNative = `${native}.qualified-control`;
const modules = path.join(fixture, 'node_modules');
const savedModules = path.join(fixture, 'node_modules.qualified-control');
const build = mkdtempSync(path.join(tmpdir(), 'stitchkit-darwin-build-'));
const deployed = mkdtempSync(path.join(tmpdir(), 'stitchkit-darwin-deployed-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const artifacts = [];

function run(command, args, cwd = fixture) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

async function buildArtifact(name, target, stage) {
  const output = path.join(build, name);
  const isolated = path.join(deployed, name);
  mkdirSync(output);
  mkdirSync(isolated);
  const compiled = target === 'compiled';
  const result = await Bun.build({
    entrypoints: [entry],
    target: compiled ? 'bun' : target,
    format: 'esm',
    minify: true,
    ...(compiled
      ? { compile: { outfile: path.join(output, 'proof') }, bytecode: true }
      : { outdir: output }),
  });
  assert.equal(result.success, true, JSON.stringify(result.logs));
  let executable;
  for (const artifact of result.outputs) {
    const relative = path.relative(output, artifact.path);
    assert.equal(relative.startsWith('..'), false);
    const destination = path.join(isolated, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(artifact.path, destination);
    if (artifact.kind === 'entry-point') executable = destination;
    if (
      !compiled &&
      !stage &&
      path.basename(artifact.path).startsWith(`darwin-${process.arch}-`) &&
      artifact.path.endsWith('.node')
    ) {
      assert.equal(hash(readFileSync(destination)), nativeHash);
    }
  }
  if (compiled) executable = path.join(isolated, 'proof');
  assert.ok(executable);
  const args = stage ? ['--expect-unavailable', stage] : ['--expected-native', nativeHash];
  artifacts.push({
    name,
    command: compiled ? executable : target,
    args: compiled
      ? args
      : [...(target === 'bun' ? ['--no-install'] : []), executable, ...args],
    stage,
  });
}

async function buildModes(prefix, stage) {
  for (const target of ['compiled', 'bun', 'node']) {
    await buildArtifact(`${prefix}-${target}`, target, stage);
  }
}

assert.equal(process.platform, 'darwin');
assert.ok(existsSync(native), 'Packed candidate lacks its qualified architecture addon');
assert.equal(existsSync(savedNative), false);
assert.equal(existsSync(savedModules), false);
const nativeHash = hash(readFileSync(native));

try {
  for (let at = deployed; ; at = path.dirname(at)) {
    assert.equal(
      existsSync(path.join(at, 'node_modules')),
      false,
      'Deployed artifact is not isolated',
    );
    if (at === path.parse(at).root) break;
  }
  for (const runtime of ['bun', 'node']) {
    const output = run(runtime, [...(runtime === 'bun' ? ['--no-install'] : []), entry]);
    assert.ok(
      output.split(/\r?\n/).includes(marker),
      `${runtime} packed source control is absent`,
    );
    console.log(`packed Darwin source ${runtime}: ok`);
  }
  await buildModes('positive');
  // Rename the original before fault injection: Bun installs may share its inode
  // with a cache. New corrupt bytes must never modify those original bytes.
  renameSync(native, savedNative);
  try {
    await buildModes('missing', 'missing');
    writeFileSync(native, 'invalid native addon control', { flag: 'wx' });
    await buildModes('corrupt', 'corrupt');
  } finally {
    if (existsSync(native)) rmSync(native);
    renameSync(savedNative, native);
  }
  renameSync(modules, savedModules);
  renameSync(build, `${build}.hidden`);
  try {
    for (const artifact of artifacts) {
      const output = run(artifact.command, artifact.args, deployed);
      const expected = artifact.stage
        ? `Darwin artifact backend ${artifact.stage}: refused`
        : marker;
      assert.ok(
        output.split(/\r?\n/).includes(expected),
        'Relocated native control produced no exact verdict',
      );
      console.log(`packed Darwin artifact ${artifact.name}: ok`);
    }
  } finally {
    renameSync(savedModules, modules);
  }
  assert.equal(hash(readFileSync(native)), nativeHash);
  console.log('packed Darwin JS and standalone artifacts: ok');
} finally {
  if (existsSync(savedModules) && !existsSync(modules)) renameSync(savedModules, modules);
  if (existsSync(savedNative)) {
    if (existsSync(native)) rmSync(native);
    renameSync(savedNative, native);
  }
  for (const directory of [build, `${build}.hidden`, deployed])
    rmSync(directory, { recursive: true, force: true });
}
