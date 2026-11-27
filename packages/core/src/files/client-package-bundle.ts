/**
 * The one build of a client package: every entry in one pass, peers outside,
 * and the modules the caller replaces taken as the contents given for them.
 *
 * The bundler's command line takes no plugin, and replacing a module is a
 * plugin. So the build is a script that calls `Bun.build` with the options the
 * command line spelled, written beside the build's other temporary files and run
 * by the same bounded `bun` — the package build keeps working from Node.
 */
import { realpathSync } from 'node:fs';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ClientBuildGraph,
  type ClientBuildStep,
  readClientBuildGraph,
  runClientTool,
} from './client-build';
import { ClientPackageError } from './client-package-contract';

/** Extension of a replaced module → the loader its replacement contents are read with. */
export const REPLACEMENT_LOADERS: Readonly<Record<string, string>> = {
  '.json': 'json',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
};

/** What one build of a client package needs. */
export interface ClientPackageBundleInput {
  step: ClientBuildStep;
  bun: string;
  /** The build root: the tsconfig's directory, where the bundler runs. */
  root: string;
  tsconfig: string;
  entries: readonly string[];
  external: readonly string[];
  runtime: 'node' | 'bun' | 'browser';
  /** Absolute path of a replaced module → its contents. */
  replacements: ReadonlyMap<string, string>;
  /** The temporary directory the script, its config and the metafile go to. */
  work: string;
  outdir: string;
}

/**
 * Runs in Bun: the build `bun build --splitting` ran, with a plugin that loads
 * each replaced module from the contents given for it.
 */
const BUNDLE_SCRIPT = `const config = JSON.parse(await Bun.file(process.argv[2]).text());
const replacements = new Map(Object.entries(config.replacements));
const escape = (text) => text.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
const loaderOf = (path) => config.loaders[path.slice(path.lastIndexOf('.'))];
const plugins =
  replacements.size === 0
    ? []
    : [
        {
          name: 'stitchkit-replace-modules',
          setup(build) {
            const filter = new RegExp(\`^(?:\${[...replacements.keys()].map(escape).join('|')})$\`);
            build.onLoad({ filter }, (args) => ({
              contents: replacements.get(args.path),
              loader: loaderOf(args.path),
            }));
          },
        },
      ];
try {
  const result = await Bun.build({
    entrypoints: config.entries,
    root: config.root,
    outdir: config.outdir,
    target: config.target,
    format: 'esm',
    splitting: true,
    external: config.external,
    naming: { entry: '[dir]/[name].[ext]', chunk: 'chunks/[name]-[hash].[ext]' },
    tsconfig: config.tsconfig,
    metafile: true,
    plugins,
    throw: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    process.exit(1);
  }
  await Bun.write(config.metafile, JSON.stringify(result.metafile));
} catch (error) {
  console.error(String(error?.stack ?? error));
  process.exit(1);
}
`;

/**
 * Build every entry in one pass, so a module two of them import is emitted
 * once, and refuse a replacement that no bundled module imports.
 */
export async function bundleClientPackage(
  input: ClientPackageBundleInput,
): Promise<ClientBuildGraph> {
  const script = join(input.work, 'bundle.mjs');
  const config = join(input.work, 'bundle.json');
  const metafile = join(input.work, 'meta.json');
  await writeFile(script, BUNDLE_SCRIPT);
  await writeFile(
    config,
    JSON.stringify({
      entries: input.entries,
      root: input.root,
      outdir: input.outdir,
      target: input.runtime,
      external: input.external,
      tsconfig: input.tsconfig,
      metafile,
      // The bundler may load a module by its real path or by the one it was imported through.
      replacements: Object.fromEntries(
        [...input.replacements].flatMap(([path, contents]) => [
          [path, contents],
          [realpathSync(path), contents],
        ]),
      ),
      loaders: REPLACEMENT_LOADERS,
    }),
  );
  const built = await runClientTool(input.step, input.bun, [script, config], input.root);
  if (!built.ok) {
    throw new ClientPackageError(
      'build',
      `Client package build failed (exit ${built.exit}): ${built.output}`,
      { output: built.output },
    );
  }
  const graph = await readClientBuildGraph(metafile, input.root);
  const bundled = new Set<string>();
  for (const module of graph.modules.keys())
    bundled.add(await realpath(module).catch(() => module));
  for (const module of input.replacements.keys()) {
    if (bundled.has(realpathSync(module))) continue;
    throw new ClientPackageError(
      'replacement-unused',
      `Client package replaces ${module}, which no bundled module imports`,
      { module },
    );
  }
  return graph;
}
