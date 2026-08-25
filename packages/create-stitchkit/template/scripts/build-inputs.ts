import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appDeclaration } from '../packages/config/src/declaration';
import type { ProjectDeclaration } from '../packages/config/src/project-declaration.generated';

const root = resolve(import.meta.dir, '..');

/**
 * The third kind of input, checked before the build reads it.
 *
 * The boundary rule separates code from the values of a place. Data read while
 * building is neither: it is not in the source and it is not a binding, so a
 * build that reads it is a function of something nobody declared. That is the
 * dependency that never announces itself — it works on the machine that happens
 * to have the database, and the artifact quietly stops being a function of the
 * source.
 *
 * Three answers are legitimate, per route rather than per project: render at
 * runtime (the default, and what this template does), read a frozen export
 * whose digest is declared here, or generate the bytes as a release step. This
 * file owns the second one. It is deliberately a no-op for a project that
 * declares no inputs — absent means "this build reads no data", which is an
 * answer, not a gap.
 */
export function assertDeclaredBuildInputs(
  declaration: ProjectDeclaration = appDeclaration,
  from: string = root,
): void {
  for (const input of declaration.build?.inputs ?? []) {
    const path = resolve(from, input.path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new Error(
        `Declared build input "${input.name}" is missing: ${input.path}. A build input is a frozen export inside the source — restore it, or stop declaring it and read the data at runtime.`,
      );
    }
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== input.digest) {
      throw new Error(
        `Declared build input "${input.name}" (${input.path}) no longer matches its digest.\n  declared: ${input.digest}\n  actual:   ${actual}\nTwo builds of one source would produce different bytes. Re-freeze the export and update the digest in project.json, or drop the input and render the data at runtime.`,
      );
    }
  }
}

if (import.meta.main) {
  assertDeclaredBuildInputs();
  const declared = appDeclaration.build?.inputs ?? [];
  console.log(
    declared.length === 0
      ? 'This build reads no declared data.'
      : `${declared.length} declared build input(s) match their digests.`,
  );
}
