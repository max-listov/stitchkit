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
/**
 * The credentials this file renders but cannot know.
 *
 * `.env.example` ships a connection string with literal `USER:PASSWORD`, and this script
 * substitutes only the database name. A file that is generated, edited by the generator and then
 * left unusable is the worst of the three: the reader assumes a generated file is ready. So the
 * placeholder is named here rather than discovered as a driver stack on the first request.
 */
function unresolvedCredentialLines(destination: string): string[] {
  return readFileSync(destination, 'utf8')
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => !line.startsWith('#') && line.includes('USER:PASSWORD'))
    .map(({ line, number }) => `  ${destination}:${number}  ${line.split('=')[0] ?? line}`);
}

/**
 * Refuse to start on an environment that still carries the example credentials.
 *
 * Separate from rendering on purpose: a generator that refuses to generate is wrong — `--no-install`
 * scaffolding renders `.env` before anyone could have filled it in — while a start that proceeds
 * into a driver stack is the defect. So `env:ensure` writes and reports; `dev` writes and refuses.
 */
export function assertUsableEnvironment(root: string): void {
  const destination = resolve(root, '.env');
  const unresolved = unresolvedCredentialLines(destination);
  if (unresolved.length === 0) return;
  throw new Error(
    `This environment still carries the example credentials.\n${unresolved.join('\n')}\n` +
      'Replace USER:PASSWORD with a role that can reach your PostgreSQL server. ' +
      'A role that runs `db:migrate` also needs CREATEDB, because `prisma migrate dev` ' +
      'creates a shadow database.',
  );
}

export function ensureLocalEnvironment(root: string): void {
  const destination = resolve(root, '.env');
  if (!existsSync(destination)) {
    const publicExample = resolve(root, '.env.example');
    const example = readFileSync(
      existsSync(publicExample) ? publicExample : resolve(root, '_env.example'),
      'utf8',
    );
    const databaseName = appIdentity.slug.replaceAll('-', '_');
    writeFileSync(destination, example.replaceAll('stitchkit_starter', databaseName));
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  ensureLocalEnvironment(root);
  // Reported, not fatal: this command's job is to produce the file, and it has.
  const unresolved = unresolvedCredentialLines(resolve(root, '.env'));
  if (unresolved.length > 0) {
    process.stderr.write(
      `.env still carries the example credentials — \`bun run dev\` will refuse until they are replaced:\n${unresolved.join('\n')}\n`,
    );
  }
}
