// GENERATED FILE — do not edit.
//
// Copied verbatim from the framework's `stitchkit/declaration` source by
// `scripts/sync-template-declaration.ts`. Edit `packages/core/src/declaration.ts`
// and re-run `bun run gen:template-declaration`; the gate refuses a copy that
// has fallen behind.
//
// This file disappears once the template's catalog targets a release that
// publishes `stitchkit/declaration` — at that point the schema is imported, not
// mirrored. → ADR 0104

/**
 * The project declaration — the one machine-readable statement a repository
 * chooses to make about itself.
 *
 * The schema lives in the published framework, not in the repository that fills
 * it in, because it has readers that must never disagree: the project itself,
 * the scaffolder that writes the first copy, and whatever binds an artifact
 * of it into a deployment. A copy on any of those sides is a fork rather than a contract —
 * it diverges silently and nothing fails — so the declaration ships as one
 * versioned surface instead.
 *
 * The boundary rule the schema exists to hold:
 *
 * > A declaration must be complete and meaningful **when no machine exists**. A
 * > field that cannot be filled in without knowing where the code will run is a
 * > binding supplied by the deployment, not a declaration made by the
 * > repository.
 *
 * What holds it, stated at its real strength:
 *
 * 1. **Structure.** There is nowhere a value MUST go. A command is `executable`
 *    plus an `args` array — no shell string, no pipe, no redirect — and no part
 *    may be an absolute path or an assignment in any form, so `--port=8080` and
 *    `--config=/srv/…` have to be written as separate arguments where the same
 *    checks reach them. Paths are repository-relative. Bindings are named by
 *    variable, never valued, and a listener's variables must exist in the env
 *    contract with the right shapes.
 * 2. **Hygiene.** Every remaining free string is checked against
 *    `namesAMachine` — a scheme, a protocol-relative host, an absolute or
 *    home-relative path, a Windows drive, a `host:port` pair, a bare IPv4
 *    literal — and a number after a port flag is refused.
 *
 * The second is a filter for known shapes, not a proof. A secret written as its
 * own argument (`--token`, `sk-live-…`) and a hostname written as a plain word
 * (`db.internal`) are indistinguishable from any other argument, and no schema
 * makes them distinguishable. This is not a secret scanner and does not claim to
 * be one: the guarantee is that nothing here REQUIRES a value of the place, so a
 * complete declaration can be written before any machine exists.
 *
 * **Declaring is optional, and that is a contract rather than a gap.** A
 * project with no declaration is a complete project: nothing else in the
 * framework imports this module, no build, test or start path looks for a
 * `project.json`, and the absence of one is never an error or a warning. A
 * check that demanded a declaration "for convenience" would turn a repository
 * into something only one tool can bring up — which is a fork, not a
 * dependency, and is the outcome this whole surface exists to avoid.
 *
 * Unknown keys are **refused**, not stripped. A declaration is a contract
 * between programs that never meet; a key one side does not recognise is a
 * disagreement, and silently discarding it is how a partially understood
 * declaration becomes a running, wrong deployment.
 */
import { z } from 'zod';

/**
 * The declaration format this build understands.
 *
 * A reader that does not recognise the version a repository declares refuses
 * the repository rather than interpreting it partially. Because unknown keys
 * are refused too, the version is what a reader consults when the *shape*
 * changed — and every added field is a version bump, not a silent widening.
 */
export const PROJECT_DECLARATION_SCHEMA_VERSION = 1;

/**
 * Does this string name a particular machine?
 *
 * Every pattern here is something that cannot be true of code alone. Kept in
 * one place because the previous version of this schema checked only `://`, in
 * only one of the four fields a human writes freely — and a connection string
 * with credentials, a secret and an absolute path all passed.
 */
const MACHINE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/:\/\//, 'an absolute address'],
  [/^\/\//, 'a protocol-relative host'],
  [/^[~]/, 'a home-relative path'],
  [/^[A-Za-z]:[\\/]/, 'a Windows drive path'],
  [/\\/, 'a Windows path separator'],
  [/(?:^|[\s=:])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/, 'an IP address'],
  [/(?:^|[\s=])[A-Za-z][\w.-]*:\d{2,5}(?![\w.])/, 'a host and port'],
];

