import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { NativeLayoutSchema, nativeLoaderSource } from './native-packaging-layout';

const OutputPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[a-z]:/i.test(value) &&
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0),
    'Expected a relative output path without traversal',
  );
const OptionsSchema = z
  .object({
    platform: z.string().min(1),
    architecture: z.string().min(1),
    delivery: z.enum(['companion', 'embedded']),
    entryPath: OutputPathSchema.refine(
      (value) => !value.includes('[') && !value.includes(']'),
      'Expected a fixed entry path without Bun naming templates',
    ),
    assetPath: OutputPathSchema,
  })
  .refine(
    (input) =>
      input.entryPath !== input.assetPath &&
      !input.entryPath.startsWith(`${input.assetPath}/`) &&
      !input.assetPath.startsWith(`${input.entryPath}/`),
    'Entry and addon must have non-overlapping paths',
  );
const AssetSchema = z.object({
  sourcePath: z.string(),
  outputPath: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const RefusalSchema = z.object({
  state: z.enum(['unsupported', 'missing']),
  platform: z.string(),
  architecture: z.string(),
  code: z.enum(['NATIVE_TARGET_UNSUPPORTED', 'NATIVE_ASSET_MISSING']),
});

export type NativePackagingOptions = z.input<typeof OptionsSchema>;
export type NativePackagingAsset = z.infer<typeof AssetSchema>;

/** Structural Bun plugin protocol: declarations need no Bun runtime or ambient types. */
export type NativePackagingPlugin = {
  name: string;
  setup: (build: {
    config: {
      splitting?: boolean;
      naming?: string | { entry?: string };
      entrypoints: string[];
    };
    onLoad: (
      options: { filter: RegExp },
      callback: (args: { path: string }) => { contents: string; loader: 'js' } | undefined,
    ) => unknown;
    onResolve: (
      options: { filter: RegExp },
      callback: (args: {
        path: string;
        importer: string;
      }) => { path: string; external: boolean } | undefined,
    ) => unknown;
  }) => void;
};

export type NativePackagingResult =
  | z.infer<typeof RefusalSchema>
  | {
      state: 'ready';
      platform: 'darwin';
      architecture: 'arm64' | 'x64';
      packageVersion: string;
      assets: NativePackagingAsset[];
      plugin: NativePackagingPlugin;
    };

function installedPackageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(resolve(directory, 'native-assets.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Native packaging must run from its installed Stitchkit package');
}

/** Resolve this installed package's asset graph, without parsing downstream loader text. */
export function createNativePackaging(options: NativePackagingOptions): NativePackagingResult {
  const input = OptionsSchema.parse(options);
  if (
    input.platform !== 'darwin' ||
    (input.architecture !== 'arm64' && input.architecture !== 'x64')
  ) {
    return {
      state: 'unsupported',
      platform: input.platform,
      architecture: input.architecture,
      code: 'NATIVE_TARGET_UNSUPPORTED',
    };
  }
  const root = installedPackageRoot();
  const layout = NativeLayoutSchema.parse(
    JSON.parse(readFileSync(resolve(root, 'native-assets.json'), 'utf8')),
  );
  const manifest = z
    .object({ name: z.literal('stitchkit'), version: z.string().min(1) })
    .parse(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')));
  const loaderPath = resolve(root, layout.loader);
  const sourcePath = resolve(root, layout.assets[input.architecture]);
  let bytes: Buffer;
  try {
    bytes = readFileSync(sourcePath);
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      return {
        state: 'missing',
        platform: input.platform,
        architecture: input.architecture,
        code: 'NATIVE_ASSET_MISSING',
      };
    }
    throw cause;
  }
  const outputSpecifier = relative(dirname(input.entryPath), input.assetPath)
    .split('\\')
    .join('/');
  const specifier =
    input.delivery === 'embedded'
      ? sourcePath
      : outputSpecifier.startsWith('.')
        ? outputSpecifier
        : `./${outputSpecifier}`;
  const contents = nativeLoaderSource({ [input.architecture]: specifier });
  return {
    state: 'ready',
    platform: 'darwin',
    architecture: input.architecture,
    packageVersion: manifest.version,
    assets: [
      {
        sourcePath,
        outputPath: input.assetPath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
    plugin: {
      name: 'stitchkit-native-packaging',
      setup(build) {
        if (input.delivery === 'companion') {
          if (build.config.entrypoints.length !== 1)
            throw new Error('Native companion packaging requires exactly one entrypoint');
          if (build.config.splitting)
            throw new Error('Native companion packaging requires splitting: false');
          const naming = build.config.naming;
          const entry = typeof naming === 'string' ? naming : naming?.entry;
          if (entry !== input.entryPath)
            throw new Error('Native companion packaging naming.entry must match entryPath');
        }
        build.onLoad({ filter: /\.[cm]?js$/ }, (args) =>
          args.path === loaderPath ? { contents, loader: 'js' } : undefined,
        );
        if (input.delivery === 'companion') {
          build.onResolve({ filter: /./ }, (args) =>
            args.importer === loaderPath && args.path === specifier
              ? { path: specifier, external: true }
              : undefined,
          );
        }
      },
    },
  };
}
