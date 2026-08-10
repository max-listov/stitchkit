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