/** The reason this string names a machine, or `undefined` when it does not. */
export function namesAMachine(value: string): string | undefined {
  for (const [pattern, reason] of MACHINE_PATTERNS) {
    if (pattern.test(value)) return reason;
  }
  return undefined;
}

function refuseMachineNames(label: string) {
  return (schema: z.ZodString) =>
    schema.refine((value) => namesAMachine(value) === undefined, {
      error: (issue) =>
        `${label} names a machine — ${namesAMachine(String(issue.input)) ?? 'a value of the deployment'} is supplied by the deployment, not written in the code`,
    });
}

/**
 * Lowercase, hyphen-separated identity. Everything named after the project —
 * process names, derived resource names — is derived from it, so it is the one
 * identity field with a machine-checkable shape.
 */
export const ProjectSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers and single hyphens (for example: talk-control)',
  );

/**
 * Human description keyed by locale tag. Which locales a project speaks is the
 * project's own business — the framework only insists that it speaks one.
 *
 * To fix an exact set, replace this field entirely when composing a stricter
 * declaration; it is a record, so it has no `extend`.
 */
export const ProjectDescriptionSchema = z
  .record(
    refuseMachineNames('A locale tag')(z.string().min(1)),
    refuseMachineNames('A description')(z.string().trim().min(1)),
  )
  .refine(
    (value) => Object.keys(value).length > 0,
    'Describe the project in at least one locale',
  );

/** Who the project is. True of the code with no machine in existence. */
export const ProjectIdentitySchema = z
  .object({
    slug: ProjectSlugSchema,
    name: refuseMachineNames('A project name')(z.string().trim().min(1).max(80)),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Use a semantic version such as 0.1.0'),
    description: ProjectDescriptionSchema,
  })
  .strict();

/**
 * A path inside the source. Repository-relative on purpose: a path is code
 * only while it is relative to the source — the moment it is absolute, climbs
 * out, or names a drive, it names a machine.
 */
export const RepositoryPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/'), 'Use a path relative to the repository root')
  .refine((value) => namesAMachine(value) === undefined, {
    error: (issue) =>
      `A path may not contain ${namesAMachine(String(issue.input)) ?? 'a machine name'}`,
  })
  .refine(
    (value) => !value.split('/').includes('..'),
    'A path may not climb out of the repository',
  );

/** The name of a variable a deployment will fill in. A name, never a value. */
export const BindingVariableSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Name an environment variable, for example API_PORT');

/**
 * How a role is reached over the network.
 *
 * Absent means the role has no listener at all — a queue consumer, a bot, a
 * scheduler. That is a legitimate role, not an incomplete one, so nothing here
 * is required of it.
 *
 * Both bindings are named, never valued: a deployment supplies the port and the
 * interface under these names. There is deliberately no way to say "the port
 * arrives as a command-line argument" — a reader would then have to implement
 * two injection forms forever, and a role that needs an argument builds it from
 * the variable inside its own process.
 */
export const ProjectListenerSchema = z
  .object({
    portVariable: BindingVariableSchema,
    bindVariable: BindingVariableSchema,
    /**
     * Path that answers once this role is ready to serve. `/` is a real answer.
     * Checked against `namesAMachine` because `//host/health` is a host, not a
     * path, and `.startsWith('/')` alone cannot tell them apart.
     */
    readinessPath: refuseMachineNames('A readiness path')(
      z.string().startsWith('/', 'Readiness is a path, for example /health'),
    ),
  })
  .strict();

/** The run modes a role declares commands for. */
export const ProjectRunModeSchema = z.enum(['development', 'production']);

