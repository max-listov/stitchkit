/**
 * A typed client as an npm package: several entries, one module graph.
 *
 * A client published to a registry is not a file a consumer copies. It has
 * subpaths, and a schema or an error class two of them export must be one
 * object, or `instanceof` and branded schemas disagree between the halves of
 * one package — which is what two separate builds of two entries produce. It
 * has declarations, which every consumer resolves again under its own module
 * resolution. And its peers stay the consumer's: a second copy of the contract
 * layer inside the client is the same split one level down.
 *
 * So all entries are built in one pass with the peers left outside, the
 * declarations are emitted for that graph and made resolvable, and the packed
 * archive is installed into an empty directory and used there before it is
 * returned (`client-package-proof.ts`). Publishing it is the caller's release.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import {
  type ClientBuildGraph,
  type ClientBuildStep,
  type ClientToolCommand,
  readClientBuildGraph,
  refuseForbiddenModules,
  runClientTool,
} from './client-build';
import { emitClientDeclarations, normalizeClientDeclarations } from './client-declarations';
import {
  CLIENT_PACKAGE_OWNED_FIELDS,
  type ClientPackage,
  ClientPackageError,
  ClientPackageManifestSchema,
  type ClientPackageOptions,
} from './client-package-contract';
import {
  type ExternalPackage,
  proveClientPackage,
  resolveExternalPackage,
} from './client-package-proof';

const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/** What the options resolve to before anything runs. */
interface ClientPackagePlan {
  /** The tsconfig's directory: the build root. */
  root: string;
  tsconfig: string;
  /** Package subpath → absolute entry module. */
  entries: ReadonlyMap<string, string>;
  /** Names of every peer and dependency. */
  external: readonly string[];
  manifest: Readonly<Record<string, unknown>>;
  /** Path inside the package → absolute source file. */
  files: ReadonlyMap<string, string>;
  tarball: string;
}

/** Refuse malformed options before any tool runs; a caller's mistake is a `TypeError`. */
function plan(options: ClientPackageOptions): ClientPackagePlan {
  if (!PACKAGE_NAME.test(options.name)) {
    throw new TypeError(
      `Client package name ${JSON.stringify(options.name)} is not a package name`,
    );
  }
  const tsconfig = resolve(options.tsconfig);
  const root = dirname(tsconfig);
  const entries = new Map<string, string>();
  for (const [subpath, source] of Object.entries(options.entries)) {
    const entry = resolve(source);
    const inside = relative(root, entry);
    if (subpath !== '.' && !/^\.\/[^/]/.test(subpath)) {
      throw new TypeError(
        `Client package entry ${JSON.stringify(subpath)} is not "." or "./name"`,
      );
    }
    if (inside.startsWith('..') || isAbsolute(inside) || !/\.tsx?$/.test(entry)) {
      throw new TypeError(
        `Client package entry ${source} must be a .ts or .tsx module under ${root}, the tsconfig's directory`,
      );
    }
    if ([...entries.values()].includes(entry)) {
      throw new TypeError(`Client package entry ${source} is listed under two subpaths`);
    }
    entries.set(subpath, entry);
  }
  if (entries.size === 0) throw new TypeError('Client package has no entries');
  const peers = Object.keys(options.peerDependencies ?? {});
  const dependencies = Object.keys(options.dependencies ?? {});
  const both = peers.find((name) => dependencies.includes(name));
  if (both !== undefined) {
    throw new TypeError(`Client package lists "${both}" as both a peer and a dependency`);
  }
  const manifest = ClientPackageManifestSchema.parse(options.manifest ?? {});
  const owned = Object.keys(manifest).find((field) =>
    CLIENT_PACKAGE_OWNED_FIELDS.includes(field),
  );
  if (owned !== undefined) {
    throw new ClientPackageError(
      'manifest-owned-field',
      `Client package manifest sets "${owned}", which the build writes itself`,
      { field: owned },
    );
  }
  const files = new Map<string, string>();
  for (const [target, source] of Object.entries(options.files ?? {})) {
    const path = normalize(target).replaceAll('\\', '/');
    if (
      isAbsolute(path) ||
      path.startsWith('..') ||
      path === 'package.json' ||
      /^dist(\/|$)/.test(path)
    ) {
      throw new TypeError(
        `Client package file ${JSON.stringify(target)} must be a path inside the package, outside dist/`,
      );
    }
    files.set(path, resolve(source));
  }
  return {
    root,
    tsconfig,
    entries,
    external: [...peers, ...dependencies],
    manifest,
    files,
    tarball: join(
      resolve(options.outDir),
      `${options.name.replace(/^@/, '').replaceAll('/', '-')}-${options.version}.tgz`,
    ),
  };
}

/** Build every entry in one pass, so a module two of them import is emitted once. */
async function bundle(
  options: ClientPackageOptions,
  planned: ClientPackagePlan,
  step: ClientBuildStep,
  bun: string,
  work: string,
): Promise<ClientBuildGraph> {
  const metafile = join(work, 'meta.json');
  const built = await runClientTool(
    step,
    bun,
    [
      'build',
      ...planned.entries.values(),
      `--root=${planned.root}`,
      `--outdir=${join(work, 'package', 'dist')}`,
      `--target=${options.runtime ?? 'node'}`,
      '--format=esm',
      '--splitting',
      ...planned.external.map((name) => `--external=${name}`),
      '--entry-naming=[dir]/[name].[ext]',
      '--chunk-naming=chunks/[name]-[hash].[ext]',
      `--tsconfig-override=${planned.tsconfig}`,
      `--metafile=${metafile}`,
    ],
    planned.root,
  );
  if (!built.ok) {
    throw new ClientPackageError(
      'build',
      `Client package build failed (exit ${built.exit}): ${built.output}`,
      { output: built.output },
    );
  }
  return readClientBuildGraph(metafile, planned.root);
}

