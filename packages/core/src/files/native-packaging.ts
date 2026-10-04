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
const ArchitectureSchema = z.enum(['arm64', 'x64']);
const CommonOptions = {
  platform: z.string().min(1),
  entryPath: OutputPathSchema.refine(
    (value) => !value.includes('[') && !value.includes(']'),
    'Expected a fixed entry path without Bun naming templates',
  ),
};
const SingleOptionsSchema = z.object({
  ...CommonOptions,
  architecture: z.string().min(1),
  delivery: z.enum(['companion', 'embedded']),
  assetPath: OutputPathSchema,
});
const MultipleOptionsSchema = z.object({
  ...CommonOptions,
  architecture: z.array(z.string().min(1)).min(1),
  delivery: z.literal('companion'),
  assetPath: z.record(z.string().min(1), OutputPathSchema),
});
const OptionsSchema = z
  .union([SingleOptionsSchema, MultipleOptionsSchema])
  .superRefine((input, ctx) => {
    const targets =
      typeof input.architecture === 'string' ? [input.architecture] : input.architecture;
    if (new Set(targets).size !== targets.length)
      ctx.addIssue({ code: 'custom', message: 'Architecture targets must be unique' });
    const assetPaths =
      typeof input.assetPath === 'string' ? [input.assetPath] : Object.values(input.assetPath);
    const assetMap = input.assetPath;
    if (
      typeof assetMap !== 'string' &&
      (Object.keys(assetMap).length !== targets.length ||
        targets.some((target) => !Object.hasOwn(assetMap, target)))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Asset paths must name exactly the declared architectures',
      });
    const paths = [input.entryPath, ...assetPaths];
    for (let at = 0; at < paths.length; at++) {
      const left = paths[at];
      if (!left) continue;
      for (const right of paths.slice(at + 1)) {
        if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`))
          ctx.addIssue({
            code: 'custom',
            message: 'Entry and addons must have non-overlapping paths',
          });
      }
    }
  });
const AssetSchema = z.object({
  sourcePath: z.string(),
  outputPath: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const TargetAssetSchema = AssetSchema.extend({ architecture: ArchitectureSchema });
const RefusalSchema = z.object({
  state: z.enum(['unsupported', 'missing']),
  platform: z.string(),
  architecture: z.string(),
  code: z.enum(['NATIVE_TARGET_UNSUPPORTED', 'NATIVE_ASSET_MISSING']),
});

export type NativePackagingOptions<Multiple extends boolean = false> = Multiple extends true
  ? z.input<typeof MultipleOptionsSchema>
  : z.input<typeof SingleOptionsSchema>;
export type NativePackagingAsset<Multiple extends boolean = false> = Multiple extends true
  ? z.infer<typeof TargetAssetSchema>
  : z.infer<typeof AssetSchema>;

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

export type NativePackagingResult<Multiple extends boolean = false> =
  | z.infer<typeof RefusalSchema>
  | {
      state: 'ready';
      platform: 'darwin';
      architecture: Multiple extends true
        ? z.infer<typeof ArchitectureSchema>[]
        : z.infer<typeof ArchitectureSchema>;
      packageVersion: string;
      assets: NativePackagingAsset<Multiple>[];
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
export function createNativePackaging(options: NativePackagingOptions): NativePackagingResult;
export function createNativePackaging(
  options: NativePackagingOptions<true>,
): NativePackagingResult<true>;
export function createNativePackaging(
  options: NativePackagingOptions<boolean>,
): NativePackagingResult<boolean>;
export function createNativePackaging(
  options: NativePackagingOptions<boolean>,
): NativePackagingResult<boolean> {
  const input = OptionsSchema.parse(options);
  const declared =
    typeof input.architecture === 'string' ? [input.architecture] : input.architecture;
  const architectures: z.infer<typeof ArchitectureSchema>[] = [];
  for (const architecture of declared) {
    const target = ArchitectureSchema.safeParse(architecture);
    if (input.platform !== 'darwin' || !target.success)
      return {
        state: 'unsupported',
        platform: input.platform,
        architecture,
        code: 'NATIVE_TARGET_UNSUPPORTED',
      };
    architectures.push(target.data);
  }
  const root = installedPackageRoot();
  const layout = NativeLayoutSchema.parse(
    JSON.parse(readFileSync(resolve(root, 'native-assets.json'), 'utf8')),
  );
  const manifest = z
    .object({ name: z.literal('stitchkit'), version: z.string().min(1) })
    .parse(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')));
  const loaderPath = resolve(root, layout.loader);
  const assets: NativePackagingAsset<boolean>[] = [];
  const specifiers: Record<string, string> = {};
  for (const architecture of architectures) {
    const sourcePath = resolve(root, layout.assets[architecture]);
    const outputPath =
      typeof input.assetPath === 'string' ? input.assetPath : input.assetPath[architecture];
    if (!outputPath) throw new Error('Declared architecture has no output path');
    let bytes: Buffer;
    try {
      bytes = readFileSync(sourcePath);
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
        return {
          state: 'missing',
          platform: input.platform,
          architecture,
          code: 'NATIVE_ASSET_MISSING',
        };
      throw cause;
    }
    const outputSpecifier = relative(dirname(input.entryPath), outputPath)
      .split('\\')
      .join('/');
    specifiers[architecture] =
      input.delivery === 'embedded'
        ? sourcePath
        : outputSpecifier.startsWith('.')
          ? outputSpecifier
          : `./${outputSpecifier}`;
    const asset = {
      sourcePath,
      outputPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    assets.push(typeof input.architecture === 'string' ? asset : { ...asset, architecture });
  }
  const first = architectures[0];
  if (!first) throw new Error('Native packaging has no declared targets');
  const contents = nativeLoaderSource(specifiers);
  const external = new Set(Object.values(specifiers));
  return {
    state: 'ready',
    platform: 'darwin',
    architecture: typeof input.architecture === 'string' ? first : architectures,
    packageVersion: manifest.version,
    assets,
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
            args.importer === loaderPath && external.has(args.path)
              ? { path: args.path, external: true }
              : undefined,
          );
        }
      },
    },
  };
}