/**
 * How to run a role: the program and its arguments, never a shell string.
 *
 * argv rather than a command line for two reasons that are both defects the
 * previous shape had. A string has to be split to be executed, and splitting on
 * spaces destroys quoted arguments and paths with spaces; and a string is a
 * place to hide `--port 8080`, `API_TOKEN=…`, a pipe or a redirect, which is
 * exactly what the boundary rule forbids. With argv there is nothing to split
 * and each member is checked on its own.
 *
 * **Start the role's process, not a launcher that starts it.** Measured under
 * PM2: with a launcher in between, the supervisor's signal reaches both, the
 * launcher forwards its copy, and the role sees two presses in two turns —
 * which every well-behaved shutdown treats as "stop waiting, force it now". A
 * declared 15s drain collapsed to 1.3ms that way, and the only visible trace
 * was a non-zero exit code. A workspace-filtering launcher is worse still: the
 * signal never arrives at all. `PROJECT_LAUNCHERS` refuses the shape.
 */
/**
 * A package-script runner, as a PAIR: the executable and the verb that makes it
 * one.
 *
 * As a bare list of executables this refused `deno run x.ts`, which is a direct
 * runtime invocation and exactly the shape the rule wants. `deno task` is the
 * launcher; `deno run` is not. `npx` and `bunx` are launchers whatever follows.
 */
const PROJECT_SCRIPT_LAUNCHERS: ReadonlyArray<readonly [RegExp, RegExp | null]> = [
  [/^(?:bun|npm|pnpm|yarn)$/, /^run$/],
  [/^deno$/, /^task$/],
  [/^(?:npx|bunx|pnpx)$/, null],
];

function launchesAScript(executable: string, firstArgument: string | undefined): boolean {
  for (const [runner, verb] of PROJECT_SCRIPT_LAUNCHERS) {
    if (!runner.test(executable)) continue;
    if (verb === null) return true;
    if (firstArgument !== undefined && verb.test(firstArgument)) return true;
  }
  return false;
}

/**
 * Flags whose next argument is a port, for the one heuristic that remains.
 *
 * `-p` is included knowingly: it means "port" in almost every server CLI, and
 * refusing `['--port', '8080']` while accepting `['-p', '8080']` would make the
 * rule decorative. It costs a false refusal for the tools where `-p` means
 * something else and takes a number, which the message tells you how to rewrite.
 */
const PORT_FLAG = /^(?:-p|-{1,2}(?:port|listen))$/i;

/**
 * A command part carries neither a machine name nor an inline value.
 *
 * Two of these are STRUCTURAL and one is hygiene, and the difference matters
 * because the texts around this schema used to claim all three were structural.
 *
 * Structural: a part may not be an absolute path, and a part may not be an
 * ASSIGNMENT in any form. `--flag=value` was the hole — `--port=8080`,
 * `--token=…` and `--config=/srv/app/config.json` all parsed clean, because
 * every per-part check looks at the part and the value was hiding inside one.
 * Writing the value as its own argv member is what puts it back under the same
 * checks: `['--port', '8080']` is refused as a port, `['--config', '/srv/…']`
 * as an absolute path.
 *
 * Hygiene: a bare number directly after a flag that names a port. It is a
 * heuristic and is scoped like one — `['--workers', '12']` is a legitimate
 * command and used to be refused. What this cannot do is recognise a secret or
 * a hostname written as a plain word: `sk-live-…` and `db.internal` are
 * indistinguishable from any other argument, and no schema will change that.
 * The boundary is held by having NOWHERE for a value to be required; it is not
 * a proof that nobody wrote one.
 */
const CommandPartSchema = refuseMachineNames('A command part')(z.string().min(1))
  .refine(
    (value) => !value.startsWith('/'),
    'A command part may not be an absolute path — paths are relative to the source',
  )
  .refine(
    // Anything up to the first `=` that is not itself a `=`. The earlier
    // `^-{0,2}[A-Za-z][\w.-]*=` described the shapes its author thought of and
    // let three through — `_API_TOKEN=secret` (a leading underscore is a legal
    // env name), `--set:key=value` and `--opt[k]=v` — while the text beside it
    // said "an assignment in any form".
    (value) => !/^[^=\s]+=/.test(value),
    'A command part may not carry an inline value — write the flag and its value as separate arguments, so the value is checked like every other one',
  );

