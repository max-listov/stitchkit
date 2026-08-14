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
  test('cancels superseded branch and pull-request runs', () => {
    const topLevel = ci.slice(0, ci.indexOf('jobs:'));
    expect(topLevel).toContain(
      `group: ci-${actionExpression('github.workflow')}-${actionExpression('github.ref')}`,
    );
    expect(topLevel).toContain('cancel-in-progress: true');
  });

  test('core, Node and starter gates have no heavy-job dependency', () => {
    const coreSection = ci.slice(ci.indexOf('  core:'), ci.indexOf('  node-smoke:'));
    const nodeSection = ci.slice(ci.indexOf('  node-smoke:'), ci.indexOf('  starter:'));
    const starterSection = ci.slice(ci.indexOf('  starter:'));
    for (const section of [coreSection, nodeSection, starterSection]) {
      expect(section).not.toMatch(/^\s+needs:/m);
    }
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
  });

  test('starter cells use one immutable lockfile-matched browser image', () => {
    const starterSection = ci.slice(ci.indexOf('  starter:'));
    expect(starterSection).toContain(
      `image: mcr.microsoft.com/playwright:v${playwrightLockVersion}-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`,
    );
    expect(starterSection).toContain('PLAYWRIGHT_BROWSERS_PATH: /ms-playwright');
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
    const coreSection = ci.slice(ci.indexOf('  core:'), ci.indexOf('  node-smoke:'));
    expect(coreSection).toContain('name: release-packages');
    expect(release).toContain('name: release-packages');
    expect(release).toContain(`run-id: ${actionExpression('steps.ci.outputs.run-id')}`);
  });
});
