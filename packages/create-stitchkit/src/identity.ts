import { basename } from 'node:path';
import {
  PROJECT_DECLARATION_SCHEMA_VERSION,
  type ProjectDeclaration,
  ProjectDeclarationSchema,
  ProjectIdentitySchema,
  ProjectSlugSchema,
  parseProjectDeclaration,
} from '../../core/src/declaration';

// The declaration schema is NOT redeclared here. It is imported from the
// framework source and inlined by `bun build` (a relative import is bundled,
// unlike a package import), so the scaffolder writes what the framework will
// read without carrying `stitchkit` as a runtime dependency — and without a
// second copy that drifts the first time the declaration grows a field.
// → ADR 0104

export type { ProjectDeclaration };
export {
  PROJECT_DECLARATION_SCHEMA_VERSION,
  ProjectDeclarationSchema,
  ProjectSlugSchema,
  parseProjectDeclaration,
};

export type ApplicationIdentity = ProjectDeclaration['identity'];

/**
 * The client-safe identity module, byte-identical to what the template's own
 * generator produces.
 *
 * The scaffolder stamps this project's identity into the declaration, and this
 * file is derived from the declaration — so it has to be rewritten in the same
 * pass or the generated project ships the neutral template's name and fails its
 * own generator check. `tests/scaffold.test.ts` pins the two renderers together.
 */
export const APP_IDENTITY_PATH = 'packages/config/src/app-identity.generated.ts';

export function renderAppIdentityModule(identity: ApplicationIdentity): string {
  return `// GENERATED FILE — do not edit.
//
// Rendered from \`project.json\` by \`scripts/declaration.ts\`.
//
// Identity ONLY, inlined rather than imported, because this is the part of the
// declaration a browser may know. Importing the whole declaration from a client
// component would put role commands, working directories, build artifact paths,
// the migration lockfile and every environment variable name into the browser
// bundle — the same mistake as publishing internal topology from a status
// endpoint, made from the other side.

export const appIdentity = ${JSON.stringify(identity, undefined, 2)};
`;
}

function displayNameFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function createApplicationIdentity(
  destination: string,
  displayName?: string,
): ApplicationIdentity {
  const slug = ProjectSlugSchema.parse(basename(destination));
  const name = displayName?.trim() || displayNameFromSlug(slug);
  return ProjectIdentitySchema.parse({
    slug,
    name,
    version: '0.1.0',
    description: {
      en: `${name} is a production application built with Stitchkit.`,
      ru: `${name} — production-приложение на Stitchkit.`,
    },
  });
}

/**
 * Give the copied declaration this project's identity.
 *
 * Only `identity` is rewritten — roles, build, requirements, release steps and
 * environment names are properties of the template's code and travel with it
 * unchanged. The result is re-parsed rather than trusted, so the scaffolder
 * cannot leave behind a declaration the framework would refuse.
 */
export function withIdentity(
  declaration: unknown,
  identity: ApplicationIdentity,
): ProjectDeclaration {
  const copied = parseProjectDeclaration(declaration);
  return parseProjectDeclaration({ ...copied, identity });
}
