/**
 * Guard: an example's declaration cannot fall behind the template's.
 *
 * An example overlays the template, so its declaration is the template's with a
 * wider environment. Kept by hand it drifts the moment a role changes — and the
 * only thing that noticed was the packed lane, minutes into a run.
 */
import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  declarationPath,
  EXAMPLES,
  renderExampleDeclaration,
} from './sync-example-declarations';

for (const example of EXAMPLES) {
  test(`the ${example} example declaration matches the template`, async () => {
    expect(await readFile(declarationPath(example), 'utf8')).toBe(
      await renderExampleDeclaration(example),
    );
  });

  test(`the ${example} example declares the variables its own features add`, async () => {
    const rendered = await renderExampleDeclaration(example);
    // Proves the render really merges the overlay rather than copying the
    // template's environment verbatim.
    expect(rendered).toContain('GITHUB_REPOSITORY');
  });
}
