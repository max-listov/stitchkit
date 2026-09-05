import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type PublicationScope = 'working-tree' | 'tracked' | 'packed';

export interface PublicationPrivacyFinding {
  file: string;
  line: number;
  rule: string;
  /** Which question this finding answers; see `SCOPES`. */
  scope: PublicationScope;
}

/**
 * An exemption is granted where it applies and says why.
 *
 * A wider convention list cannot be two things at once. The tracked scope needs
 * zero false positives or it becomes a red check everyone has learned to skip,
 * while a pre-commit scan can live with noise — and one global allowance gets
 * widened until the strict reader stops being strict. Granting the exemption at
 * the occurrence keeps the reason attached to the line it excuses.
 */
export interface PublicationPrivacyExemption {
  file: string;
  rule: string;
  because: string;
}

/**
 * The naming this repository writes on purpose.
 *
 * Supplied rather than compiled in, because the shapes port between
 * repositories and the exemptions do not: adopted elsewhere, this scanner
 * reported 31 findings of which one was real, the other 28 being names the
 * adopting repository writes deliberately and this one does not. A copied gate
 * whose false-positive rate is set by someone else's conventions is a gate
 * nobody keeps.
 *
 * A list of forbidden names would be worse than useless in a public repository:
 * the list is the disclosure. These are the names allowed to look private,
 * never the names known to be.
 */
export interface PublicationPrivacyConventions {
  linuxHomeNames: readonly string[];
  macHomeNames: readonly string[];
  credentialPairs: readonly string[];
  /**
   * This package's own name, from which the private working companion's name is
   * derived rather than written down.
   *
   * The rule is that public source never reveals the companion — so a gate that
   * forbade the literal string would have to contain it, and would be the leak
   * it was added to prevent. Deriving the shape keeps the name out of the tree
   * while still refusing it.
   */
  packageName: string;
}

export const DEFAULT_PUBLICATION_CONVENTIONS: PublicationPrivacyConventions = {
  linuxHomeNames: ['example-user', 'fixture-user', 'runner', 'build'],
  macHomeNames: ['example-user', 'fixture-user'],
  credentialPairs: ['example-user:example-password'],
  packageName: 'example-package',
};

const TEXT_FILE = /\.(?:cjs|css|grit|html|js|json|jsonc|md|mjs|sh|ts|tsx|txt|ya?ml)$/i;

export function isPublicationTextPath(file: string): boolean {
  return TEXT_FILE.test(file) || /(?:^|\/)LICENSE(?:\.[a-z0-9]+)?$/i.test(file);
}

function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function homeAlternatives(names: readonly string[]): string {
  return names.map((name) => `${literal(name)}(?:\\/|\\b)`).join('|');
}

export function privateShapes(
  conventions: PublicationPrivacyConventions = DEFAULT_PUBLICATION_CONVENTIONS,
): ReadonlyArray<{ rule: string; pattern: RegExp }> {
  return [
    {
      rule: 'agent or session routing metadata',
      pattern: /^(?:responsible|target-repo):|\b(?:ccmux|claude-session)\b/i,
    },
    {
      rule: 'non-synthetic macOS home path',
      pattern: new RegExp(
        `\\/Users\\/(?!${homeAlternatives(conventions.macHomeNames)})[^/\\s]+\\/`,
      ),
    },
    {
      rule: 'non-synthetic Linux home path',
      pattern: new RegExp(
        `\\/home\\/(?!${homeAlternatives(conventions.linuxHomeNames)})[^/\\s]+\\/`,
      ),
    },
    {
      rule: 'private fleet-style node identity',
      pattern:
        /\b[A-Z][A-Z0-9]+-(?:DEV|PROD|PRODUCTION|STAGING|HOST|SERVER|NODE)(?:-[A-Z0-9]+)*\b/,
    },
    {
      // The private working repository holds this project's planning; the
      // source must not name it, require its checkout, or hint at its path.
      // Its path is already refused by the home-directory shapes above — this
      // is the bare name, which they do not see.
      rule: 'private working companion of this repository',
      pattern: new RegExp(`\\b${literal(conventions.packageName)}-dev\\b`, 'i'),
    },
    {
      rule: 'credential embedded in a URL',
      pattern: new RegExp(
        `[a-z][a-z0-9+.-]*:\\/\\/(?!${conventions.credentialPairs.map(literal).join('|')}@)[^\\s/:@]+:[^\\s/@]+@`,
        'i',
      ),
    },
  ];
}

const PRIVATE_SHAPES = privateShapes();

/**
 * Every allowance this repository grants, and why it is not a leak.
 *
 * Exported rather than declared in the test, because the test is no longer the
 * only caller: `check-publication-privacy.ts` runs the same scan on every push,
 * outside the gate memo. Two copies of this list would drift, and the copy that
 * drifted would be the one deciding what reaches a public repository.
 *
 * A stale one is refused by `applyPublicationExemptions`, so an allowance
 * cannot outlive the line it was written for.
 */
