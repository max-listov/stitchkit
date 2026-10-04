import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import { createNativePackaging } from 'stitchkit/files/packaging';

const marker = 'Darwin artifact native controls: ok';
const entry = path.join(import.meta.dirname, 'darwin-artifact-controls.mjs');
const fixture = path.resolve(import.meta.dirname, '..');
const packageRoot = path.resolve(
  fileURLToPath(import.meta.resolve('stitchkit/process')),
  '../../..',
);
const initialPackaging = createNativePackaging({
  platform: 'darwin',
  architecture: process.arch,
  delivery: 'companion',
  entryPath: 'app/proof.js',
  assetPath: 'addons/owner.node',
});
assert.equal(initialPackaging.state, 'ready');
const native = initialPackaging.assets[0].sourcePath;
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

async function buildArtifact(name, target, stage, supported = false) {
  const output = path.join(build, name);
  const isolated = path.join(deployed, name);
  mkdirSync(output);
  mkdirSync(isolated);
  const compiled = target === 'compiled';
  const packaging = supported
    ? createNativePackaging({
        platform: 'darwin',
        architecture: process.arch,
        delivery: compiled ? 'embedded' : 'companion',
        entryPath: 'app/proof.js',
        assetPath: 'addons/owner.node',
      })
    : undefined;
  if (packaging) assert.equal(packaging.state, 'ready');
  const result = await Bun.build({
    entrypoints: [entry],
    target: compiled ? 'bun' : target,
    format: 'esm',
    minify: true,
    plugins: packaging ? [packaging.plugin] : [],
    ...(compiled
      ? { compile: { outfile: path.join(output, 'proof') }, bytecode: true }
      : { outdir: output, ...(supported ? { naming: { entry: 'app/proof.js' } } : {}) }),
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
  const expectedFiles = result.outputs.map((artifact) => ({
    relative: path.relative(output, artifact.path),
    sha256: hash(readFileSync(artifact.path)),
  }));
  if (supported && !compiled) {
    for (const asset of packaging.assets) {
      assert.equal(hash(readFileSync(asset.sourcePath)), asset.sha256);
      assert.equal(asset.sha256, nativeHash);
      const destination = path.join(isolated, asset.outputPath);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(asset.sourcePath, destination);
      assert.equal(hash(readFileSync(destination)), asset.sha256);
      expectedFiles.push({ relative: asset.outputPath, sha256: asset.sha256 });
    }
    if (stage === 'missing') rmSync(path.join(isolated, 'addons/owner.node'));
    if (stage === 'corrupt')
      writeFileSync(path.join(isolated, 'addons/owner.node'), 'invalid addon');
  }
  // Qualify delivery through an archive, rather than a second copy of the build tree.
  const archive = path.join(build, `${name}.tar`);
  run('tar', ['-cf', archive, '-C', isolated, '.']);
  rmSync(isolated, { recursive: true });
  mkdirSync(isolated);
  run('tar', ['-xf', archive, '-C', isolated]);
  for (const expected of expectedFiles) {
    const destination = path.join(isolated, expected.relative);
    if (stage && supported && expected.relative === 'addons/owner.node') {
      if (stage === 'missing')
        assert.equal(
          existsSync(destination),
          false,
          'Archive integrity refuses missing addon',
        );
      else
        assert.notEqual(
          hash(readFileSync(destination)),
          expected.sha256,
          'Archive integrity refuses substituted addon',
        );
    } else
      assert.equal(
        hash(readFileSync(destination)),
        expected.sha256,
        'Archive roundtrip preserves original graph bytes',
      );
  }
  if (compiled) chmodSync(executable, 0o700);
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

async function buildModes(prefix, stage, supported = false) {
  for (const target of ['compiled', 'bun', 'node']) {
    await buildArtifact(`${prefix}-${target}`, target, stage, supported);
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
  await buildModes('supported', undefined, true);
  for (const stage of ['missing', 'corrupt']) {
    for (const target of ['bun', 'node'])
      await buildArtifact(`supported-${stage}-${target}`, target, stage, true);
  }
  // A layout mutation belongs to this installed qualification fixture, never to a consumer recipe.
  const metadataPath = path.join(packageRoot, 'native-assets.json');
  const metadataBytes = readFileSync(metadataPath);
  const savedMetadata = `${metadataPath}.qualified-control`;
  const metadata = JSON.parse(metadataBytes);
  const moved = path.join(packageRoot, 'qualification-layout', 'renamed-addon.node');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(native, moved);
  renameSync(metadataPath, savedMetadata);
  try {
    metadata.assets[process.arch] = 'qualification-layout/renamed-addon.node';
    writeFileSync(metadataPath, JSON.stringify(metadata));
    assert.equal(existsSync(native), false, 'Old hardcoded addon path must fail resolution');
    await buildArtifact('old-hardcoded-layout', 'bun', 'missing');
    await buildModes('supported-mutated', undefined, true);
  } finally {
    rmSync(metadataPath, { force: true });
    renameSync(savedMetadata, metadataPath);
    renameSync(moved, native);
    rmSync(path.dirname(moved), { recursive: true });
  }
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
