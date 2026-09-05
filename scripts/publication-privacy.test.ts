/**
 * Guard: this repository is public, and its boundary is anonymisation at write
 * time — consumer pain is written as a reproducible technical case, never as
 * "project X asked for it". That discipline held; nothing enforced it.
 *
 * The obvious enforcement is wrong. A gate that greps for a list of private
 * names would have to keep the list in the public repository, publishing
 * exactly what it protects. So the scanner knows no names: it matches SHAPES —
 * a home path, a fleet-style node identity, agent routing metadata, a
 * credential in a URL.
 *
 * The scope is `tracked`, read from the index rather than the working tree,
 * because that is the only question whose answer cannot be taken back. The
 * working tree answers "is a leak about to be written" and the packed artifact
 * answers "does a leak ship"; neither answers "is one already in history", and
 * for a repository whose objects are already public that is physics rather than
 * policy. The tracked scope therefore also needs zero false positives — a red
 * check everyone has learned to skip protects nothing — which is why the
 * allowances below are granted per occurrence, with a reason, rather than by
 * widening one global list until the strict reader stops being strict.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeTreeHash } from './gate-memo';
import {
  applyPublicationExemptions,
  inspectPublicationText,
  inspectTrackedPublication,
  privateShapes,
  STITCHKIT_CONVENTIONS,
  STITCHKIT_EXEMPTIONS,
} from './publication-privacy';

const ROOT = `${import.meta.dir}/..`;

describe('the private working companion is never named here', () => {
  // Its **path** was already refused by the home-directory shapes; its bare
  // name was not, and a name is all it takes to tell a reader that a private
  // planning repository exists and what it is called.
  //
  // Every string below is BUILT from the package name rather than written out,
  // for the same reason the shape is derived rather than listed: a gate that
  // spelled the companion would be the disclosure it exists to prevent.
  const shapes = privateShapes(STITCHKIT_CONVENTIONS);
  const companion = `${STITCHKIT_CONVENTIONS.packageName}-dev`;
  const inspect = (text: string) =>
    inspectPublicationText('docs/example.md', text, { shapes });

  test('the bare name is refused, wherever it appears', () => {
    for (const text of [
      `planning lives in ${companion}`,
      `see https://github.com/owner/${companion}`,
      `clone ${companion} first`,
    ]) {
      expect(inspect(text).map((finding) => finding.rule)).toContain(
        'private working companion of this repository',
      );
    }
  });

  test('it does not fire on the package itself or on an unrelated name', () => {
    // The shape has to be narrow enough to live in a repository that says its
    // own name on almost every page.
    for (const text of [
      `install ${STITCHKIT_CONVENTIONS.packageName} from npm`,
      `import { defineContract } from '${STITCHKIT_CONVENTIONS.packageName}'`,
      'a-different-project-dev-landing is unrelated',
      'run in dev mode',
    ]) {
      expect(inspect(text)).toEqual([]);
    }
  });
});

describe('nothing private is in what git carries', () => {
  test('the scanner recognises each shape it claims to', () => {
    // Proves the shapes fire before anything is judged by their silence: a
    // scanner matching nothing would look exactly like a clean repository.
    const shapes = privateShapes(STITCHKIT_CONVENTIONS);
    const hits = (line: string): string[] =>
      shapes.filter((shape) => shape.pattern.test(line)).map((shape) => shape.rule);

    expect(hits('responsible: someone@example')).toContain(
      'agent or session routing metadata',
    );
    expect(hits('const p = "/home/realperson/work/"')).toContain(
      'non-synthetic Linux home path',
    );
    expect(hits('const p = "/Users/realperson/work/"')).toContain(
      'non-synthetic macOS home path',
    );
    expect(hits('measured on BOX-PROD today')).toContain('private fleet-style node identity');
    expect(hits('postgres://alice:hunter2@db.example/x')).toContain(
      'credential embedded in a URL',
    );
  });

  test('this repository’s own conventions are not flagged', () => {
    const shapes = privateShapes(STITCHKIT_CONVENTIONS);
    const clean = (line: string): boolean => !shapes.some((shape) => shape.pattern.test(line));

    expect(clean('/home/runner/work/stitchkit/')).toBe(true);
    expect(clean('/home/example-user/project/')).toBe(true);
    expect(clean('postgresql://postgres:postgres@127.0.0.1:5432/postgres')).toBe(true);
    // A widened list would have to admit this one too, which is the argument
    // for granting allowances per occurrence instead.
    expect(clean('postgres://alice:hunter2@db.example/x')).toBe(false);
  });

  test('an allowance cannot outlive the line it was written for', () => {
    const findings = inspectPublicationText('a.md', 'measured on BOX-PROD today', {
      scope: 'tracked',
    });
    expect(() =>
      applyPublicationExemptions(findings, [
        { file: 'a.md', rule: 'private fleet-style node identity', because: 'x' },
        { file: 'gone.md', rule: 'private fleet-style node identity', because: 'stale' },
      ]),
    ).toThrow(/matched nothing/);
  });

  test('what git carries has nothing private left unexplained', async () => {
    const findings = await inspectTrackedPublication({
      root: ROOT,
      conventions: STITCHKIT_CONVENTIONS,
      exemptions: STITCHKIT_EXEMPTIONS,
    });
    expect(
      findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}`),
    ).toEqual([]);
  });
});

describe('the scan cannot be skipped by the gate memo', () => {
  /**
   * The defect this pins is not in either component. `worktreeTreeHash` takes
   * its hash with `git add --all .` into a scratch index, so it counts
   * untracked files; the scan reads the real index, so it does not. The two
   * notions of "the tree" agree everywhere except the first `git add` of a new
   * file — which changes no content, so no hash — and that is exactly the
   * moment the file first enters the scan's reach. A green run remembered
   * before it therefore answers for the push after it.
   *
   * A real machine path reached a public repository through that gap. CI caught
   * it and went red, which for a public push is a report rather than a refusal:
   * the push had already published it. The repair is that the scan no longer
   * runs inside the memo at all, and this test states the arithmetic that made
   * the repair necessary, so nobody "optimises" it back under the memo later.
   */
  const git = (root: string, ...args: string[]): void => {
    const result = Bun.spawnSync(['git', '-C', root, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };

  test('a new file is inside the memo key and outside the scan until it is staged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-privacy-memo-'));
    try {
      git(root, 'init', '--quiet');
      git(root, 'config', 'user.email', 'gate@example.invalid');
      git(root, 'config', 'user.name', 'gate');
      writeFileSync(join(root, 'kept.md'), 'nothing private here\n');
      git(root, 'add', 'kept.md');
      git(root, 'commit', '--quiet', '-m', 'base');

      const findings = async (): Promise<number> =>
        (await inspectTrackedPublication({ root, conventions: STITCHKIT_CONVENTIONS })).length;

      expect(await findings()).toBe(0);

      // The leak, written but not yet staged.
      writeFileSync(join(root, 'leak.md'), 'see /home/realperson/work/x for the layout\n');
      const beforeStaging = await worktreeTreeHash(root);
      expect(await findings()).toBe(0);

      git(root, 'add', 'leak.md');
      const afterStaging = await worktreeTreeHash(root);

      // The whole defect in two assertions: the key did not move, the verdict did.
      expect(afterStaging).toBe(beforeStaging);
      expect(await findings()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