const CommandArgumentsSchema = z
  .array(CommandPartSchema)
  .refine(
    (args) =>
      args.every(
        (value, index) => !(/^\d{1,5}$/.test(value) && PORT_FLAG.test(args[index - 1] ?? '')),
      ),
    'A number after a port flag is a port — name the variable that carries it and let the role read it',
  );

export const ProjectCommandSchema = z
  .object({
    executable: CommandPartSchema,
    args: CommandArgumentsSchema,
  })
  .strict();

/**
 * A command run under a supervisor, which additionally may not be a launcher.
 *
 * The rule applies to ROLES and not to `build`: a build is not signalled, so a
 * script runner in front of it costs nothing. A supervised role is signalled,
 * and there the launcher is the defect measured above.
 */
export const ProjectRoleCommandSchema = ProjectCommandSchema.refine(
  (value) => !launchesAScript(value.executable, value.args[0]),
  'Start the role process itself, not a script runner: a launcher between the supervisor and the role duplicates the shutdown signal and forces the drain',
).refine(
  (value) => !value.args.includes('--filter'),
  'A workspace filter puts a launcher between the supervisor and the role, and the shutdown signal never reaches it',
);

export const ProjectRoleSchema = z
  .object({
    name: ProjectSlugSchema,
    /**
     * Where this role's commands run, relative to the repository root. Omitted
     * means the root itself.
     *
     * Part of the role rather than of the supervisor because a command is only
     * meaningful together with the directory it runs in — and because a
     * supervisor reaching into a workspace from the root adds the very launcher
     * `ProjectCommandSchema` refuses.
     */
    workingDirectory: RepositoryPathSchema.optional(),
    /** How to run this role, per mode. The key enum makes every mode required. */
    commands: z.record(ProjectRunModeSchema, ProjectRoleCommandSchema),
    listener: ProjectListenerSchema.optional(),
    /**
     * The FLOOR: how long this role may need to drain cleanly, in milliseconds.
     *
     * A property of the code — it follows from what the role has to finish, not
     * from how long a deployment is willing to wait. Whatever supervises the
     * process must allow at least this much, plus whatever the role spends
     * forcing and cleaning up, before killing it.
     */
    drainFloorMs: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Data the build is allowed to read, named and frozen.
 *
 * The boundary rule separates two things — code, and the values of a place.
 * There is a third that is neither: **data read while building**. Pages
 * prerendered from a database depend on bytes that are not in the source and
 * are not a binding, and no amount of moving environment variables makes such a
 * build portable. Left unnamed, the dependency is invisible: the build succeeds
 * on the machine that happens to have the database, and the artifact silently
 * stops being a function of the source.
 *
 * Declaring an input is what makes it legitimate. `path` points at a frozen
 * export inside the source, `digest` pins its bytes, and a build that reads
 * anything else is a build nobody declared. The other two legitimate answers
 * need no field here at all: render at runtime, or generate the bytes as a
 * release step on the way to the deployment.
 */
export const ProjectBuildInputSchema = z
  .object({
    /** How the build refers to this input — and how a failure names it. */
    name: ProjectSlugSchema,
    /** The frozen export, inside the source. Never a live source of data. */
    path: RepositoryPathSchema,
    /**
     * The bytes, pinned. Without it the field records a filename and promises
     * nothing: the contents could change between two builds of one source and
     * both would look declared.
     */
    digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/, 'Use a lowercase sha256 digest, as "sha256:<64 hex>"'),
  })
  .strict();

export type ProjectBuildInput = z.infer<typeof ProjectBuildInputSchema>;

/** What building the source produces. More than one path is the normal case. */
export const ProjectBuildSchema = z
  .object({
    command: ProjectCommandSchema,
    artifacts: z.array(RepositoryPathSchema).min(1),
    /**
     * Absent is the normal case, and it means something exact: this build reads
     * no data. It does not mean "unknown".
     */
    inputs: z.array(ProjectBuildInputSchema).optional(),
  })
  .strict()
  .refine((build) => {
    const names = (build.inputs ?? []).map((input) => input.name);
    return new Set(names).size === names.length;
  }, 'Two build inputs share a name — a failure could then name either of them');

/** When a requirement has to be there. */
export const ProjectRequirementPhaseSchema = z.enum(['release', 'start']);

/**
 * Something the code needs that the code does not provide.
 *
 * `phases` says when: `release` is needed once while bringing a deployment to
 * this source, `start` is needed by every process every time it starts. One
 * requirement can be both, and saying so once beats naming it twice.
 */
export const ProjectRequirementSchema = z
  .object({
    name: ProjectSlugSchema,
    phases: z.array(ProjectRequirementPhaseSchema).min(1),
  })
  .strict();

/**
 * What a migration IS, declared as a fact rather than as a command to run.
 *
 * The repository says which bytes are migrations; whatever brings a deployment
 * to this source reads them and decides — exact contents, admission verdict,
 * whether a preflight can be skipped because nothing touches the database. A
 * free list of shell commands would take that decision away from the side that
 * is able to make it, and hand it to the side that cannot see the deployment.
 *
 * `engine` is a name, checked like every other free string: a connection string
 * fits in a name-shaped field otherwise, credentials and all.
 */
export const ProjectMigrationsSchema = z
  .object({
    engine: refuseMachineNames('A migration engine name')(z.string().min(1).max(64)),
    root: RepositoryPathSchema,
    lockfile: RepositoryPathSchema,
  })
  .strict();

/** What must happen once, before any role starts, to reach this source. */
export const ProjectReleaseSchema = z
  .object({ migrations: ProjectMigrationsSchema.optional() })
  .strict();

/** The value shapes a declaration can describe without naming a value. */
export const ProjectEnvShapeSchema = z.enum(['string', 'integer', 'boolean', 'url', 'enum']);

/**
 * A variable a deployment must supply.
 *
 * `members` is required for `enum` and forbidden otherwise: a reader without a
 * TypeScript runtime learns nothing from "one of an unnamed set", which is the
 * only thing this list exists to tell it.
 */
export const ProjectEnvVariableSchema = z
  .object({
    name: BindingVariableSchema,
    shape: ProjectEnvShapeSchema,
    required: z.boolean(),
    members: z
      .array(refuseMachineNames('An enum member')(z.string().min(1)))
      .min(1)
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.shape === 'enum') === (value.members !== undefined),
    'An enum variable lists its members; every other shape has none',
  );

/** The declaration itself. Every field here is true about the code alone. */
export const ProjectDeclarationSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_DECLARATION_SCHEMA_VERSION),
    kind: z.enum(['library', 'application']),
    identity: ProjectIdentitySchema,
    roles: z.array(ProjectRoleSchema),
    build: ProjectBuildSchema.optional(),
    requires: z.array(ProjectRequirementSchema),
    release: ProjectReleaseSchema,
    /**
     * The variables a deployment must supply, by name and shape.
     *
     * Names only. A default, a coercion or an error message belongs to the
     * project's own validation, which stays the source — this list is derived
     * from it so that a reader without a TypeScript runtime can still see what
     * the project needs.
     */
    env: z.object({ variables: z.array(ProjectEnvVariableSchema) }).strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.kind === 'application' ? value.roles.length > 0 : value.roles.length === 0,
    'An application declares at least one role; a library declares none',
  )
  .refine(
    (value) => new Set(value.roles.map((role) => role.name)).size === value.roles.length,
    'Role names must be unique',
  )
  .refine(
    (value) =>
      new Set(value.requires.map((entry) => entry.name)).size === value.requires.length,
    'Name each requirement once and list its phases',
  )
  .refine(
    (value) =>
      value.requires.every((entry) => new Set(entry.phases).size === entry.phases.length),
    'List each phase of a requirement once',
  )
  .refine(
    (value) =>
      new Set(value.env.variables.map((entry) => entry.name)).size ===
      value.env.variables.length,
    'Declare each environment variable once',
  )
  /**
   * A listener names two bindings. The env contract must contain both, with the
   * right shapes, and they must not be the same variable.
   *
   * Without this a declaration can be internally contradictory and still parse:
   * a reader outside the tree is told a role listens on `API_PORT`, looks for it
   * in the contract that lists what a deployment must supply, and does not find
   * it. Nothing fails — the deployment simply starts without a port. The
   * repository's own fixture demonstrated exactly that shape before this check.
   */
  .refine((value) => listenerBindingProblem(value) === undefined, {
    error: (issue) =>
      listenerBindingProblem(issue.input) ?? 'Listener bindings are inconsistent',
  });

