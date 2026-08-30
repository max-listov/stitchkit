import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

function section(name: string, next?: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  const end = next ? ci.indexOf(`\n  ${next}:\n`, start + 1) : ci.length;
  return start === -1 ? '' : ci.slice(start, end === -1 ? ci.length : end);
}

describe('workflow trust boundary', () => {
  test('id-token: write exists ONLY in the release publish job behind the environment', () => {
    expect(ci).not.toContain('id-token');
    expect(release.match(/id-token:\s*write/g)).toHaveLength(1);
    expect(release).toContain('environment: npm-production');
  });

  test('every third-party action is pinned to a full commit SHA', () => {
    for (const source of [ci, release]) {
      for (const match of source.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
        expect(match[1]).toMatch(/@[0-9a-f]{40}\b/);
      }
    }
  });

  test('workflow permissions default to read-only', () => {
    for (const source of [ci, release]) {
      expect(source.slice(0, source.indexOf('jobs:'))).toMatch(
        /permissions:\s*\n\s+contents:\s*read/,
      );
    }
  });
});

describe('target-aware CI graph', () => {
  test('portable validation starts after planning, never after Darwin', () => {
    expect(section('portable', 'tui')).toContain('needs: plan');
    expect(section('portable', 'tui')).not.toContain('needs: darwin-contained-files');
    expect(section('artifacts', 'result')).toContain('darwin-contained-files');
  });

  test('Darwin runs only the packed platform-specific proof', () => {
    const darwin = section('darwin-contained-files', 'supervised');
    expect(darwin).toContain('macos-15');
    expect(darwin).toContain('macos-15-intel');
    expect(darwin).toContain('bun run contained-files-packed-lane');
    expect(darwin).not.toContain('bun run consumer-lane');
  });

  test('starter modes come from the plan and full audits are scheduled', () => {
    const starter = section('starter', 'artifacts');
    expect(ci).toContain("cron: '17 3 * * *'");
    expect(ci).toContain('workflow_dispatch:');
    expect(starter).toContain('fromJSON(needs.plan.outputs.starter-modes)');
    expect(starter).toContain('variant: [blank, repository]');
    expect(starter).toContain('browser: [chromium, webkit]');
  });

  test('the browser and Bun runtime remain immutable and lock-aligned', () => {
    const starter = section('starter', 'artifacts');
    expect(starter).toContain(
      'v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e',
    );
    expect(starter).toContain('BUN_VERSION: 1.3.14');
    expect(starter).toContain('sha512sum --check');
    expect(starter).not.toContain('oven-sh/setup-bun');
  });

  test('one final job makes skipped lanes acceptable but failures fatal', () => {
    expect(section('result')).toContain("grep -Eq 'failure|cancelled'");
    expect(section('result')).toContain('if: always()');
  });

  test('publication downloads one exact-SHA artifact assembled from the train', () => {
    expect(ci.match(/name: release-packages/g)).toHaveLength(1);
    expect(section('artifacts', 'result')).toContain('bun scripts/pack-release-train.ts');
    expect(release).toContain('select-ci-run "$GITHUB_SHA"');
    expect(release).toContain('name: release-packages');
  });
});