export const STITCHKIT_EXEMPTIONS: readonly PublicationPrivacyExemption[] = [
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

export function inspectPublicationText(
  file: string,
  contents: string,
  options: {
    scope?: PublicationScope;
    shapes?: ReadonlyArray<{ rule: string; pattern: RegExp }>;
  } = {},
): PublicationPrivacyFinding[] {
  const scope = options.scope ?? 'working-tree';
  const findings: PublicationPrivacyFinding[] = [];
  for (const [index, line] of contents.split('\n').entries()) {
    for (const shape of options.shapes ?? PRIVATE_SHAPES) {
      shape.pattern.lastIndex = 0;
      if (shape.pattern.test(line))
        findings.push({ file, line: index + 1, rule: shape.rule, scope });
    }
  }
  return findings;
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) throw new Error(`Publication surface is missing or unreadable: ${root}`);
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(target)));
    else if (entry.isFile()) files.push(target);
    else throw new Error(`Publication surface contains an unsupported entry: ${target}`);
  }
  return files;
}

/**
 * The files git actually carries, which is the only set that cannot be taken
 * back.
 *
 * The working tree answers whether a leak is about to be written and is the
 * cheapest place to catch one; the packed artifact answers whether a leak
 * ships. Neither answers whether one is already in history, and history is
 * what a commit makes permanent — for a repository whose objects are already
 * elsewhere, that is physics rather than policy.
 */
export async function trackedPublicationFiles(
  root: string,
  paths: readonly string[],
): Promise<string[]> {
  const child = Bun.spawn(['git', '-C', root, 'ls-files', '-z', '--', ...paths], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Tracked publication surface unreadable: ${stderr}`);
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Removes the findings an exemption excuses, and refuses an exemption that
 * excused nothing.
 *
 * An allowance that outlives the line it was written for is worse than no
 * allowance: it silently widens with every edit, and nobody learns that the
 * reason stopped applying.
 */
export function applyPublicationExemptions(
  findings: readonly PublicationPrivacyFinding[],
  exemptions: readonly PublicationPrivacyExemption[],
): PublicationPrivacyFinding[] {
  const used = new Set<number>();
  const kept = findings.filter((finding) => {
    const index = exemptions.findIndex(
      (exemption) => exemption.file === finding.file && exemption.rule === finding.rule,
    );
    if (index === -1) return true;
    used.add(index);
    return false;
  });
  const stale = exemptions.filter((_, index) => !used.has(index));
  if (stale.length > 0) {
    throw new Error(
      `Publication exemption matched nothing: ${stale
        .map((exemption) => `${exemption.file} (${exemption.rule}) — ${exemption.because}`)
        .join('; ')}`,
    );
  }
  return kept;
}

export async function inspectPublicationPaths(input: {
  root: string;
  paths: readonly string[];
  exempt?: ReadonlySet<string>;
  scope?: PublicationScope;
  conventions?: PublicationPrivacyConventions;
  exemptions?: readonly PublicationPrivacyExemption[];
}): Promise<PublicationPrivacyFinding[]> {
  const selected = (
    await Promise.all(
      input.paths.map(async (relative) => {
        const target = path.join(input.root, relative);
        const metadata = await stat(target).catch(() => null);
        if (!metadata) {
          throw new Error(`Publication surface is missing: ${relative}`);
        }
        return metadata.isDirectory() ? await filesBelow(target) : [target];
      }),
    )
  ).flat();
  const findings: PublicationPrivacyFinding[] = [];
  for (const file of selected.sort()) {
    const relative = path.relative(input.root, file);
    if (input.exempt?.has(relative)) continue;
    if (!isPublicationTextPath(relative)) {
      throw new Error(`Publication surface has no declared scanner for: ${relative}`);
    }
    const contents = await readFile(file, 'utf8');
    findings.push(
      ...inspectPublicationText(relative, contents, {
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.conventions ? { shapes: privateShapes(input.conventions) } : {}),
      }),
    );
  }
  return applyPublicationExemptions(findings, input.exemptions ?? []);
}

/**
 * What this repository writes on purpose, and why each is not a leak.
 *
 * These are names allowed to *look* private, never names known to be. A list of
 * forbidden names would be the disclosure itself in a public repository.
 */
export const STITCHKIT_CONVENTIONS: PublicationPrivacyConventions = {
  // `runner` and `build` are CI-owned; the other two are the fixture vocabulary
  // the tests and the guide already use for a person's home directory.
  linuxHomeNames: ['example-user', 'fixture-user', 'runner', 'build', 'someone'],
  macHomeNames: ['example-user', 'fixture-user', 'someone'],
  // Local-only database credentials that exist in plain sight by design: a
  // throwaway Postgres in CI, and two placeholders that spell out that they are
  // placeholders. A real credential does not look like either.
  credentialPairs: [
    'example-user:example-password',
    'postgres:postgres',
    'USER:PASSWORD',
    'user:password',
  ],
  // The framework package. The companion's name is this plus a suffix, and
  // deriving it is the point: writing it out here would publish it.
  packageName: 'stitchkit',
};

/**
 * What git actually carries for one path, read from the index rather than the
 * working tree.
 *
 * `trackedPublicationFiles` names the paths git carries, but reading those
 * paths off disk answers a different question: an uncommitted edit, a staged
 * rename or a file deleted from the working tree all make the working tree
 * disagree with what a clone would receive. The tracked scope exists precisely
 * because history is the part that cannot be taken back, so it has to read
 * history's copy.
 */
export async function trackedPublicationText(root: string, file: string): Promise<string> {
  const child = Bun.spawn(['git', '-C', root, 'show', `:${file}`], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Tracked content unreadable for ${file}: ${stderr}`);
  return stdout;
}

