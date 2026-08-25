import { resolve } from 'node:path';
import { z } from 'zod';
import { appDeclaration } from '../packages/config/src/declaration';
import type {
  ProjectDeclaration,
  ProjectEnvVariable,
  ProjectRole,
} from '../packages/config/src/project-declaration.generated';
import { applicationVariables } from '../packages/config/src/variables';

/**
 * Everything derived from the project declaration.
 *
 * Two things used to be written by hand and had already drifted: the list of
 * environment variables (three overlapping copies) and the two PM2 files (nine
 * diverging lines, one of which killed the backend mid-drain every time). Both
 * are now DERIVED — from `variables.ts` and from `project.json` — and the gate
 * refuses a checked-in file that does not match what this module renders.
 *
 * Note what stays on which side. Roles, commands, readiness and the drain floor
 * come from the declaration, because they are true of the code. Restart policy
 * and the kill timeout are the place's, and for the manual path this file IS
 * the place — so the policy is one visible constant below, and the rule that
 * binds it to the code is checked rather than trusted.
 */
const root = resolve(import.meta.dir, '..');

interface SupervisionPolicy {
  restart: boolean;
  /** Must cover every role's FULL termination budget — `assertSupervisionAllowsShutdown`. */
  killTimeoutMs: number;
}

/**
 * Local supervision policy: the place's side of the manual path.
 *
 * This is placement policy living in a repository, and it is here because the
 * manual path has nowhere else to put it. It is not evidence that the
 * declaration is placement-free — the declaration is the file next to it.
 */
export const LOCAL_SUPERVISION: SupervisionPolicy = {
  restart: true,
  killTimeoutMs: 30_000,
};

/**
 * What a role spends after its drain floor before the process can exit.
 *
 * The server forces for `forceTimeoutMs` (5s by default) once the grace period
 * ends, and `onComplete` then closes MCP and the database. A supervisor sized to
 * the drain floor alone kills the role in the middle of that tail — which is why
 * the earlier check, comparing against the floor only, reported that supervision
 * "allows the full shutdown" while 15s + 5s met a 20s kill timeout exactly.
 */
const FORCE_BUDGET_MS = 5_000;
const CLEANUP_MARGIN_MS = 5_000;

/** The shortest time a supervisor may allow this role and still see it finish. */
export function terminationBudgetMs(role: ProjectRole): number {
  return role.drainFloorMs + FORCE_BUDGET_MS + CLEANUP_MARGIN_MS;
}

/**
 * JSON Schema types this projection can carry into the declaration.
 *
 * `number` used to be mapped to `integer`, which quietly told a deployment that
 * a fractional value was an integer — the declaration and the Zod contract it
 * is derived FROM would then disagree, which is the one failure the derivation
 * exists to prevent. A type with no faithful shape is refused instead: the
 * declaration format gains the shape, or the project stops declaring that type.
 */
const SHAPE_BY_JSON_TYPE: Record<string, ProjectEnvVariable['shape']> = {
  integer: 'integer',
  boolean: 'boolean',
};

const JsonSchemaSchema = z.object({
  properties: z.record(
    z.string(),
    z.object({
      type: z.string().optional(),
      format: z.string().optional(),
      enum: z.array(z.unknown()).optional(),
    }),
  ),
  required: z.array(z.string()).optional(),
});

/**
 * The variables a deployment must supply, derived from the one Zod declaration.
 *
 * `required` follows the schema exactly: a variable with a default or an
 * `.optional()` is not required, and nothing here restates that judgement. An
 * enum carries its members, because "one of an unnamed set" tells a reader
 * without a TypeScript runtime nothing — and that reader is the whole point.
 */
export function renderEnvVariables(
  variables: Record<string, z.ZodType> = applicationVariables,
): ProjectEnvVariable[] {
  const json = JsonSchemaSchema.parse(
    z.toJSONSchema(z.object(variables), { io: 'input', unrepresentable: 'any' }),
  );
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties)
    .map(([name, property]) => describeVariable(name, property, required.has(name)))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function describeVariable(
  name: string,
  property: { type?: string; format?: string; enum?: unknown[] },
  required: boolean,
): ProjectEnvVariable {
  if (property.enum) {
    // Members are refused rather than stringified. `String(member)` turned
    // numbers and booleans into text that no longer matched the value the Zod
    // schema accepts, so a deployment reading the declaration would supply
    // something the application then rejects — the declaration would be derived
    // and still wrong.
    const members = property.enum.filter((member) => typeof member === 'string');
    if (members.length !== property.enum.length) {
      throw new Error(
        `Environment variable ${name} declares a non-string enum member. The declaration format carries enum members as strings; declare it as a string enum, or extend the format first.`,
      );
    }
    return { name, shape: 'enum', required, members };
  }
  if (property.format === 'uri') return { name, shape: 'url', required };
  if (property.type === undefined || property.type === 'string') {
    return { name, shape: 'string', required };
  }
  const shape = SHAPE_BY_JSON_TYPE[property.type];
  if (!shape) {
    // Fail closed rather than describe the variable with the wrong shape: a
    // reader acting on `string` when the value is something else is worse off
    // than a reader told this project cannot describe it.
    throw new Error(
      `Cannot describe ${name}: no declaration shape for JSON Schema type "${property.type}".`,
    );
  }
  return { name, shape, required };
}

