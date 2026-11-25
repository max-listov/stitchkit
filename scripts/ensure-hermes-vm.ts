/**
 * Ensure the pinned Hermes V1 VM CLI binary (`hermes`) is present and verified.
 *
 * Used by CI (`portable-lanes`) alongside `actions/cache` and available locally
 * to run `handler-hermes` in the real Hermes V1 VM rather than `hermesc` alone.
 * When the cached binary already exists and answers `-version` as the pinned
 * Virtual Machine bytecode version, exits immediately without invoking cmake or
 * touching the network.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Pinned Hermes V1 release matching `hermes-compiler` in `fixtures/minimal/package.json`. */
export const HERMES_V1_VERSION = '260318099.0.8';
export const HERMES_V1_TAG = `hermes-v${HERMES_V1_VERSION}`;
export const HERMES_V1_COMMIT = 'fd22091391c38ea0111fdd45bd2693d2f50bfc6f';
export const HERMES_V1_EXPECTED_HBC = 'HBC bytecode version: 99';
export const HERMES_V1_EXPECTED_VM = 'Virtual Machine';
export const HERMES_REPO_URL = 'https://github.com/facebook/hermes.git';

const EXPECTED_HBC_PATTERN = /\bHBC bytecode version:\s*99\b/;

export function defaultHermesVmPath(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const binaryName = platform === 'win32' ? 'hermes.exe' : 'hermes';
  return join(
    home,
    '.cache',
    'stitchkit',
    'hermes-vm',
    `${HERMES_V1_TAG}-${platform}-${arch}`,
    binaryName,
  );
}

export interface VersionProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  error?: string;
}

export function verifyHermesVmBinary(
  binaryPath: string,
  runVersion: (path: string) => VersionProbeResult = (path) => {
    const res = spawnSync(path, ['-version'], { encoding: 'utf8', timeout: 10_000 });
    return {
      status: res.status,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      signal: res.signal,
      error: res.error?.message,
    };
  },
): { ok: true; output: string } | { ok: false; reason: string } {
  if (!existsSync(binaryPath)) return { ok: false, reason: 'binary does not exist' };
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(binaryPath);
  } catch (error) {
    return { ok: false, reason: `stat failed: ${String(error)}` };
  }
  if (!stats.isFile() || stats.size === 0) {
    return { ok: false, reason: 'not a non-empty file' };
  }
  const result = runVersion(binaryPath);
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (result.status !== 0) {
    const extra = [
      result.signal ? `signal=${result.signal}` : '',
      result.error ? `error=${result.error}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return {
      ok: false,
      reason: `-version failed (exit ${String(result.status)}${extra ? `, ${extra}` : ''}): ${combined}`,
    };
  }
  if (!combined.includes(HERMES_V1_EXPECTED_VM)) {
    return {
      ok: false,
      reason: `missing "${HERMES_V1_EXPECTED_VM}" (compiler-only binary is not a VM): ${combined}`,
    };
  }
  if (!EXPECTED_HBC_PATTERN.test(combined)) {
    return {
      ok: false,
      reason: `missing "${HERMES_V1_EXPECTED_HBC}" in -version output: ${combined}`,
    };
  }
  return { ok: true, output: combined };
}

function formatFailure(
  command: string,
  args: readonly string[],
  result: { status: number | null; signal?: NodeJS.Signals | null; error?: Error },
): string {
  const details = [
    `exit ${String(result.status)}`,
    result.signal ? `signal ${result.signal}` : '',
    result.error ? `error ${result.error.message}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `[ensure-hermes-vm] ${command} ${args.join(' ')} failed (${details})`;
}

function runChecked(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(formatFailure(command, args, result));
  }
}