interface ListenerBindingSubject {
  roles: ReadonlyArray<{
    name: string;
    listener?: { portVariable: string; bindVariable: string };
  }>;
  env: { variables: ReadonlyArray<{ name: string; shape: string }> };
}

function isListenerBindingSubject(value: unknown): value is ListenerBindingSubject {
  return typeof value === 'object' && value !== null && 'roles' in value && 'env' in value;
}

/** Why a listener's bindings disagree with the env contract, or `undefined`. */
function listenerBindingProblem(value: unknown): string | undefined {
  if (!isListenerBindingSubject(value)) return undefined;
  const shapes = new Map(value.env.variables.map((entry) => [entry.name, entry.shape]));
  for (const role of value.roles) {
    const listener = role.listener;
    if (!listener) continue;
    if (listener.portVariable === listener.bindVariable) {
      return `Role "${role.name}" points its port and its bind address at the same variable "${listener.portVariable}"`;
    }
    const expected: ReadonlyArray<readonly [string, string]> = [
      [listener.portVariable, 'integer'],
      [listener.bindVariable, 'string'],
    ];
    for (const [name, shape] of expected) {
      const declared = shapes.get(name);
      if (declared === undefined) {
        return `Role "${role.name}" listens on "${name}", which env.variables does not declare — a deployment reading this cannot know it has to supply it`;
      }
      if (declared !== shape) {
        return `Role "${role.name}" listens on "${name}", declared as "${declared}" where a ${shape} is needed`;
      }
    }
  }
  return undefined;
}

