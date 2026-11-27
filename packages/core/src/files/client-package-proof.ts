/**
 * The proof of a client package: the packed archive installed into a directory
 * that has nothing else, then used the way a consumer uses it.
 *
 * A build that inspects its own output directory proves the output directory.
 * A consumer gets an archive, resolves it through `exports`, shares its peers
 * with it and typechecks against its declarations under its own module
 * resolution — so that is what runs here, on the archive, before it is returned.
 * Peers and dependencies are installed from where the build resolved them: the
 * versions the client was built and typed against are the versions proven.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { safeJsonParse } from '../internal/safe-json';
import {
  type ClientBuildStep,
  type ClientToolCommand,
  type ClientToolResult,
  runClientTool,
} from './client-build';
import {
  type ClientPackage,
  ClientPackageError,
  type ClientPackageOptions,
} from './client-package-contract';

/** Where a package the build leaves outside is installed, and which version that is. */
export interface ExternalPackage {
  /** Real path of the installed package. */
  directory: string;
  version: string;
}

const InstalledManifestSchema = z.object({ version: z.string() });

/**
 * Find a package the way a module in `from` would: the nearest
 * `node_modules/<name>` up the tree. The real path is returned, so a linked or
 * workspace package is known by where its code actually is.
 */
export async function resolveExternalPackage(
  from: string,
  name: string,
): Promise<ExternalPackage> {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      const real = await realpath(candidate);
      const manifest = InstalledManifestSchema.parse(
        safeJsonParse(await readFile(join(real, 'package.json'), 'utf8')),
      );
      return { directory: real, version: manifest.version };
    }
    if (dirname(directory) === directory) {
      throw new ClientPackageError(
        'install',
        `Client package needs "${name}" installed where it is built, and ${from} does not resolve it`,
        { package: name },
      );
    }
  }
}

