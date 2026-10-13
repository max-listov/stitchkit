import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runInstalledConsumerProofs } from './installed-proof-runner.ts';
import {
  declarationProofArguments,
  declarationProofVariants,
  installedConsumerProofs,
} from './installed-proofs.ts';

const here = import.meta.dirname;
const packageRoot = join(here, '..', '..');

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Run one canonical consumer proof against caller-supplied, exact package bytes. */
export async function runPackedProof({ artifact, proofId }) {
  if (!isAbsolute(artifact) || !existsSync(artifact) || !statSync(artifact).isFile())
    throw new Error('Packed proof requires an existing absolute archive file');
  const proof = installedConsumerProofs.find((candidate) => candidate.id === proofId);
  if (!proof) throw new Error(`Unknown installed consumer proof: ${proofId}`);

  const scratch = mkdtempSync(join(tmpdir(), 'stitchkit-packed-proof-'));
  try {
    const consumer = join(scratch, proof.fixture);
    cpSync(join(here, 'fixtures', proof.fixture), consumer, { recursive: true });
    const manifestPath = join(consumer, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies.stitchkit = `file:${artifact}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const tsconfigPath = join(consumer, 'tsconfig.json');
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
    delete tsconfig.compilerOptions.paths;
    writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
    run('bun', ['install', '--no-save', '--ignore-scripts'], consumer);

    let succeeded = 0;
    await runInstalledConsumerProofs({
      fixture: proof.fixture,
      platform: process.platform,
      uid: process.getuid?.(),
      ids: [proof.id],
      requireCapabilities: true,
      run: async (selected, runtime) => {
        if (runtime !== 'types') return run(runtime, [`src/${selected.entry}`], consumer);
        let output = '';
        for (const variant of declarationProofVariants(selected))
          output += run(
            'bun',
            [
              join(packageRoot, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
              ...declarationProofArguments(`src/${selected.entry}`, variant),
            ],
            consumer,
          );
        return output;
      },
      verdict: (selected, runtime, state) => {
        console.log(`[packed-proof] ${selected.id}/${runtime}: ${state}`);
        if (state === 'succeeded') succeeded += 1;
      },
    });
    if (succeeded === 0) throw new Error(`Installed proof ${proof.id} did not run`);
    console.log(`[packed-proof] ${proof.id}: ok`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [artifact, proofId] = process.argv.slice(2);
  if (!artifact || !proofId || process.argv.length !== 4)
    throw new Error('Usage: run-packed-proof.mjs <absolute-artifact> <proof-id>');
  await runPackedProof({ artifact, proofId });
}
