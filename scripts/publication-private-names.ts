/**
 * Names of private projects, refused in what git carries.
 *
 * The shapes of `publication-privacy.ts` know no names, because a list of
 * forbidden names kept here would publish exactly what it protects. A project
 * name has no shape, though: a fixture called after the owner's application
 * passes every shape. So the names come from outside the repository — the
 * clone's own git config `stitchkit.privateNames` names a JSON file holding an
 * array of them — and the push gate refuses any of them in what git carries.
 *
 * A clone without that setting (CI, a contributor) says the names were not
 * checked; it never reports them clean. A setting that names a file the gate
 * cannot read, or a list that is not one, is a failure rather than a skip.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  type PublicationPrivacyFinding,
  trackedPublicationBlobs,
  trackedPublicationFiles,
} from './publication-privacy';

export const PRIVATE_NAME_RULE = 'name of a private project';

/** The git config key of a clone that names its private-name list. */
export const PRIVATE_NAMES_CONFIG = 'stitchkit.privateNames';

const NamesSchema = z
  .array(z.string().regex(/[a-z0-9]/i, 'a name has a letter or a digit'))
  .min(1);

function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One shape per name, in every spelling a reader would recognise: `acme-chat`
 * matches `acmechat`, `AcmeChat`, `acme_chat` and `acme chat`, but not inside a
 * longer word (`acmechatter`, `xacmechat`).
 */
export function privateNameShapes(
  names: readonly string[],
): ReadonlyArray<{ rule: string; pattern: RegExp }> {
  return NamesSchema.parse(names).map((name) => {
    const words = name.split(/[^a-z0-9]+/i).filter((word) => word.length > 0);
    return {
      rule: PRIVATE_NAME_RULE,
      pattern: new RegExp(
        `(?<![a-z0-9])${words.map(literal).join('[-_.\\s]?')}(?![a-z0-9])`,
        'i',
      ),
    };
  });
}

export type PrivateNames =
  | { readonly kind: 'listed'; readonly names: readonly string[]; readonly source: string }
  | { readonly kind: 'unconfigured' };

async function gitConfig(root: string): Promise<string | undefined> {
  const child = Bun.spawn(['git', '-C', root, 'config', '--get', PRIVATE_NAMES_CONFIG], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  // `git config --get` exits 1 for a key that is not set, and only for that.
  if (exitCode === 1 && stderr === '') return undefined;
  if (exitCode !== 0)
    throw new Error(`git config ${PRIVATE_NAMES_CONFIG} unreadable: ${stderr}`);
  return stdout.trim();
}

/** The list this clone names, or that it names none. */
export async function readPrivateNames(root: string): Promise<PrivateNames> {
  const configured = await gitConfig(root);
  if (configured === undefined) return { kind: 'unconfigured' };
  const source = path.resolve(root, configured);
  const text = await readFile(source, 'utf8').catch((cause: unknown) => {
    throw new Error(`${PRIVATE_NAMES_CONFIG} names ${source}, which cannot be read`, {
      cause,
    });
  });
  const parsed = NamesSchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(`${PRIVATE_NAMES_CONFIG} names ${source}, which is not a list of names`, {
      cause: parsed.error,
    });
  return { kind: 'listed', names: parsed.data, source };
}

/** The lines of one text that name one of the shapes' projects; no exemption applies to these. */
export function inspectNames(
  file: string,
  contents: string,
  shapes: ReadonlyArray<{ rule: string; pattern: RegExp }>,
): PublicationPrivacyFinding[] {
  return contents
    .split('\n')
    .flatMap((line, index): PublicationPrivacyFinding[] =>
      shapes.some((shape) => shape.pattern.test(line))
        ? [{ file, line: index + 1, rule: PRIVATE_NAME_RULE, scope: 'tracked' }]
        : [],
    );
}

/**
 * Every path and every line of what git carries that names one of `names`. A path is
 * reported as line 0, binary files included: a fixture called after a project names it
 * whatever it holds.
 */
export async function inspectTrackedNames(
  root: string,
  names: readonly string[],
): Promise<PublicationPrivacyFinding[]> {
  const shapes = privateNameShapes(names);
  const paths = (await trackedPublicationFiles(root, []))
    .filter((file) => shapes.some((shape) => shape.pattern.test(file)))
    .map(
      (file): PublicationPrivacyFinding => ({
        file,
        line: 0,
        rule: PRIVATE_NAME_RULE,
        scope: 'tracked',
      }),
    );
  const lines = (await trackedPublicationBlobs(root)).flatMap((blob) =>
    inspectNames(blob.file, blob.contents, shapes),
  );
  return [...paths, ...lines].sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file < right.file ? -1 : 1,
  );
}
