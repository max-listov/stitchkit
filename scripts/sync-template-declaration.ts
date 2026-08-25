/**
 * Mirror the framework's project-declaration schema into the template.
 *
 * The template resolves `stitchkit` from npm at the version its catalog
 * targets, so it cannot import an entrypoint the moment that entrypoint is
 * written — only after the release that publishes it. Until then the template
 * needs the schema locally, and a hand-written copy would be exactly the fork
 * ADR 0104 exists to prevent: it compiles, it drifts, nothing fails.
 *
 * So the copy is GENERATED from `packages/core/src/declaration.ts` and checked in
 * the gate, the same way `llms.txt` is generated from the docs. There is still
 * one source; the second file simply cannot disagree with it.
 *
 * When the template's catalog reaches a release that publishes
 * `stitchkit/declaration`, this script and the generated file are deleted together
 * and `declaration.ts` imports the entrypoint instead.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');

export const SOURCE = resolve(repositoryRoot, 'packages/core/src/declaration.ts');
export const GENERATED = resolve(
  repositoryRoot,
  'packages/create-stitchkit/template/packages/config/src/project-declaration.generated.ts',
);

const BANNER = `// GENERATED FILE — do not edit.
//
// Copied verbatim from the framework's \`stitchkit/declaration\` source by
// \`scripts/sync-template-declaration.ts\`. Edit \`packages/core/src/declaration.ts\`
// and re-run \`bun run gen:template-declaration\`; the gate refuses a copy that
// has fallen behind.
//
// This file disappears once the template's catalog targets a release that
// publishes \`stitchkit/declaration\` — at that point the schema is imported, not
// mirrored. → ADR 0104

`;

/** The exact bytes the generated file must contain for the current source. */
export async function renderTemplateDeclaration(): Promise<string> {
  return `${BANNER}${await readFile(SOURCE, 'utf8')}`;
}

if (import.meta.main) {
  await writeFile(GENERATED, await renderTemplateDeclaration());
  console.log(`Wrote ${GENERATED}`);
}
