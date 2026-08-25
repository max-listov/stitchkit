import { resolve } from 'node:path';
import { appDeclaration } from '../packages/config/src/declaration';
import { awaitRolesAnswering, declaredRoleReadiness } from './readiness';
import { assertBuildArtifacts, runDeclaredReleaseSteps } from './release-steps';
import { deploymentEnvironment } from './tooling-env';

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

// Under supervision is not yet serving. A release that returns before the
// roles answer makes every command after it — a smoke, a health check, a
// rollout step — race the application it just started.
const roles = declaredRoleReadiness(appDeclaration, deploymentEnvironment(root));
await awaitRolesAnswering(roles);
for (const role of appDeclaration.roles) {
  console.log(`${appDeclaration.identity.slug}-${role.name} is under supervision`);
}
for (const role of roles) console.log(`${role.name}: ${role.url}`);