/** Every regular file under `directory`, as paths relative to it, skipping `node_modules`. */
async function filesUnder(directory: string, base = directory): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...(await filesUnder(path, base)));
    } else {
      files.push(relative(base, path).replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

const IdentityReportSchema = z.object({
  exports: z.record(z.string(), z.array(z.string())),
  shared: z.array(z.string()),
  split: z.array(z.string()),
});

/** Imports every subpath by the package name and compares what several of them export. */
function identityScript(name: string, subpaths: readonly string[]): string {
  return `const name = ${JSON.stringify(name)};
const subpaths = ${JSON.stringify(subpaths)};
const namespaces = {};
for (const subpath of subpaths) {
  namespaces[subpath] = await import(subpath === '.' ? name : name + subpath.slice(1));
}
const exported = {};
const owners = new Map();
for (const subpath of subpaths) {
  exported[subpath] = Object.keys(namespaces[subpath]).sort();
  for (const key of exported[subpath]) owners.set(key, [...(owners.get(key) ?? []), subpath]);
}
const shared = [];
const split = [];
for (const [key, list] of owners) {
  if (list.length < 2) continue;
  const first = namespaces[list[0]][key];
  (list.every((subpath) => Object.is(namespaces[subpath][key], first)) ? shared : split).push(key);
}
process.stdout.write(JSON.stringify({ exports: exported, shared: shared.sort(), split: split.sort() }));
`;
}

const RangeReportSchema = z.array(
  z.object({ package: z.string(), range: z.string(), installed: z.string() }),
);

/** Runs in Bun, which owns the range grammar its installer applies. */
const RANGE_SCRIPT = `const declared = JSON.parse(await Bun.file('ranges.json').text());
const outside = declared.filter((entry) => !Bun.semver.satisfies(entry.installed, entry.range));
process.stdout.write(JSON.stringify(outside));
`;

/** What the proof needs from the build. */
export interface ClientPackageProofInput {
  options: ClientPackageOptions;
  step: ClientBuildStep;
  tools: { bun: string; node: string; tsc: ClientToolCommand };
  /** An empty directory the consumer is created in. */
  consumer: string;
  /** The staged package directory the archive was packed from. */
  staged: string;
  tarball: string;
  /** Every peer and dependency → where the build resolved it. */
  externals: ReadonlyMap<string, ExternalPackage>;
  /** The project directory type packages are resolved from. */
  root: string;
}

type ProvenPackage = Pick<ClientPackage, 'files' | 'exports' | 'sharedExports' | 'proof'>;

function ranOrRefuse(
  result: ClientToolResult,
  reason: 'install' | 'typecheck',
  what: string,
  details: Readonly<Record<string, unknown>> = {},
): ClientToolResult {
  if (result.ok) return result;
  throw new ClientPackageError(
    reason,
    `Client package ${what} failed (exit ${result.exit}): ${result.output}`,
    { ...details, output: result.output },
  );
}

/** Install the archive beside its peers in an empty consumer, exactly as packed. */
async function install(input: ClientPackageProofInput): Promise<ProvenPackage['files']> {
  const { options, consumer } = input;
  const peers = Object.keys(options.peerDependencies ?? {});
  const fromBuild = (names: readonly string[]): Record<string, string> =>
    Object.fromEntries(
      names.map((name) => [name, `file:${input.externals.get(name)?.directory ?? ''}`]),
    );
  const types: Record<string, string> = {};
  for (const name of options.proof?.types ?? []) {
    types[name] = `file:${(await resolveExternalPackage(input.root, name)).directory}`;
  }
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'client-package-consumer',
        private: true,
        type: 'module',
        dependencies: {
          ...types,
          ...fromBuild(peers),
          [options.name]: `file:${input.tarball}`,
        },
        // The archive's own dependencies resolve to what the build resolved.
        overrides: fromBuild(Object.keys(options.dependencies ?? {})),
      },
      null,
      2,
    )}\n`,
  );
  ranOrRefuse(
    await runClientTool(
      input.step,
      input.tools.bun,
      ['install', '--ignore-scripts'],
      consumer,
    ),
    'install',
    'install',
  );

  const installed = join(consumer, 'node_modules', options.name);
  for (const peer of peers) {
    if (!existsSync(join(installed, 'node_modules', peer))) continue;
    throw new ClientPackageError(
      'bundled-peer',
      `Client package installs its own copy of peer "${peer}" instead of sharing the consumer's`,
      { package: peer },
    );
  }
  const files: { path: string; sha256: string; bytes: number }[] = [];
  for (const path of await filesUnder(input.staged)) {
    const packed = await readFile(join(input.staged, path));
    const digest = createHash('sha256').update(packed).digest('hex');
    const unpacked = existsSync(join(installed, path))
      ? createHash('sha256')
          .update(await readFile(join(installed, path)))
          .digest('hex')
      : undefined;
    if (unpacked !== digest) {
      throw new ClientPackageError(
        'install',
        `Client package file ${path} is not in the installed archive as it was built`,
        { file: path },
      );
    }
    files.push({ path, sha256: digest, bytes: packed.byteLength });
  }
  return files;
}

/** Refuse a peer or dependency whose installed version its declared range does not admit. */
async function proveRanges(input: ClientPackageProofInput): Promise<Record<string, string>> {
  const { options, consumer } = input;
  const declared = { ...options.dependencies, ...options.peerDependencies };
  const installedVersions: Record<string, string> = {};
  for (const name of Object.keys(declared)) {
    // A dependency of the archive may be nested under it; a peer never is.
    const manifest = [join(options.name, 'node_modules', name), name]
      .map((path) => join(consumer, 'node_modules', path, 'package.json'))
      .find((path) => existsSync(path));
    if (manifest === undefined) {
      throw new ClientPackageError(
        'install',
        `Client package was installed without "${name}"`,
        { package: name },
      );
    }
    installedVersions[name] = InstalledManifestSchema.parse(
      safeJsonParse(await readFile(manifest, 'utf8')),
    ).version;
  }
  await writeFile(
    join(consumer, 'ranges.json'),
    JSON.stringify(
      Object.entries(declared).map(([name, range]) => ({
        package: name,
        range,
        installed: installedVersions[name] ?? '',
      })),
    ),
  );
  await writeFile(join(consumer, 'ranges.mjs'), RANGE_SCRIPT);
  const ran = ranOrRefuse(
    await runClientTool(input.step, input.tools.bun, ['ranges.mjs'], consumer),
    'install',
    'range check',
  );
  const [outside] = RangeReportSchema.parse(safeJsonParse(ran.stdout));
  if (outside !== undefined) {
    throw new ClientPackageError(
      'peer-range',
      `Client package declares "${outside.package}" as ${outside.range}, ` +
        `but it is built and proven against ${outside.installed}`,
      outside,
    );
  }
  return installedVersions;
}

