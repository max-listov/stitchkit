/**
 * A client as one file a consumer can take without the package it came from.
 *
 * A package that owns a server usually ships a typed client for it, and the
 * consumers of that client must not inherit the server's dependency tree: a
 * terminal UI, a process supervisor, a provider SDK. So the client is bundled
 * into a single self-contained file, its hash is published beside it, and —
 * because "self-contained" is a claim a later import can silently break — the
 * build refuses a bundle whose module graph reaches a forbidden module, and an
 * optional npm archive is proven installable and importable in an empty
 * directory before it is returned.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { safeJsonParse } from '../internal/safe-json';
import { runNativeCommand } from '../process/command';

/** A module the artifact must not contain: a package name, or a pattern over the module path. */
export type ForbiddenModule = string | RegExp;

/** What `buildClientArtifact` builds from, where it writes and what it must refuse or prove. */
export interface ClientArtifactOptions {
  /** The client's entry module. */
  entry: string;
  /** Where the self-contained file is written; `<outFile>.sha256` is written beside it. */
  outFile: string;
  /** The runtime the file is built for. Default `node`, which Bun also runs. */
  runtime?: 'node' | 'bun' | 'browser';
  /**
   * Modules that must not be in the bundle. A bare or scoped name
   * (`'chalk'`, `'@scope/name'`) is a package, matched by the specifier that
   * imports it and by its installed path; a string with a slash is a fragment
   * of the project's own source path (`'src/terminal/'`); a `RegExp` is tested
   * against each module's absolute path.
   */
  forbiddenModules?: readonly ForbiddenModule[];
  /**
   * Also pack an npm archive and prove it: installed into an empty directory,
   * imported by name, and exporting every name in `exports`.
   */
  package?: {
    name: string;
    version: string;
    /** Directory the `.tgz` is written to. */
    outDir: string;
    /** Names the installed package must export. */
    exports?: readonly string[];
  };
  /** The Bun executable that builds, packs and verifies. Default `bun` on `PATH`. */
  executable?: string;
  /** Deadline of each build, pack and verification step. Default 120 000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A built client: the file, its SHA-256, the modules inside it and the verified archive. */
export interface ClientArtifact {
  /** Absolute path of the self-contained file. */
  file: string;
  /** Lowercase hex SHA-256 of the file. */
  sha256: string;
  bytes: number;
  /** Absolute path of the `<sha256>  <name>` file beside it. */
  sha256File: string;
  /** Absolute path of every module bundled into the file. */
  modules: string[];
  /** The verified npm archive, when `package` was asked for. */
  package?: { tarball: string; sha256: string };
}

/** The refusal of a bundle that reaches a forbidden module. */
export class ForbiddenModuleError extends Error {
  constructor(
    /** The forbidden module found in the bundle. */
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

const MetafileSchema = z.object({
  inputs: z.record(
    z.string(),
    z.object({
      imports: z
        .array(z.object({ path: z.string(), original: z.string().optional() }))
        .default([]),
    }),
  ),
});

function matches(rule: ForbiddenModule, modulePath: string): boolean {
  if (rule instanceof RegExp) return rule.test(modulePath);
  // A package name (bare or scoped) matches only as an installed package: a
  // bare `ink` must not refuse `src/thinking.ts`. Anything else with a slash is
  // a fragment of the project's own source path.
  if (rule.startsWith('@') || !rule.includes('/')) {
    return modulePath.includes(`/node_modules/${rule}/`);
  }
  return modulePath.includes(rule.startsWith('/') ? rule : `/${rule}`);
}

/** The bundler names modules relative to where it ran; a rule is written against real paths. */
function absoluteModules(
  metafile: z.output<typeof MetafileSchema>,
  root: string,
): z.output<typeof MetafileSchema> {
  const absolute = (path: string): string => resolve(root, path).replaceAll('\\', '/');
  return {
    inputs: Object.fromEntries(
      Object.entries(metafile.inputs).map(([path, input]) => [
        absolute(path),
        {
          imports: input.imports.map((imported) => ({
            path: absolute(imported.path),
            original: imported.original,
          })),
        },
      ]),
    ),
  };
}

/** Whether an import specifier names the package: `pkg` itself or a path inside it. */
function namesPackage(specifier: string | undefined, rule: ForbiddenModule): boolean {
  return (
    typeof rule === 'string' &&
    specifier !== undefined &&
    (specifier === rule || specifier.startsWith(`${rule}/`))
  );
}

function refuseForbidden(
  metafile: z.output<typeof MetafileSchema>,
  forbidden: readonly ForbiddenModule[],
): void {
  // By specifier first: a linked or workspace package resolves to a real path
  // outside `node_modules`, and only the import that names it says what it is.
  for (const [importer, input] of Object.entries(metafile.inputs)) {
    const named = input.imports.find((imported) =>
      forbidden.some((rule) => namesPackage(imported.original, rule)),
    );
    if (named) throw new ForbiddenModuleError(named.path, importer);
  }
  for (const modulePath of Object.keys(metafile.inputs)) {
    if (!forbidden.some((rule) => matches(rule, modulePath))) continue;
    const importer = Object.entries(metafile.inputs).find(([, input]) =>
      input.imports.some((imported) => imported.path === modulePath),
    );
    throw new ForbiddenModuleError(modulePath, importer?.[0]);
  }
}

interface Step {
  bun: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** One bounded `bun` invocation; a non-zero exit carries the tool's own output. */
async function bun(step: Step, args: string[], cwd: string, what: string): Promise<string> {
  const result = await runNativeCommand({
    executable: step.bun,
    args,
    cwd,
    envPolicy: 'ambient',
    capture: true,
    maxOutputBytes: 4 * 1024 * 1024,
    timeoutMs: step.timeoutMs,
    signal: step.signal,
  });
  const decoder = new TextDecoder();
  if (result.exitCode !== 0) {
    throw new Error(
      `Client artifact ${what} failed (exit ${result.exitCode ?? result.signal}): ` +
        `${decoder.decode(result.stderr)}${decoder.decode(result.stdout)}`.trim(),
    );
  }
  return decoder.decode(result.stdout);
}

/**
 * Build one self-contained client file with its SHA-256, and optionally a
 * verified npm archive of it.
 *
 * Nothing is left at `outFile` when the build is refused: a file from an
 * earlier build is removed first, so a failed build cannot be mistaken for a
 * fresh artifact.
 */
export async function buildClientArtifact(
  options: ClientArtifactOptions,
): Promise<ClientArtifact> {
  const step: Step = {
    bun: options.executable ?? 'bun',
    timeoutMs: options.timeoutMs ?? 120_000,
    signal: options.signal,
  };
  const file = resolve(options.outFile);
  const sha256File = `${file}.sha256`;
  const work = await mkdtemp(join(tmpdir(), 'stitchkit-client-artifact-'));
  try {
    await rm(file, { force: true });
    await rm(sha256File, { force: true });
    const root = dirname(resolve(options.entry));
    const built = join(work, 'client.js');
    const metafilePath = join(work, 'meta.json');
    await bun(
      step,
      [
        'build',
        resolve(options.entry),
        `--target=${options.runtime ?? 'node'}`,
        '--format=esm',
        `--outfile=${built}`,
        `--metafile=${metafilePath}`,
      ],
      root,
      'build',
    );
    const metafile = absoluteModules(
      MetafileSchema.parse(safeJsonParse(await readFile(metafilePath, 'utf8'))),
      root,
    );
    refuseForbidden(metafile, options.forbiddenModules ?? []);

    const bytes = await readFile(built);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    await writeFile(sha256File, `${digest}  ${basename(file)}\n`);
    const artifact: ClientArtifact = {
      file,
      sha256: digest,
      bytes: bytes.byteLength,
      sha256File,
      modules: Object.keys(metafile.inputs).sort(),
    };
    if (options.package === undefined) return artifact;
    try {
      return { ...artifact, package: await packAndVerify(step, work, bytes, options.package) };
    } catch (error) {
      // An archive that could not be proven leaves no artifact that looks proven.
      await rm(file, { force: true });
      await rm(sha256File, { force: true });
      throw error;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Pack the file as an npm archive, then install and import it somewhere empty. */
async function packAndVerify(
  step: Step,
  work: string,
  bytes: Uint8Array,
  target: NonNullable<ClientArtifactOptions['package']>,
): Promise<NonNullable<ClientArtifact['package']>> {
  const source = join(work, 'package');
  await mkdir(source);
  await writeFile(join(source, 'index.js'), bytes);
  await writeFile(
    join(source, 'package.json'),
    `${JSON.stringify(
      {
        name: target.name,
        version: target.version,
        type: 'module',
        main: './index.js',
        exports: { '.': './index.js' },
        files: ['index.js'],
      },
      null,
      2,
    )}\n`,
  );
  const outDir = resolve(target.outDir);
  await mkdir(outDir, { recursive: true });
  const tarball = join(
    outDir,
    `${target.name.replace(/^@/, '').replaceAll('/', '-')}-${target.version}.tgz`,
  );
  await bun(step, ['pm', 'pack', '--filename', tarball, '--quiet'], source, 'pack');

  // The proof: a directory that has nothing but this archive. An import that
  // resolves here resolves for a consumer; one that reached for the building
  // package's own node_modules fails here and nowhere earlier.
  const consumer = join(work, 'consumer');
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    '{"name":"client-artifact-consumer","private":true,"type":"module"}\n',
  );
  await bun(step, ['add', tarball], consumer, 'install');
  await writeFile(
    join(consumer, 'verify.mjs'),
    `const client = await import(${JSON.stringify(target.name)});\n` +
      `const missing = ${JSON.stringify(target.exports ?? [])}.filter((name) => !(name in client));\n` +
      `if (missing.length > 0) { console.error('missing exports: ' + missing.join(', ')); process.exit(1); }\n`,
  );
  await bun(step, ['verify.mjs'], consumer, 'import verification');
  return {
    tarball,
    sha256: createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex'),
  };
}
