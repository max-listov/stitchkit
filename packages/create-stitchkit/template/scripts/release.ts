import { resolve } from 'node:path';
import { appDeclaration } from '../packages/config/src/declaration';
import { assertBuildArtifacts, runDeclaredReleaseSteps } from './release-steps';

/**
 * Bring this deployment to this source, then hand the roles to the supervisor.
 *
 * The order is the declaration's, not this file's: build artifacts must exist,
 * declared release steps run once, and only then do roles start. Nothing here
 * repeats what `project.json` already says — the migration engine, the artifact
 * paths and the roles all come from it, and the supervision file this ends with
 * is generated from it too.
 */
const root = resolve(import.meta.dir, '..');

assertBuildArtifacts();
await runDeclaredReleaseSteps();

const supervisor = Bun.spawn(['pm2', 'startOrReload', 'ecosystem.config.cjs', '--update-env'], {
  cwd: root,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
const exitCode = await supervisor.exited;
if (exitCode !== 0) process.exit(exitCode);

for (const role of appDeclaration.roles) {
  console.log(`${appDeclaration.identity.slug}-${role.name} is under supervision`);
}
