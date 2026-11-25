import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const WorkflowSchema = z.object({
  jobs: z.object({
    publish: z.object({
      steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
    }),
  }),
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

test('a package waits on npm for the siblings of its train before it is published', () => {
  const { steps } = WorkflowSchema.parse(
    Bun.YAML.parse(
      readFileSync(`${import.meta.dir}/../.github/workflows/release.yml`, 'utf8'),
    ),
  ).jobs.publish;
  const names = steps.map((step) => step.name);
  const wait = names.indexOf(
    'Wait for the packages of this train that this one publishes a range for',
  );
  expect(wait).toBeGreaterThan(
    names.indexOf('Validate tag, package version and release notes'),
  );
  expect(wait).toBeLessThan(names.indexOf('Publish the validated tarball'));
  const run = steps[wait]?.run ?? '';
  expect(run).toContain('bun scripts/release-plan.ts train-requirements "$GITHUB_REF_NAME"');
  expect(run).toContain('bun scripts/wait-for-npm-publication.ts "$NAME" "$VERSION"');
});

test('the wait step waits for every line train-requirements prints, and fails when a wait fails', () => {
  const { steps } = WorkflowSchema.parse(
    Bun.YAML.parse(
      readFileSync(`${import.meta.dir}/../.github/workflows/release.yml`, 'utf8'),
    ),
  ).jobs.publish;
  const run = steps.find(
    (step) =>
      step.name === 'Wait for the packages of this train that this one publishes a range for',
  )?.run;
  if (!run) throw new Error('Missing wait step');
  const scratch = mkdtempSync(join(tmpdir(), 'stitchkit-train-wait-'));
  try {
    const tools = join(scratch, 'tools');
    mkdirSync(tools);
    const log = join(scratch, 'waits.log');
    writeFileSync(
      join(tools, 'bun'),
      `#!/bin/sh
case "$1 $2" in
  "scripts/release-plan.ts train-requirements") printf 'stitchkit 0.127.0\\nother 1.0.0\\n' ;;
  "scripts/wait-for-npm-publication.ts "*) printf '%s %s\\n' "$2" "$3" >> "$WAITS_LOG"; [ "$2" != "$FAIL_ON" ] ;;
  *) exit 93 ;;
esac
`,
      { mode: 0o755 },
    );
    const shell = (failOn: string) =>
      spawnSync('bash', ['-e', '-c', run], {
        cwd: scratch,
        env: {
          PATH: `${tools}:/usr/bin:/bin`,
          RUNNER_TEMP: scratch,
          GITHUB_REF_NAME: 'stitchkit-tui-v0.5.0',
          WAITS_LOG: log,
          FAIL_ON: failOn,
        },
      });
    expect(shell('none').status).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('stitchkit 0.127.0\nother 1.0.0\n');
    rmSync(log);
    expect(shell('stitchkit').status).not.toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('stitchkit 0.127.0\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