/**
 * Every tracked text blob, read in one `git cat-file --batch` pass.
 *
 * One process, not one per file: a per-file `git show` over a repository this
 * size is a thousand spawns and turns a gate meant to run on every check into
 * one that times out.
 *
 * The content comes from the INDEX, which is what the next commit will carry —
 * not from `HEAD`, and not from the working tree. Reading `HEAD` looks correct
 * and is a hole: a leak that is staged is already green, and the gate reports
 * it one run later, after the commit that made it permanent. Reading the
 * working tree is a different hole in the other direction: it flags untracked
 * scratch files that no clone will ever see. On CI the index equals `HEAD`, so
 * one implementation answers both "is a leak about to become history" and "does
 * history already carry one".
 */
export async function trackedPublicationBlobs(
  root: string,
): Promise<{ file: string; contents: string }[]> {
  const listing = Bun.spawn(['git', '-C', root, 'ls-files', '-s', '-z'], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [listExit, listOut, listErr] = await Promise.all([
    listing.exited,
    new Response(listing.stdout).text(),
    new Response(listing.stderr).text(),
  ]);
  if (listExit !== 0) throw new Error(`Tracked index unreadable: ${listErr}`);

  const wanted: { sha: string; file: string }[] = [];
  for (const entry of listOut.split('\0')) {
    // `<mode> <sha> <stage>\t<path>`; mode 160000 is a submodule, which carries
    // no text of ours, and a stage above 0 is an unresolved merge conflict.
    const match = /^(\d+) ([0-9a-f]+) 0\t(.*)$/.exec(entry);
    if (match?.[1] === '160000') continue;
    if (match?.[2] === undefined || match[3] === undefined) continue;
    if (isPublicationTextPath(match[3])) wanted.push({ sha: match[2], file: match[3] });
  }
  if (wanted.length === 0) return [];

  const batch = Bun.spawn(['git', '-C', root, 'cat-file', '--batch'], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  });
  batch.stdin.write(`${wanted.map((entry) => entry.sha).join('\n')}\n`);
  await batch.stdin.end();
  const [batchExit, buffer] = await Promise.all([
    batch.exited,
    new Response(batch.stdout).arrayBuffer(),
  ]);
  const raw = new Uint8Array(buffer);
  if (batchExit !== 0) throw new Error('Tracked blobs unreadable');

  const decoder = new TextDecoder();
  const blobs: { file: string; contents: string }[] = [];
  let offset = 0;
  for (const entry of wanted) {
    // Each record is `<sha> blob <size>\n<size bytes>\n`; the size is bytes, so
    // the payload is sliced before decoding rather than after.
    const newline = raw.indexOf(0x0a, offset);
    if (newline === -1) throw new Error(`Truncated cat-file output at ${entry.file}`);
    const header = decoder.decode(raw.subarray(offset, newline));
    const size = Number(header.split(' ')[2]);
    if (!Number.isSafeInteger(size)) throw new Error(`Unreadable blob header: ${header}`);
    const start = newline + 1;
    blobs.push({
      file: entry.file,
      contents: decoder.decode(raw.subarray(start, start + size)),
    });
    offset = start + size + 1;
  }
  return blobs;
}

/** Every finding in what git carries, with the exemptions this repository grants. */
export async function inspectTrackedPublication(input: {
  root: string;
  conventions?: PublicationPrivacyConventions;
  exemptions?: readonly PublicationPrivacyExemption[];
}): Promise<PublicationPrivacyFinding[]> {
  const shapes = privateShapes(input.conventions ?? DEFAULT_PUBLICATION_CONVENTIONS);
  const findings: PublicationPrivacyFinding[] = [];
  for (const blob of (await trackedPublicationBlobs(input.root)).sort((left, right) =>
    left.file < right.file ? -1 : 1,
  )) {
    findings.push(
      ...inspectPublicationText(blob.file, blob.contents, { scope: 'tracked', shapes }),
    );
  }
  return applyPublicationExemptions(findings, input.exemptions ?? []);
}
