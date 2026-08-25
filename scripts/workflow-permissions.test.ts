/**
 * The release trust boundary, asserted against the REAL workflow files — not a
 * checklist. `id-token: write` (npm OIDC) must exist on exactly one job: the
 * tag-scoped publisher behind the npm-production environment; every action is
 * pinned to a full commit SHA; heavy CI holds no publish rights at all.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const starterManifest = readFileSync(
  join(root, 'packages/create-stitchkit/template/package.json'),
  'utf8',
);
const starterLock = readFileSync(
  join(root, 'packages/create-stitchkit/template/bun.lock'),
  'utf8',
);

const playwrightLockVersion = starterLock.match(
  /"@playwright\/test": \["@playwright\/test@([^"]+)"/,
)?.[1];
if (!playwrightLockVersion) {
  throw new Error('The starter lockfile is missing its resolved @playwright/test version');
}
const bunPackageManagerVersion = starterManifest.match(
  /"packageManager":\s*"bun@([^"]+)"/,
)?.[1];
if (!bunPackageManagerVersion) {
  throw new Error('The starter manifest is missing its pinned Bun package manager');
}

function actionExpression(value: string): string {
  return `\${{ ${value} }}`;
}

describe('workflow publish rights', () => {
  test('id-token: write exists ONLY in the release publish job behind the environment', () => {
    expect(ci).not.toContain('id-token');
    const occurrences = release.match(/id-token:\s*write/g) ?? [];
    expect(occurrences).toHaveLength(1);
    // The grant sits inside a job that pins the protected environment.
    expect(release).toContain('environment: npm-production');
  });

  test('both workflows default to contents: read at the workflow level', () => {
    for (const source of [ci, release]) {
      const topLevel = source.slice(0, source.indexOf('jobs:'));
      expect(topLevel).toMatch(/permissions:\s*\n\s+contents:\s*read/);
    }
  });

  test('every third-party action is pinned to a full commit SHA', () => {
    for (const source of [ci, release]) {
      const uses = [...source.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
      expect(uses.length).toBeGreaterThan(0);
      for (const action of uses) {
        expect(action).toMatch(/@[0-9a-f]{40}\b/);
      }
    }
  });

  test('the toolchain inside the publish boundary is pinned, never latest', () => {
    const publishSection = release.slice(release.indexOf('jobs:'));
    expect(publishSection).not.toMatch(/bun-version:\s*latest/);
  });
});

describe('CI release-critical graph', () => {
  const coreSection = () => ci.slice(ci.indexOf('  core:'), ci.indexOf('  supervised:'));
  const supervisedSection = () =>
    ci.slice(ci.indexOf('  supervised:'), ci.indexOf('  starter:'));
  const starterSection = () => ci.slice(ci.indexOf('  starter:'));

  test('cancels superseded branch and pull-request runs', () => {
    const topLevel = ci.slice(0, ci.indexOf('jobs:'));
    expect(topLevel).toContain(
      `group: ci-${actionExpression('github.workflow')}-${actionExpression('github.ref')}`,
    );
    expect(topLevel).toContain('cancel-in-progress: true');
  });

  test('every job runs on its own, with no heavy-job dependency between them', () => {
    for (const section of [coreSection(), supervisedSection(), starterSection()]) {
      expect(section).not.toMatch(/^\s+needs:/m);
    }
  });

  test('the graph is three job definitions and keeps the runtime consumer gates', () => {
    const jobsSection = ci.slice(ci.indexOf('jobs:'));
    expect(jobsSection.match(/^ {2}[a-z][a-z0-9-]+:\n/gm)).toHaveLength(3);
    expect(ci).not.toContain('\n  node-smoke:');

    const coreSection = ci.slice(ci.indexOf('  core:'), ci.indexOf('  supervised:'));
    expect(coreSection).toContain(
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
    );
    expect(coreSection).toContain('node-version: 22');
    expect(coreSection).toContain('- run: bun run build');
    expect(coreSection).toContain('- run: bun run smoke:next-ssr');
    expect(coreSection).toContain('- run: bun run smoke:node');
    expect(coreSection).toContain('- run: bun run consumer-lane');
    expect(ci.match(/- run: bun run build\n/g)).toHaveLength(1);
  });

  test("a real supervisor runs in CI, not only on somebody's machine", () => {
    // Every supervised defect this repository has shipped was found by running
    // it: a launcher duplicating the stop signal, a kill timeout below the
    // drain budget, a rename leaving two pairs on one port. A personal run
    // proves one run; this job is what makes the class of check repeatable.
    const supervised = supervisedSection();
    expect(supervised).toContain('- run: bun run supervised-lane');
    expect(supervised).toContain('bun add --global pm2');
    expect(supervised).toContain('STARTER_TEST_DATABASE_ADMIN_URL:');
    expect(supervised).toContain('image: postgres:18-alpine');
  });

  test('the starter matrix contains every mode, variant and browser surface', () => {
    const starterSection = ci.slice(ci.indexOf('  starter:'));
    expect(starterSection).toContain('mode: [target, head]');
    expect(starterSection).toContain('variant: [blank, repository]');
    expect(starterSection).toContain('browser: [chromium, webkit]');
    expect(starterSection).toContain('fail-fast: false');
    expect(starterSection).toContain(
      'bun scripts/starter-lane.ts "--mode=$STARTER_LANE_MODE" "--variant=$STARTER_LANE_VARIANT" "--browser=$STARTER_LANE_BROWSER"',
    );
    expect(starterSection).toContain('$(bun scripts/release-plan.ts starter-head)');
    expect(starterSection).toContain(
      'scripts/starter-head-review.json owns the migration debt',
    );
  });

  test('starter cells use one immutable lockfile-matched browser image', () => {
    const starterSection = ci.slice(ci.indexOf('  starter:'));
    expect(starterSection).toContain(
      `image: mcr.microsoft.com/playwright:v${playwrightLockVersion}-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`,
    );
    expect(starterSection).toContain('PLAYWRIGHT_BROWSERS_PATH: /ms-playwright');
    expect(starterSection).toContain(`BUN_VERSION: ${bunPackageManagerVersion}`);
    expect(starterSection).toContain(
      'BUN_ARCHIVE_SHA512: ece55300abf07cf9926c85751e974ea15571e5545ce36ec6b8f3e77bddcdeaf93879004f21df675e664387dff319a28f75b56356d41265a7d6428523c77f14b7',
    );
    expect(starterSection).toContain(
      'echo "$BUN_ARCHIVE_SHA512  $archive" | sha512sum --check',
    );
    expect(starterSection).toContain('ln --symbolic /usr/local/bin/bun /usr/local/bin/bunx');
    expect(starterSection).toContain('test "$(bunx --version)" = "$BUN_VERSION"');
    expect(starterSection).not.toContain('oven-sh/setup-bun');
    expect(starterSection).toContain(
      'STARTER_TEST_DATABASE_ADMIN_URL: postgresql://postgres:postgres@postgres:5432/postgres',
    );
    expect(starterSection).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(starterSection).not.toContain('playwright install');
  });

  test('the workflow conclusion is the fail-closed aggregate used by publication', () => {
    expect(ci).not.toContain('\n  ci:');
    expect(release).toContain(
      'actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA&status=completed',
    );
    expect(release).toContain('select-ci-run "$GITHUB_SHA"');
  });

  test('publication inputs are packed and uploaded only by the core job', () => {
    expect(ci.match(/name: release-packages/g)).toHaveLength(1);
    expect(ci.match(/bun pm pack/g)).toHaveLength(2);
    const coreSection = ci.slice(ci.indexOf('  core:'), ci.indexOf('  starter:'));
    expect(coreSection).toContain('name: release-packages');
    expect(release).toContain('name: release-packages');
    expect(release).toContain(`run-id: ${actionExpression('steps.ci.outputs.run-id')}`);
  });
});