/** Import every subpath in each runtime; refuse a missing name and a value that differs between subpaths. */
async function proveIdentity(
  input: ClientPackageProofInput,
): Promise<
  Pick<ProvenPackage, 'exports' | 'sharedExports'> & { runtimes: ('node' | 'bun')[] }
> {
  const { options, consumer } = input;
  const subpaths = Object.keys(options.entries);
  await writeFile(join(consumer, 'identity.mjs'), identityScript(options.name, subpaths));
  const runtimes: ('node' | 'bun')[] =
    (options.runtime ?? 'node') === 'node' ? ['node', 'bun'] : ['bun'];
  const distinct = new Set(options.proof?.distinctExports ?? []);
  let first: z.output<typeof IdentityReportSchema> | undefined;
  for (const runtime of runtimes) {
    const ran = ranOrRefuse(
      await runClientTool(input.step, input.tools[runtime], ['identity.mjs'], consumer),
      'install',
      `import in ${runtime}`,
      { runtime },
    );
    const report = IdentityReportSchema.parse(safeJsonParse(ran.stdout));
    for (const [subpath, required] of Object.entries(options.proof?.exports ?? {})) {
      const names = required.filter((name) => !report.exports[subpath]?.includes(name));
      if (names.length === 0) continue;
      throw new ClientPackageError(
        'missing-export',
        `Client package subpath "${subpath}" does not export ${names.join(', ')} in ${runtime}`,
        { subpath, names, runtime },
      );
    }
    const names = report.split.filter((name) => !distinct.has(name));
    if (names.length > 0) {
      throw new ClientPackageError(
        'shared-export-split',
        `Client package exports ${names.join(', ')} from several subpaths as different values in ${runtime}`,
        { names, runtime },
      );
    }
    first ??= report;
  }
  return { exports: first?.exports ?? {}, sharedExports: first?.shared ?? [], runtimes };
}

const RESOLUTIONS = [
  { resolution: 'bundler', module: 'Preserve' },
  { resolution: 'NodeNext', module: 'NodeNext' },
] as const;

/** Typecheck a strict consumer of every subpath under both module resolutions. */
async function proveTypes(input: ClientPackageProofInput): Promise<string> {
  const { options, consumer } = input;
  const sources = ['exports.ts'];
  await writeFile(
    join(consumer, 'exports.ts'),
    Object.keys(options.entries)
      .map((subpath, index) => {
        const specifier = subpath === '.' ? options.name : options.name + subpath.slice(1);
        return `export * as E${index} from ${JSON.stringify(specifier)};\n`;
      })
      .join(''),
  );
  await mkdir(join(consumer, 'typecheck'));
  for (const [index, source] of (options.proof?.typecheck ?? []).entries()) {
    const copy = `typecheck/${index}-${basename(source)}`;
    await copyFile(source, join(consumer, copy));
    sources.push(copy);
  }
  const [compiler, ...leading] = input.tools.tsc;
  const version = ranOrRefuse(
    await runClientTool(input.step, compiler, [...leading, '--version'], consumer),
    'typecheck',
    'compiler',
  ).stdout.replace(/^Version\s+/, '');
  for (const { resolution, module } of RESOLUTIONS) {
    const config = `tsconfig.${resolution.toLowerCase()}.json`;
    // Written as a file: no flag spelling is shared by every compiler version.
    await writeFile(
      join(consumer, config),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          target: 'ES2022',
          module,
          moduleResolution: resolution,
          lib: ['ES2023', 'DOM'],
          types: (options.proof?.types ?? []).map((name) => name.replace(/^@types\//, '')),
        },
        files: sources,
      }),
    );
    ranOrRefuse(
      await runClientTool(input.step, compiler, [...leading, '-p', config], consumer),
      'typecheck',
      `consumer typecheck under ${resolution}`,
      { resolution },
    );
  }
  return version.trim();
}

/** Prove the packed archive; every refusal is a `ClientPackageError`. */
export async function proveClientPackage(
  input: ClientPackageProofInput,
): Promise<ProvenPackage> {
  const files = await install(input);
  const externals = await proveRanges(input);
  const identity = await proveIdentity(input);
  const typescript = await proveTypes(input);
  return {
    files,
    exports: identity.exports,
    sharedExports: identity.sharedExports,
    proof: {
      runtimes: identity.runtimes,
      resolutions: RESOLUTIONS.map(({ resolution }) => resolution),
      typescript,
      externals,
    },
  };
}