/** The declaration as it must appear on disk: authored fields plus derived ones. */
export function renderProjectJson(): string {
  const declaration: ProjectDeclaration = {
    ...appDeclaration,
    env: { variables: renderEnvVariables() },
  };
  return `${JSON.stringify(declaration, undefined, 2)}\n`;
}

/**
 * The rule the drain floor exists for: a supervisor must allow at least as long
 * as the role needs to finish — the drain, the force that follows it, and the
 * cleanup after that. Shorter, and the process is killed mid-shutdown, which is
 * what a 15s kill timeout against a 30s floor did here, every time, for as long
 * as the two numbers lived in two hand-written files.
 */
export function assertSupervisionAllowsShutdown(
  declaration: ProjectDeclaration,
  killTimeoutMs: number,
): void {
  for (const role of declaration.roles) {
    const budget = terminationBudgetMs(role);
    if (budget > killTimeoutMs) {
      throw new Error(
        `Role "${role.name}" needs up to ${budget}ms to finish shutting down (${role.drainFloorMs}ms drain + ${FORCE_BUDGET_MS}ms force + ${CLEANUP_MARGIN_MS}ms cleanup) but supervision allows ${killTimeoutMs}ms — it would be killed mid-shutdown.`,
      );
    }
  }
}

const BANNER = `// GENERATED FILE — do not edit.
//
// Rendered from \`project.json\` by \`scripts/declaration.ts\`; run
// \`bun run gen:declaration\` after changing a role. Roles, commands and the
// drain floor come from the declaration because they are true of the code;
// restart policy and the kill timeout are this machine's, and the generator
// refuses a timeout shorter than any role's full shutdown budget.
`;

/** One PM2 file per run mode, rendered from the roles. */
export function renderEcosystem(
  declaration: ProjectDeclaration,
  mode: 'development' | 'production',
): string {
  assertSupervisionAllowsShutdown(declaration, LOCAL_SUPERVISION.killTimeoutMs);
  const suffix = mode === 'development' ? '-dev' : '';
  const apps = declaration.roles.map((role) => renderApp(role, mode, suffix)).join('\n');
  return `${BANNER}const path = require('node:path');
const { config } = require('dotenv');
const declaration = require('./project.json');

// NOT \`override\`: an environment a deployment injected into this process must
// win over a file in the repository. The file fills gaps; it does not overrule
// the place.
config({ path: path.join(__dirname, '.env'), quiet: true });

module.exports = {
  apps: [
${apps}
  ],
};
`;
}

function renderApp(
  role: ProjectRole,
  mode: 'development' | 'production',
  suffix: string,
): string {
  const command = role.commands[mode];
  if (!command) throw new Error(`Role "${role.name}" declares no ${mode} command.`);
  const binding = role.listener ? `\`${role.listener.portVariable}\`` : 'its variables';
  return `    {
      name: \`\${declaration.identity.slug}-${role.name}${suffix}\`,
      // The role's OWN process, in its OWN directory — no launcher in between.
      // Measured: a launcher makes the role see the stop signal twice (once from
      // the supervisor, once forwarded), the second press forces the shutdown,
      // and a declared drain of seconds collapses to milliseconds. A workspace
      // filter is worse: the signal never arrives at all.
      cwd: path.join(__dirname, ${JSON.stringify(role.workingDirectory ?? '.')}),
      script: ${JSON.stringify(command.executable)},
      // No argv invented here: the deployment injects ${binding} and the command
      // reads it. Serialised rather than concatenated — an argument with a space
      // or a quote has to survive this file intact.
      args: ${JSON.stringify(command.args)},
      interpreter: 'none',
      autorestart: ${LOCAL_SUPERVISION.restart},
      // >= this role's full shutdown budget of ${terminationBudgetMs(role)}ms.
      kill_timeout: ${LOCAL_SUPERVISION.killTimeoutMs},
      env: { NODE_ENV: '${mode}' },
    },`;
}

const IDENTITY_BANNER = `// GENERATED FILE — do not edit.
//
// Rendered from \`project.json\` by \`scripts/declaration.ts\`.
//
// Identity ONLY, inlined rather than imported, because this is the part of the
// declaration a browser may know. Importing the whole declaration from a client
// component would put role commands, working directories, build artifact paths,
// the migration lockfile and every environment variable name into the browser
// bundle — the same mistake as publishing internal topology from a status
// endpoint, made from the other side.
`;

/** Identity alone, safe for the client graph. */
export function renderAppIdentity(): string {
  return `${IDENTITY_BANNER}
export const appIdentity = ${JSON.stringify(appDeclaration.identity, undefined, 2)};
`;
}

export const GENERATED_FILES = {
  'project.json': renderProjectJson,
  'packages/config/src/app-identity.generated.ts': renderAppIdentity,
  'ecosystem.config.cjs': () => renderEcosystem(appDeclaration, 'production'),
  'ecosystem.dev.config.cjs': () => renderEcosystem(appDeclaration, 'development'),
};

if (import.meta.main) {
  for (const [name, render] of Object.entries(GENERATED_FILES)) {
    await Bun.write(resolve(root, name), render());
    console.log(`Wrote ${name}`);
  }
}