export type ProjectDeclaration = z.infer<typeof ProjectDeclarationSchema>;
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;
export type ProjectRoleCommand = z.infer<typeof ProjectRoleCommandSchema>;
export type ProjectEnvVariable = z.infer<typeof ProjectEnvVariableSchema>;
export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;

/** The declared version, or `undefined` when the source does not carry one. */
const VersionProbeSchema = z.object({ schemaVersion: z.unknown() }).loose();

/**
 * Parse a declaration, refusing an unknown schema version **before** any field
 * is read.
 *
 * Order matters. The object is strict, so a newer declaration would otherwise
 * report as a list of unrecognised keys — which reads like a broken file rather
 * than a version this build is too old to serve. The version check is
 * fail-closed: an unrecognised version is refused, never assumed compatible.
 */
export function parseProjectDeclaration(source: unknown): ProjectDeclaration {
  const probe = VersionProbeSchema.safeParse(source);
  const declared = probe.success ? probe.data.schemaVersion : undefined;
  if (declared !== undefined && declared !== PROJECT_DECLARATION_SCHEMA_VERSION) {
    throw new Error(
      `Project declaration schema version ${JSON.stringify(declared)} is not supported — ` +
        `this build understands version ${PROJECT_DECLARATION_SCHEMA_VERSION}.`,
    );
  }
  return ProjectDeclarationSchema.parse(source);
}

/** The role with this name, or `undefined`. */
export function findProjectRole(
  declaration: ProjectDeclaration,
  name: string,
): ProjectRole | undefined {
  return declaration.roles.find((role) => role.name === name);
}