function runCaptured(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${formatFailure(command, args, result)}\n${result.stderr ?? ''}`.trim());
  }
  return (result.stdout ?? '').trim();
}

function hasTool(name: string): boolean {
  const res = spawnSync(name, ['--version'], { stdio: 'ignore' });
  return res.status === 0;
}

function findBuiltBinary(buildDir: string): string {
  const candidates =
    process.platform === 'win32'
      ? [join(buildDir, 'bin', 'hermes.exe'), join(buildDir, 'bin', 'Release', 'hermes.exe')]
      : [join(buildDir, 'bin', 'hermes')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`[ensure-hermes-vm] built binary not found in ${candidates.join(', ')}`);
  }
  return found;
}

export function buildHermesVmFromSource(destinationPath: string): string {
  if (existsSync(destinationPath) && statSync(destinationPath).isDirectory()) {
    throw new Error(`[ensure-hermes-vm] destination path is a directory: ${destinationPath}`);
  }
  const workRoot = mkdtempSync(join(tmpdir(), 'stitchkit-hermes-build-'));
  const srcDir = join(workRoot, 'hermes');
  const buildDir = join(srcDir, 'build');
  let staged: string | undefined;
  try {
    console.log(`[ensure-hermes-vm] cloning ${HERMES_V1_TAG} from ${HERMES_REPO_URL}`);
    runChecked(
      'git',
      ['clone', '--depth', '1', '--branch', HERMES_V1_TAG, HERMES_REPO_URL, srcDir],
      workRoot,
    );
    const checkedOutCommit = runCaptured('git', ['rev-parse', 'HEAD'], srcDir);
    if (checkedOutCommit !== HERMES_V1_COMMIT) {
      throw new Error(
        `[ensure-hermes-vm] tag ${HERMES_V1_TAG} resolved to ${checkedOutCommit}, expected pinned commit ${HERMES_V1_COMMIT}`,
      );
    }

    const useNinja = hasTool('ninja');
    const cmakeArgs = [
      '-S',
      srcDir,
      '-B',
      buildDir,
      ...(useNinja ? ['-G', 'Ninja'] : []),
      '-DCMAKE_BUILD_TYPE=Release',
      '-DHERMES_ENABLE_INTL=OFF',
      '-DHERMES_ENABLE_TEST_SUITE=OFF',
      '-DHERMES_ENABLE_DEBUGGER=OFF',
    ];
    console.log(`[ensure-hermes-vm] configuring cmake (${useNinja ? 'Ninja' : 'Makefiles'})`);
    runChecked('cmake', cmakeArgs, srcDir);

    const jobs = String(Math.max(1, availableParallelism()));
    console.log(`[ensure-hermes-vm] building target hermes (-j ${jobs})`);
    runChecked('cmake', ['--build', buildDir, '--target', 'hermes', '-j', jobs], srcDir);

    const builtBinary = findBuiltBinary(buildDir);
    const check = verifyHermesVmBinary(builtBinary);
    if (!check.ok) {
      throw new Error(`[ensure-hermes-vm] built binary failed verification: ${check.reason}`);
    }

    mkdirSync(dirname(destinationPath), { recursive: true });
    staged = `${destinationPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    copyFileSync(builtBinary, staged, constants.COPYFILE_EXCL);
    chmodSync(staged, 0o755);
    renameSync(staged, destinationPath);
    staged = undefined;
    console.log(`[ensure-hermes-vm] installed ${destinationPath}`);
    return destinationPath;
  } finally {
    if (staged !== undefined) rmSync(staged, { force: true });
    rmSync(workRoot, { recursive: true, force: true });
  }
}

export function resolveHermesVmTargetPath(options?: {
  targetPath?: string;
  env?: Record<string, string | undefined>;
}): string {
  const configured =
    options?.targetPath || (options?.env ?? process.env).STITCHKIT_HERMES_VM || '';
  return resolve(configured || defaultHermesVmPath());
}

export function ensureHermesVm(options?: {
  targetPath?: string;
  env?: Record<string, string | undefined>;
  build?: (destinationPath: string) => string;
}): { path: string; cached: boolean } {
  const targetPath = resolveHermesVmTargetPath(options);
  const existing = verifyHermesVmBinary(targetPath);
  if (existing.ok) {
    return { path: targetPath, cached: true };
  }
  const builder = options?.build ?? buildHermesVmFromSource;
  const builtPath = builder(targetPath);
  return { path: builtPath, cached: false };
}

if (import.meta.main) {
  const { path, cached } = ensureHermesVm();
  console.log(`[ensure-hermes-vm] ready (${cached ? 'cached' : 'built'}): ${path}`);
}
