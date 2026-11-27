/**
 * What the two client builds share: one bounded tool invocation, the module
 * graph the bundler reports, and the refusal of a graph that reaches a
 * forbidden module.
 *
 * The self-contained file (`client-artifact.ts`) bundles everything; the npm
 * package (`client-package.ts`) leaves its peers and dependencies outside. A
 * module left outside is still an import the client makes, so the refusal reads
 * external imports as well as bundled modules: a rule that names a package
 * refuses the import of it whether or not its code ended up in the output.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { safeJsonParse } from '../internal/safe-json';
import { runNativeCommand } from '../process/command';

/** A module the client must not reach: a package name, or a pattern over the module path. */
export type ForbiddenModule = string | RegExp;

/** The refusal of a client whose module graph reaches a forbidden module. */
export class ForbiddenModuleError extends Error {
  constructor(
    /** The forbidden module: its path when bundled, its specifier when left external. */
    readonly module: string,
    /** A module that imports it, when the graph names one. */
    readonly importedBy: string | undefined,
  ) {
    super(
      `Client artifact contains forbidden module "${module}"` +
        (importedBy === undefined ? '' : ` (imported by "${importedBy}")`),
    );
    this.name = 'ForbiddenModuleError';
  }
}

/** The deadline and cancellation every tool of one build runs under. */
export interface ClientBuildStep {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** A tool as it is started: the executable, then the arguments that precede the caller's own. */
export type ClientToolCommand = readonly [string, ...string[]];

/** What one tool left: its exit, its stdout, and both streams for a refusal to quote. */
export interface ClientToolResult {
  ok: boolean;
  /** Exit code, or the signal that ended the tool. */
  exit: string;
  stdout: string;
  /** stderr followed by stdout, trimmed. */
  output: string;
}

/** One bounded tool invocation; a missing tool, a deadline or a cancellation throws. */
export async function runClientTool(
  step: ClientBuildStep,
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<ClientToolResult> {
  const result = await runNativeCommand({
    executable,
    args: [...args],
    cwd,
    envPolicy: 'ambient',
    capture: true,
    maxOutputBytes: 4 * 1024 * 1024,
    timeoutMs: step.timeoutMs,
    signal: step.signal,
  });
  const decoder = new TextDecoder();
  const stdout = decoder.decode(result.stdout);
  return {
    ok: result.exitCode === 0,
    exit: String(result.exitCode ?? result.signal),
    stdout,
    output: `${decoder.decode(result.stderr)}${stdout}`.trim(),
  };
}

const MetafileSchema = z.object({
  inputs: z.record(
    z.string(),
    z.object({
      imports: z
        .array(
          z.object({
            path: z.string(),
            original: z.string().optional(),
            external: z.boolean().default(false),
          }),
        )
        .default([]),
    }),
  ),
  outputs: z
    .record(
      z.string(),
      z.object({
        entryPoint: z.string().optional(),
        exports: z.array(z.string()).default([]),
      }),
    )
    .default({}),
});

/** One import a bundled module makes. */
export interface ClientGraphImport {
  /** Absolute path of a bundled module; the specifier as written when `external`. */
  path: string;
  /** The specifier of a bundled import as the source wrote it. */
  original: string | undefined;
  /** Left outside the output: a platform module, a peer or a dependency. */
  external: boolean;
}

/** The module graph of one build, with every bundled module named by its real path. */
export interface ClientBuildGraph {
  /** Bundled module → the imports it makes. */
  modules: ReadonlyMap<string, readonly ClientGraphImport[]>;
  /** Entry module → its output file, relative to the output directory. */
  entryOutputs: ReadonlyMap<string, string>;
}

/**
 * Read the bundler's metafile. The bundler names modules relative to `root`,
 * where it ran; a rule is written against real paths, so bundled modules become
 * absolute. An external import has no path — its specifier is kept as written.
 */
export async function readClientBuildGraph(
  metafilePath: string,
  root: string,
): Promise<ClientBuildGraph> {
  const metafile = MetafileSchema.parse(safeJsonParse(await readFile(metafilePath, 'utf8')));
  const absolute = (path: string): string => resolve(root, path).replaceAll('\\', '/');
  const modules = new Map<string, ClientGraphImport[]>();
  for (const [path, input] of Object.entries(metafile.inputs)) {
    modules.set(
      absolute(path),
      input.imports.map((imported) => ({
        path: imported.external ? imported.path : absolute(imported.path),
        original: imported.original,
        external: imported.external,
      })),
    );
  }
  const entryOutputs = new Map<string, string>();
  for (const [path, output] of Object.entries(metafile.outputs)) {
    if (output.entryPoint === undefined) continue;
    entryOutputs.set(absolute(output.entryPoint), path.replace(/^\.\//, ''));
  }
  return { modules, entryOutputs };
}

function matchesPath(rule: ForbiddenModule, modulePath: string): boolean {
  if (rule instanceof RegExp) return rule.test(modulePath);
  // A package name (bare or scoped) matches only as an installed package: a
  // bare `ink` must not refuse `src/thinking.ts`. Anything else with a slash is
  // a fragment of the project's own source path.
  if (rule.startsWith('@') || !rule.includes('/')) {
    return modulePath.includes(`/node_modules/${rule}/`);
  }
  return modulePath.includes(rule.startsWith('/') ? rule : `/${rule}`);
}

/** Whether an import specifier names the rule: the package or subpath itself, or a path inside it. */
function namesPackage(specifier: string | undefined, rule: ForbiddenModule): boolean {
  return (
    typeof rule === 'string' &&
    specifier !== undefined &&
    (specifier === rule || specifier.startsWith(`${rule}/`))
  );
}

/** Throw `ForbiddenModuleError` for the first module of the graph a rule forbids. */
export function refuseForbiddenModules(
  graph: ClientBuildGraph,
  forbidden: readonly ForbiddenModule[],
): void {
  // By specifier first: a linked or workspace package resolves to a real path
  // outside `node_modules`, and an external import has no path at all — only the
  // import that names it says what it is.
  for (const [importer, imports] of graph.modules) {
    for (const imported of imports) {
      const specifier = imported.external ? imported.path : imported.original;
      if (forbidden.some((rule) => namesPackage(specifier, rule))) {
        throw new ForbiddenModuleError(imported.path, importer);
      }
    }
  }
  for (const modulePath of graph.modules.keys()) {
    if (!forbidden.some((rule) => matchesPath(rule, modulePath))) continue;
    const importer = [...graph.modules].find(([, imports]) =>
      imports.some((imported) => !imported.external && imported.path === modulePath),
    );
    throw new ForbiddenModuleError(modulePath, importer?.[0]);
  }
}
