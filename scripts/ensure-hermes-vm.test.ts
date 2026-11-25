import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultHermesVmPath,
  ensureHermesVm,
  HERMES_V1_COMMIT,
  HERMES_V1_EXPECTED_HBC,
  HERMES_V1_EXPECTED_VM,
  HERMES_V1_TAG,
  HERMES_V1_VERSION,
  resolveHermesVmTargetPath,
  verifyHermesVmBinary,
} from './ensure-hermes-vm';

const ROOT = join(import.meta.dir, '..');

describe('ensure-hermes-vm', () => {
  test('pinned Hermes V1 tag and commit match hermes-compiler in consumer-lane minimal fixture', () => {
    const manifest = JSON.parse(
      readFileSync(
        join(ROOT, 'packages/core/scripts/consumer-lane/fixtures/minimal/package.json'),
        'utf8',
      ),
    ) as { devDependencies?: Record<string, string> };
    expect(manifest.devDependencies?.['hermes-compiler']).toBe(HERMES_V1_VERSION);
    expect(HERMES_V1_TAG).toBe(`hermes-v${HERMES_V1_VERSION}`);
    expect(HERMES_V1_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  test('verifyHermesVmBinary accepts matching VM HBC 99 and refuses hermesc, wrong HBC, or crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ensure-hermes-test-'));
    try {
      const missing = join(dir, 'nope');
      expect(verifyHermesVmBinary(missing).ok).toBe(false);

      const bin = join(dir, 'hermes');
      writeFileSync(bin, '#!/bin/sh\necho ok\n');

      const good = verifyHermesVmBinary(bin, () => ({
        status: 0,
        stdout: `Hermes JavaScript compiler and ${HERMES_V1_EXPECTED_VM}.\n  Hermes release version: 1.0.0\n  ${HERMES_V1_EXPECTED_HBC}\n`,
        stderr: '',
      }));
      expect(good.ok).toBe(true);

      const compilerOnly = verifyHermesVmBinary(bin, () => ({
        status: 0,
        stdout: `Hermes JavaScript compiler.\n  Hermes release version: 1.0.0\n  ${HERMES_V1_EXPECTED_HBC}\n`,
        stderr: '',
      }));
      expect(compilerOnly.ok).toBe(false);

      const wrongBytecode = verifyHermesVmBinary(bin, () => ({
        status: 0,
        stdout: `Hermes JavaScript compiler and ${HERMES_V1_EXPECTED_VM}.\n  HBC bytecode version: 990\n`,
        stderr: '',
      }));
      expect(wrongBytecode.ok).toBe(false);

      const crashed = verifyHermesVmBinary(bin, () => ({
        status: null,
        signal: 'SIGKILL',
        error: 'spawn ENOENT',
        stdout: '',
        stderr: '',
      }));
      expect(crashed.ok).toBe(false);
      if (!crashed.ok) {
        expect(crashed.reason).toContain('SIGKILL');
        expect(crashed.reason).toContain('ENOENT');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ensureHermesVm caches valid VM, rebuilds missing or invalid binary, and ignores empty env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ensure-hermes-build-test-'));
    try {
      // 1. Missing binary -> invokes builder.
      const missingTarget = join(dir, 'missing-hermes');
      let buildCalls = 0;
      const built = ensureHermesVm({
        targetPath: missingTarget,
        build: (dest) => {
          buildCalls += 1;
          expect(dest).toBe(missingTarget);
          return dest;
        },
      });
      expect(buildCalls).toBe(1);
      expect(built).toEqual({ path: missingTarget, cached: false });

      // 2. Valid cached VM stub -> skips builder (`cached: true`).
      const validStub = join(dir, 'valid-hermes');
      writeFileSync(
        validStub,
        `#!/bin/sh\necho "Hermes JavaScript compiler and ${HERMES_V1_EXPECTED_VM}."\necho "  ${HERMES_V1_EXPECTED_HBC}"\n`,
      );
      chmodSync(validStub, 0o755);
      buildCalls = 0;
      const cached = ensureHermesVm({
        targetPath: validStub,
        build: (dest) => {
          buildCalls += 1;
          return dest;
        },
      });
      expect(buildCalls).toBe(0);
      expect(cached).toEqual({ path: validStub, cached: true });

      // 3. Invalid (compiler-only) stub -> triggers rebuild.
      const compilerStub = join(dir, 'hermesc-stub');
      writeFileSync(
        compilerStub,
        `#!/bin/sh\necho "Hermes JavaScript compiler."\necho "  ${HERMES_V1_EXPECTED_HBC}"\n`,
      );
      chmodSync(compilerStub, 0o755);
      buildCalls = 0;
      const rebuilt = ensureHermesVm({
        targetPath: compilerStub,
        build: (dest) => {
          buildCalls += 1;
          return dest;
        },
      });
      expect(buildCalls).toBe(1);
      expect(rebuilt).toEqual({ path: compilerStub, cached: false });

      // 4. Empty STITCHKIT_HERMES_VM="" falls back to default cache path, never cwd.
      expect(resolveHermesVmTargetPath({ env: { STITCHKIT_HERMES_VM: '' } })).toBe(
        defaultHermesVmPath(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('defaultHermesVmPath scopes cache by tag, platform, and arch', () => {
    const linuxPath = defaultHermesVmPath('/home/runner', 'linux', 'x64');
    expect(linuxPath).toBe(
      `/home/runner/.cache/stitchkit/hermes-vm/${HERMES_V1_TAG}-linux-x64/hermes`,
    );
  });

  test('ci.yml caches and ensures Hermes V1 VM before consumer-lane with mandatory VM mode', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const start = ci.indexOf('\n  portable-lanes:\n');
    const end = ci.indexOf('\n  tui:\n', start + 1);
    const portableLanes = ci.slice(start, end);
    expect(portableLanes).toContain('~/.cache/stitchkit/hermes-vm');
    expect(portableLanes).toContain(HERMES_V1_TAG);
    expect(portableLanes).toContain("hashFiles('scripts/ensure-hermes-vm.ts')");
    expect(portableLanes).toContain('bun scripts/ensure-hermes-vm.ts');
    expect(portableLanes).toContain("STITCHKIT_REQUIRE_HERMES_VM: '1'");
    expect(portableLanes.indexOf('bun scripts/ensure-hermes-vm.ts')).toBeLessThan(
      portableLanes.indexOf('bun run consumer-lane'),
    );
  });
});
