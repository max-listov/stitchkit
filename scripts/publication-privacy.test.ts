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
import {
  applyPublicationExemptions,
  inspectPublicationText,
  inspectTrackedPublication,
  type PublicationPrivacyExemption,
  privateShapes,
  STITCHKIT_CONVENTIONS,
} from './publication-privacy';

const ROOT = `${import.meta.dir}/..`;

/**
 * Every allowance this repository grants, and why it is not a leak.
 *
 * A stale one is refused by `applyPublicationExemptions`, so an allowance
 * cannot outlive the line it was written for.
 */
const EXEMPTIONS: readonly PublicationPrivacyExemption[] = [
  {
    file: 'scripts/publication-privacy.test.ts',
    rule: 'non-synthetic Linux home path',
    because:
      'This file proves each shape fires, which it can only do by containing one of each.',
  },
  {
    file: 'scripts/publication-privacy.test.ts',
    rule: 'non-synthetic macOS home path',
    because:
      'This file proves each shape fires, which it can only do by containing one of each.',
  },
  {
    file: 'scripts/publication-privacy.test.ts',
    rule: 'private fleet-style node identity',
    because:
      'This file proves each shape fires, which it can only do by containing one of each.',
  },
  {
    file: 'scripts/publication-privacy.test.ts',
    rule: 'credential embedded in a URL',
    because:
      'This file proves each shape fires, which it can only do by containing one of each.',
  },
  {
    file: 'scripts/publication-privacy.ts',
    rule: 'agent or session routing metadata',
    because:
      'The scanner states that shape as a literal pattern, so it matches itself. A rule cannot be written without writing it down.',
  },
  {
    file: 'packages/core/tests/error-hook.test.ts',
    rule: 'credential embedded in a URL',
    because:
      'A synthetic DSN inside an error message, asserted to be redacted before it reaches a client.',
  },
  {
    file: 'packages/core/tests/errors.test.ts',
    rule: 'credential embedded in a URL',
    because:
      'A synthetic secret built by repeating one character, used to prove long values are truncated.',
  },
  {
    file: 'packages/core/tests/oauth.test.ts',
    rule: 'credential embedded in a URL',
    because: 'A redirect URI carrying userinfo, asserted to be refused.',
  },
  {
    file: 'packages/core/tests/project-declaration.test.ts',
    rule: 'credential embedded in a URL',
    because: 'The hygiene filter is tested by feeding it exactly the shapes it must refuse.',
  },
  {
    file: 'packages/core/tests/secure-fetch.test.ts',
    rule: 'credential embedded in a URL',
    because:
      'A URL with embedded userinfo, asserted to be rejected before any request is made.',
  },
  {
    file: 'packages/create-stitchkit/template/scripts/acceptance-database.test.ts',
    rule: 'credential embedded in a URL',
    because:
      'A throwaway local database URL the acceptance script parses; never reachable off the machine.',
  },
  {
    file: 'scripts/starter-database.ts',
    rule: 'credential embedded in a URL',
    because:
      'Not a credential at all: both halves are template placeholders interpolated at runtime. The shape cannot tell a template from a literal, and a value assembled from variables is by construction not a secret.',
  },
];

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
      exemptions: EXEMPTIONS,
    });
    expect(
      findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}`),
    ).toEqual([]);
  });
});
