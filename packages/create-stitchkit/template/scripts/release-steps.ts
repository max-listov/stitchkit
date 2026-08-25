import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { appDeclaration } from '../packages/config/src/declaration';
import type { ProjectDeclaration } from '../packages/config/src/project-declaration.generated';
import { inheritToolingEnvironment } from './tooling-env';

const root = resolve(import.meta.dir, '..');

/**
 * Bringing this deployment to this source — the steps the DECLARATION says
 * must happen once, before any role starts.
 *
 * The declaration says what a migration *is* (engine, root, lockfile), not what
 * command to run for it. That split is the point: an outside deployment tool
 * reads the bytes and decides for itself — exact contents, admission verdict,
 * whether a preflight is needed at all — while the project keeps the one command
 * that applies them here. Neither side has to learn the other's vocabulary.
 */
const MIGRATION_COMMANDS: Record<string, string[]> = {
  prisma: ['bun', 'run', 'db:deploy'],
};

/**
 * The command that applies this project's declared migrations, or `undefined`
 * when it declares none — absent means "there are none", not "we forgot to say".
 *
 * An engine with no command here is refused rather than skipped: silently not
 * migrating is the failure that leaves a deployment running against the wrong
 * schema.
 */
/**
 * A declared command as an operator can retype it.
 *
 * `${command}` on a `{ executable, args }` object prints `[object Object]`, so
 * the one diagnostic that exists to tell an operator what to run told them
 * nothing. Quoting is deliberate: an argument with a space has to survive being
 * read back.
 */
export function formatCommand(command: { executable: string; args: string[] }): string {
  return [command.executable, ...command.args]
    .map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

export function migrationCommandFor(
  declaration: ProjectDeclaration = appDeclaration,
): string[] | undefined {
  const { migrations } = declaration.release;
  if (!migrations) return undefined;

  const command = MIGRATION_COMMANDS[migrations.engine];
  if (!command) {
    throw new Error(
      `project.json declares migrations for "${migrations.engine}", which this project has no command for.`,
    );
  }
  // Both declared paths are checked. The lockfile is what tells a reader the
  // migrations belong to one lineage; declaring it and then not looking at it
  // is how a declaration starts describing a tree that is not there.
  const declaredPaths: Array<[string, string]> = [
    ['root', migrations.root],
    ['lockfile', migrations.lockfile],
  ];
  for (const [label, path] of declaredPaths) {
    if (!existsSync(resolve(root, path))) {
      throw new Error(`Declared migration ${label} ${path} does not exist.`);
    }
  }
  return command;
}

/**
 * Everything the declaration says building produces must exist before roles
 * start.
 *
 * Derived from `build.artifacts` rather than from a list kept here, so an
 * artifact added to the declaration is covered without a second edit — and the
 * failure names the missing path instead of surfacing as a module-not-found
 * inside a supervised process, where nobody reads it.
 */
export function assertBuildArtifacts(declaration: ProjectDeclaration = appDeclaration): void {
  const build = declaration.build;
  if (!build) return;
  const missing = build.artifacts.filter((artifact) => !existsSync(resolve(root, artifact)));
  if (missing.length > 0) {
    throw new Error(
      `Missing build artifacts: ${missing.join(', ')} — run \`${formatCommand(build.command)}\` first.`,
    );
  }
}

export async function runDeclaredReleaseSteps(
  environment?: Record<string, string>,
): Promise<void> {
  const command = migrationCommandFor();
  if (!command) return;

  const child = Bun.spawn(command, {
    cwd: root,
    env: environment ? inheritToolingEnvironment(environment) : undefined,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await child.exited) !== 0) {
    throw new Error(`${command.join(' ')} failed`);
  }
}
