import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { decidePublishAction } from './release-plan';

const WorkflowSchema = z.object({
  jobs: z.object({
    publish: z.object({
      'timeout-minutes': z.number(),
      steps: z.array(
        z.object({
          name: z.string().optional(),
          run: z.string().optional(),
          'timeout-minutes': z.number().optional(),
        }),
      ),
    }),
  }),
});

test('workflow assigns separate publish/wait budgets and preserves the hash-based idempotent branch', () => {
  const workflow = WorkflowSchema.parse(
    Bun.YAML.parse(
      readFileSync(`${import.meta.dir}/../.github/workflows/release.yml`, 'utf8'),
    ),
  );
  const publish = workflow.jobs.publish.steps.find(
    (step) => step.name === 'Publish the validated tarball',
  );
  const wait = workflow.jobs.publish.steps.find(
    (step) => step.name === 'Wait for the exact published version in the public registry',
  );
  expect(workflow.jobs.publish['timeout-minutes']).toBe(45);
  expect(publish?.['timeout-minutes']).toBe(10);
  expect(wait?.['timeout-minutes']).toBe(31);
  expect(wait?.run).toContain('bun scripts/wait-for-npm-publication.ts "$PACKAGE" "$VERSION"');
  expect(publish?.run).not.toContain('wait-for-npm-publication');
  expect(publish?.run).toContain('publish-action "$EXPECTED_SHA" "$PUBLISHED_SHA"');
  expect(publish?.run).toContain('if [ "$ACTION" = "publish" ]; then');
  expect(publish?.run).toContain('npm publish "./$TARBALL" --provenance --access public');
  const sha = 'a'.repeat(40);
  expect(decidePublishAction(sha, sha)).toBe('skip');
  expect(decidePublishAction(sha, null)).toBe('publish');
  expect(() => decidePublishAction(sha, 'b'.repeat(40))).toThrow();
});

test('the actual publish step skips a matching tarball on rerun and refuses mismatched hashes', () => {
  const workflow = WorkflowSchema.parse(
    Bun.YAML.parse(
      readFileSync(`${import.meta.dir}/../.github/workflows/release.yml`, 'utf8'),
    ),
  );
  const step = workflow.jobs.publish.steps.find(
    (entry) => entry.name === 'Publish the validated tarball',
  );
  if (!step?.run) throw new Error('Missing actual publish step');
  const scratch = mkdtempSync(join(tmpdir(), 'stitchkit-publication-rerun-'));
  const tools = join(scratch, 'tools');
  mkdirSync(tools);
  mkdirSync(join(scratch, 'release-artifacts'));
  writeFileSync(join(scratch, 'release-artifacts/fixture-package-1.2.3.tgz'), 'fixture');
  const sha = 'a'.repeat(40);
  const log = join(scratch, 'npm-calls.log');
  writeFileSync(
    join(tools, 'npm'),
    `#!/bin/sh
printf '%s\n' "$*" >> "$NPM_CALLS_LOG"
case "$1" in
  --version) echo 11.5.0 ;;
  view) printf '%s\n' "$PUBLISHED_SHA" ;;
  publish) exit 0 ;;
  *) exit 91 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(tools, 'jq'),
    `#!/bin/sh
case "$2" in
  .packageName) echo fixture-package ;;
  .version) echo 1.2.3 ;;
  *) exit 92 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(tools, 'sha1sum'),
    `#!/bin/sh
echo '${sha}  fixture'
`,
    { mode: 0o755 },
  );
  // Only the copied shell step is executed. npm is a private fake executable in all three branches.
  const command = step.run.replaceAll(
    'bun scripts/release-plan.ts',
    `"${process.execPath}" "${import.meta.dir}/release-plan.ts"`,
  );
  try {
    for (const publishedSha of [sha, '', 'b'.repeat(40)]) {
      writeFileSync(log, '');
      const result = spawnSync('bash', ['-euc', command], {
        cwd: scratch,
        env: {
          ...process.env,
          PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin`,
          RUNNER_TEMP: scratch,
          PUBLISHED_SHA: publishedSha,
          NPM_CALLS_LOG: log,
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      const publishes = calls.filter((call) => call.startsWith('publish '));
      if (publishedSha === sha) {
        expect(result.status).toBe(0);
        expect(publishes).toEqual([]);
      } else if (publishedSha === '') {
        expect(result.status).toBe(0);
        expect(publishes).toEqual([
          'publish ./release-artifacts/fixture-package-1.2.3.tgz --provenance --access public',
        ]);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('DIFFERENT tarball');
        expect(publishes).toEqual([]);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
