/**
 * Render each example's project declaration from the template's.
 *
 * An example is an overlay: it replaces some files of the template and keeps the
 * rest. Its declaration is therefore the template's declaration with one thing
 * changed — the environment, because an example may add variables of its own
 * through `features.ts`.
 *
 * Kept by hand, that file drifts the moment a role changes in the template, and
 * the drift only surfaces in the packed lane minutes into a run. So it is
 * generated, like the schema mirror and the supervision files, and the gate
 * refuses a stale copy.
 *
 * The derivation itself is the TEMPLATE's — `renderEnvVariables` — rather than a
 * second implementation here. One rule for what a variable's shape is, wherever
 * the question is asked.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');
const scaffolder = resolve(repositoryRoot, 'packages/create-stitchkit');

export const EXAMPLES = ['repository'];

export function declarationPath(example: string): string {
  return resolve(scaffolder, `examples/${example}/project.json`);
}

/** The exact bytes an example's declaration must contain right now. */
export async function renderExampleDeclaration(example: string): Promise<string> {
  const { renderEnvVariables } = await import(`${scaffolder}/template/scripts/declaration.ts`);
  const { applicationVariables } = await import(
    `${scaffolder}/template/packages/config/src/variables.ts`
  );
  const { featureServerSchema } = await import(
    `${scaffolder}/examples/${example}/packages/config/src/features.ts`
  );

  const template: unknown = JSON.parse(
    await readFile(resolve(scaffolder, 'template/project.json'), 'utf8'),
  );
  const declaration = {
    ...(typeof template === 'object' && template !== null ? template : {}),
    env: {
      variables: renderEnvVariables({ ...applicationVariables, ...featureServerSchema }),
    },
  };
  return `${JSON.stringify(declaration, undefined, 2)}\n`;
}

if (import.meta.main) {
  for (const example of EXAMPLES) {
    await writeFile(declarationPath(example), await renderExampleDeclaration(example));
    console.log(`Wrote ${declarationPath(example)}`);
  }
}
