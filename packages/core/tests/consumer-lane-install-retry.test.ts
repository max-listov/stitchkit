import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_NPM_INSTALL_BACKOFF_MS,
  isTransientNpmInstallError,
  runBunInstall,
  sleepSync,
} from '../scripts/consumer-lane/install.mjs';

function makeInstallFailure(
  stderr: string,
  status = 1,
): Error & { stderr: string; status: number } {
  return Object.assign(new Error(`Command failed: bun install\n${stderr}`), {
    stderr,
    stdout: '',
    status,
  });
}

describe('consumer-lane bun install transient retry', () => {
  test('retries transient npm tarball 404 with bounded backoff and succeeds once tarball appears', () => {
    const delays: number[] = [];
    const notices: Array<{ attempt: number; maxAttempts: number; delayMs: number }> = [];
    let calls = 0;

    const output = runBunInstall('/tmp/fixture-full', ['install', '--no-save'], {
      delaysMs: [100, 250, 500],
      sleep: (ms: number) => {
        delays.push(ms);
      },
      onRetry: (info: { attempt: number; maxAttempts: number; delayMs: number }) => {
        notices.push({
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          delayMs: info.delayMs,
        });
      },
      exec: () => {
        calls += 1;
        if (calls < 3) {
          throw makeInstallFailure(
            'error: GET https://registry.npmjs.org/ai/-/ai-7.0.184.tgz - 404\nerror: ai@^7.0.107 failed to resolve',
          );
        }
        return 'Installed 42 packages';
      },
    });

    expect(output).toBe('Installed 42 packages');
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 250]);
    expect(notices).toEqual([
      { attempt: 1, maxAttempts: 4, delayMs: 100 },
      { attempt: 2, maxAttempts: 4, delayMs: 250 },
    ]);
  });

  test('stops after the configured attempt ceiling and rethrows the original error', () => {
    const delays: number[] = [];
    let calls = 0;
    const lastError = makeInstallFailure(
      'error: GET https://registry.npmjs.org/ai/-/ai-7.0.184.tgz - 404',
      1,
    );

    expect(() =>
      runBunInstall('/tmp/fixture-node', ['install', '--no-save'], {
        delaysMs: [50, 150],
        sleep: (ms: number) => {
          delays.push(ms);
        },
        onRetry: () => undefined,
        exec: () => {
          calls += 1;
          throw lastError;
        },
      }),
    ).toThrow(lastError);

    expect(calls).toBe(3);
    expect(delays).toEqual([50, 150]);
    expect(DEFAULT_NPM_INSTALL_BACKOFF_MS).toEqual([2_000, 5_000, 10_000]);
  });

  test('retries transient registry 5xx, 429 and socket resets', () => {
    for (const message of [
      'error: GET https://registry.npmjs.org/ai/-/ai-7.0.184.tgz - 503',
      'error: GET https://registry.npmjs.org/zod - 502',
      'error: GET https://registry.npmjs.org/zod HTTP 429',
      'error: Failed to download https://registry.npmjs.org/ai/-/ai-7.0.184.tgz',
      'error: ECONNRESET while fetching https://registry.npmjs.org/ai/-/ai-7.0.184.tgz',
      'error: FailedToOpenSocket connecting to https://registry.npmjs.org/zod',
    ]) {
      expect(isTransientNpmInstallError(message)).toBe(true);
    }
  });

  test('negative control: resolution, manifest, local file, integrity, auth and metadata 404 fail immediately with zero retries', () => {
    const fatalCases = [
      'error: No version matching "^99.0.0" found for specifier "ai"',
      'error: VersionNotFound: ai@99.0.0',
      'error: GET https://registry.npmjs.org/definitely-not-a-package - 404',
      'error: Invalid package.json: JSON Parse error',
      'error: ENOENT opening file:/tmp/missing-stitchkit.tgz',
      'error: Integrity check failed for tarball https://registry.npmjs.org/ai/-/ai-7.0.184.tgz',
      'error: GET https://registry.npmjs.org/@private/pkg/-/pkg-1.0.0.tgz - 401',
      'error: GET https://registry.npmjs.org/@private/pkg/-/pkg-1.0.0.tgz - 403',
      'error: WorkspaceNotFound: workspace:*',
      '',
    ];

    for (const stderr of fatalCases) {
      expect(isTransientNpmInstallError(stderr)).toBe(false);
      let calls = 0;
      const slept: number[] = [];
      expect(() =>
        runBunInstall('/tmp/fixture-bad', ['install', '--no-save'], {
          delaysMs: [100, 200],
          sleep: (ms: number) => {
            slept.push(ms);
          },
          onRetry: () => undefined,
          exec: () => {
            calls += 1;
            throw makeInstallFailure(stderr);
          },
        }),
      ).toThrow();
      expect(calls).toBe(1);
      expect(slept).toEqual([]);
    }
  });

  test('default sleepSync waits cleanly without throwing and every consumer-lane script uses runBunInstall', () => {
    const started = Date.now();
    sleepSync(10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);

    const laneDir = join(import.meta.dir, '../scripts/consumer-lane');
    for (const file of [
      'run.mjs',
      'run-packed-proof.mjs',
      'neutral-library.mjs',
      'self-contained-socket.mjs',
      'self-contained-socket-client.mjs',
    ]) {
      const source = readFileSync(join(laneDir, file), 'utf8');
      expect(source).toContain('runBunInstall(');
      expect(source).not.toMatch(
        /\b(?:run|execFileSync)\(\s*['"]bun['"],\s*\[\s*['"]install['"]/,
      );
    }
  });
});
