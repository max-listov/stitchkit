import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appIdentity } from '../packages/config/src/app-identity.generated';

/**
 * Create `.env` from the public `.env.example` on first run, rendering the
 * application identity into the database name. The framework repository keeps
 * that same source as `_env.example` until the scaffolder performs its rename,
 * so clean source-tree checks use it directly instead of depending on an
 * ignored developer `.env`.
 *
 * Identity, not the whole declaration: this needs one slug, and the identity
 * module carries no dependencies. That matters here more than elsewhere —
 * a project scaffolded with `--no-install` renders its `.env` before anything
 * is installed, and a script that reaches for the framework's schema to read a
 * name cannot run in that window. `.env.example` is the ONLY environment
 * source the repository ships — the scaffolder never writes `.env`, so a
 * rename in `project.json` changes the database of the next created
 * environment too. Synchronous on purpose: `playwright.config.ts` and other
 * synchronous entry points must be able to self-heal before validating.
 */
export function ensureLocalEnvironment(root: string): void {
  const destination = resolve(root, '.env');
  if (existsSync(destination)) return;
  const publicExample = resolve(root, '.env.example');
  const example = readFileSync(
    existsSync(publicExample) ? publicExample : resolve(root, '_env.example'),
    'utf8',
  );
  const databaseName = appIdentity.slug.replaceAll('-', '_');
  writeFileSync(destination, example.replaceAll('stitchkit_starter', databaseName));
}

if (import.meta.main) {
  ensureLocalEnvironment(resolve(import.meta.dir, '..'));
}