/**
 * Refuse a graph that holds code of a peer or dependency. Leaving a package
 * external covers the imports that name it; an import that reaches into its
 * directory by path — a workspace neighbour — bundles it all the same.
 */
async function refuseBundledExternals(
  graph: ClientBuildGraph,
  externals: ReadonlyMap<string, ExternalPackage>,
): Promise<void> {
  for (const module of graph.modules.keys()) {
    const real = await realpath(module);
    for (const [name, external] of externals) {
      if (!real.startsWith(`${external.directory}/`)) continue;
      throw new ClientPackageError(
        'bundled-peer',
        `Client package bundles ${module}, which is code of "${name}"; import it by the package name`,
        { package: name, module },
      );
    }
  }
}

/** Write the manifest and the extra files beside the built `dist/`. */
async function stage(
  options: ClientPackageOptions,
  planned: ClientPackagePlan,
  graph: ClientBuildGraph,
  staged: string,
): Promise<void> {
  const exported: Record<string, { types: string; import: string }> = {};
  for (const [subpath, entry] of planned.entries) {
    const output = graph.entryOutputs.get(entry);
    const types = output?.replace(/\.js$/, '.d.ts');
    if (
      output === undefined ||
      types === undefined ||
      !existsSync(join(staged, 'dist', types))
    ) {
      throw new ClientPackageError(
        'declarations',
        `Client package entry ${entry} has no built module with a declaration beside it`,
        { entry, subpath },
      );
    }
    exported[subpath] = { types: `./dist/${types}`, import: `./dist/${output}` };
  }
  for (const [target, source] of planned.files) {
    await mkdir(dirname(join(staged, target)), { recursive: true });
    await copyFile(source, join(staged, target));
  }
  const present = (record: Readonly<Record<string, string>> | undefined) =>
    record !== undefined && Object.keys(record).length > 0 ? record : undefined;
  await writeFile(
    join(staged, 'package.json'),
    `${JSON.stringify(
      {
        name: options.name,
        version: options.version,
        ...planned.manifest,
        type: 'module',
        exports: exported,
        files: ['dist', ...planned.files.keys()],
        peerDependencies: present(options.peerDependencies),
        dependencies: present(options.dependencies),
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Build a typed client as an npm package and prove the packed archive.
 *
 * Every entry is built in one pass over one module graph, with peers and
 * dependencies left outside; declarations are emitted for that graph and
 * rewritten to resolve under both Bundler and NodeNext resolution; the archive
 * is then installed into an empty directory beside its peers, every subpath is
 * imported in each runtime, a name several subpaths export is checked to be one
 * value, and a strict consumer is typechecked under both resolutions.
 *
 * A refusal is a `ClientPackageError` with a `reason`, or a
 * `ForbiddenModuleError`. No archive is left at the output path when the build
 * or the proof refuses: one from an earlier build is removed first.
 */
export async function buildClientPackage(
  options: ClientPackageOptions,
): Promise<ClientPackage> {
  const planned = plan(options);
  const step: ClientBuildStep = {
    timeoutMs: options.timeoutMs ?? 120_000,
    signal: options.signal,
  };
  const bun = options.executables?.bun ?? 'bun';
  const work = await mkdtemp(join(tmpdir(), 'stitchkit-client-package-'));
  await rm(planned.tarball, { force: true });
  try {
    const externals = new Map<string, ExternalPackage>();
    for (const name of planned.external) {
      externals.set(name, await resolveExternalPackage(planned.root, name));
    }
    // The project's compiler is a script: the runtime running this build runs it too, so the
    // default needs neither a shebang nor a second runtime on `PATH`.
    const tsc: ClientToolCommand =
      options.executables?.tsc !== undefined
        ? [options.executables.tsc]
        : [
            process.execPath,
            join(
              (await resolveExternalPackage(planned.root, 'typescript')).directory,
              'bin',
              'tsc',
            ),
          ];
    const staged = join(work, 'package');
    const graph = await bundle(options, planned, step, bun, work);
    refuseForbiddenModules(graph, options.forbiddenModules ?? []);
    await refuseBundledExternals(graph, externals);

    await emitClientDeclarations({
      step,
      tsc,
      tsconfig: planned.tsconfig,
      entries: [...planned.entries.values()],
      outDir: join(staged, 'dist'),
    });
    normalizeClientDeclarations(join(staged, 'dist'), {
      packages: new Set(planned.external),
      runtime: options.runtime ?? 'node',
    });
    await stage(options, planned, graph, staged);

    await mkdir(dirname(planned.tarball), { recursive: true });
    const packed = await runClientTool(
      step,
      bun,
      ['pm', 'pack', '--filename', planned.tarball, '--ignore-scripts', '--quiet'],
      staged,
    );
    if (!packed.ok) {
      throw new ClientPackageError(
        'install',
        `Client package pack failed (exit ${packed.exit}): ${packed.output}`,
        { output: packed.output },
      );
    }
    const consumer = join(work, 'consumer');
    await mkdir(consumer);
    const proven = await proveClientPackage({
      options,
      step,
      tools: { bun, node: options.executables?.node ?? 'node', tsc },
      consumer,
      staged,
      tarball: planned.tarball,
      externals,
      root: planned.root,
    });
    const archive = await readFile(planned.tarball);
    return {
      tarball: planned.tarball,
      sha256: createHash('sha256').update(archive).digest('hex'),
      bytes: archive.byteLength,
      modules: [...graph.modules.keys()].sort(),
      ...proven,
    };
  } catch (error) {
    // An archive that could not be proven leaves nothing that looks proven.
    await rm(planned.tarball, { force: true });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
