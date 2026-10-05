import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type NativeAssetEntrySchema,
  NativeAssetManifestSchema,
  nativeAssetDigest,
  nativeLoaderSource,
  RelativePathSchema,
} from './native-packaging-layout';

const PackageManifestSchema = z.object({
  name: z.literal('stitchkit'),
  version: z.string().min(1),
});
const ArchitectureSchema = z.enum(['arm64', 'x64']);
/** The platforms this package ships native addons for; any other name is refused by the schema. */
const PlatformSchema = z.enum(['darwin']);
const CommonOptions = {
  platform: PlatformSchema,
  entryPath: RelativePathSchema.refine(
    (value) => !value.includes('[') && !value.includes(']'),
    'Expected a fixed entry path without Bun naming templates',
  ),
};
const SingleOptionsSchema = z.object({
  ...CommonOptions,
  architecture: z.string().min(1),
  delivery: z.enum(['companion', 'embedded']),
  assetPath: RelativePathSchema,
});
const MultipleOptionsSchema = z.object({
  ...CommonOptions,
  architecture: z
    .array(z.string().min(1))
    .refine((targets): targets is [string, ...string[]] => targets.length > 0),
  delivery: z.literal('companion'),
  assetPath: z.record(z.string().min(1), RelativePathSchema),
});
const OptionsSchema = z.union([SingleOptionsSchema, MultipleOptionsSchema]).check((ctx) => {
  const input = ctx.value;
  const targets =
    typeof input.architecture === 'string' ? [input.architecture] : input.architecture;
  if (new Set(targets).size !== targets.length)
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message: 'Architecture targets must be unique',
    });
  const assetPaths =
    typeof input.assetPath === 'string' ? [input.assetPath] : Object.values(input.assetPath);
  const assetMap = input.assetPath;
  if (
    typeof assetMap !== 'string' &&
    (Object.keys(assetMap).length !== targets.length ||
      targets.some((target) => !Object.hasOwn(assetMap, target)))
  )
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message: 'Asset paths must name exactly the declared architectures',
    });
  const paths = [input.entryPath, ...assetPaths];
  for (let at = 0; at < paths.length; at++) {
    const left = paths[at];
    if (!left) continue;
    for (const right of paths.slice(at + 1)) {
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`))
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'Entry and addons must have non-overlapping paths',
        });
    }
  }
});
const AssetSchema = z.object({
  outputPath: z.string(),
  size: z.int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
});
const TargetAssetSchema = AssetSchema.extend({ architecture: ArchitectureSchema });
const DigestSchema = z.object({
  size: z.int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const RefusalSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('unsupported'),
    platform: PlatformSchema,
    architecture: z.string(),
    code: z.literal('NATIVE_TARGET_UNSUPPORTED'),
  }),
  z.object({
    state: z.literal('missing'),
    platform: PlatformSchema,
    architecture: ArchitectureSchema,
    code: z.literal('NATIVE_ASSET_MISSING'),
  }),
  z.object({
    state: z.literal('mismatch'),
    platform: PlatformSchema,
    architecture: ArchitectureSchema,
    code: z.literal('NATIVE_ASSET_DIGEST_MISMATCH'),
    /** What the package published for this addon. */
    expected: DigestSchema,
    /** What the installed file holds: its size and the SHA256 of the bytes read. */
    actual: DigestSchema,
  }),
]);

/**
 * Input to `createNativePackaging`: platform, entry path, delivery and addon path per
 * architecture; `Multiple` selects one target or a list of them.
 */
export type NativePackagingOptions<Multiple extends boolean = false> = Multiple extends true
  ? z.input<typeof MultipleOptionsSchema>
  : z.input<typeof SingleOptionsSchema>;
/**
 * One native addon to ship with the bundle: where it lands in the output, its `bytes` already
 * checked against the `size` and `sha256` the package published, and those published values.
 * Write `bytes` to `outputPath`; never read the addon from the installed package a second time.
 */
export type NativePackagingAsset<Multiple extends boolean = false> = Multiple extends true
  ? z.infer<typeof TargetAssetSchema>
  : z.infer<typeof AssetSchema>;

/**
 * Structural Bun plugin protocol: declarations need no Bun runtime or ambient types.
 */
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
      callback: (args: {
        path: string;
      }) =>
        | { contents: string; loader: 'js' }
        | { contents: Uint8Array; loader: 'napi' }
        | undefined,
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

/**
 * `ready` with the verified assets to write and the Bun plugin to add, or a refusal naming an
 * unsupported architecture, a missing asset or an asset whose bytes differ from the published
 * digest (`mismatch` carries the `expected` and `actual` size and SHA256); check `state` first.
 */
export type NativePackagingResult<Multiple extends boolean = false> =
  | z.infer<typeof RefusalSchema>
  | {
      state: 'ready';
      platform: z.infer<typeof PlatformSchema>;
      architecture: Multiple extends true
        ? z.infer<typeof ArchitectureSchema>[]
        : z.infer<typeof ArchitectureSchema>;
      packageVersion: string;
      assets: NativePackagingAsset<Multiple>[];
      plugin: NativePackagingPlugin;
    };

type Architecture = z.infer<typeof ArchitectureSchema>;
type Platform = z.infer<typeof PlatformSchema>;

/** Every declared target as a supported architecture, or the first refusal. */
function resolveTargets(
  platform: Platform,
  declared: [string, ...string[]],
):
  | { targets: [Architecture, ...Architecture[]] }
  | { refusal: z.infer<typeof RefusalSchema> } {
  const refusal = (architecture: string): { refusal: z.infer<typeof RefusalSchema> } => ({
    refusal: {
      state: 'unsupported',
      platform,
      architecture,
      code: 'NATIVE_TARGET_UNSUPPORTED',
    },
  });
  const [head, ...tail] = declared;
  const first = ArchitectureSchema.safeParse(head);
  if (!first.success) return refusal(head);
  const targets: [Architecture, ...Architecture[]] = [first.data];
  for (const architecture of tail) {
    const target = ArchitectureSchema.safeParse(architecture);
    if (!target.success) return refusal(architecture);
    targets.push(target.data);
  }
  return { targets };
}

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

type Refusal = z.infer<typeof RefusalSchema>;
type PublishedAsset = z.infer<typeof NativeAssetEntrySchema>;

/**
 * Read one published addon once, hash what was read and compare its size and SHA256 with the
 * manifest; a difference refuses with both pairs. The returned bytes are the ones that were
 * checked.
 */
function readVerifiedAsset(
  root: string,
  published: PublishedAsset | undefined,
  platform: Platform,
  architecture: Architecture,
):
  | { sourcePath: string; bytes: Uint8Array; size: number; sha256: string }
  | { refusal: Refusal } {
  const missing = {
    refusal: { state: 'missing', platform, architecture, code: 'NATIVE_ASSET_MISSING' },
  } satisfies { refusal: Refusal };
  if (!published) return missing;
  const sourcePath = resolve(root, published.path);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(sourcePath);
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return missing;
    throw cause;
  }
  const actual = nativeAssetDigest(bytes);
  if (actual.size !== published.size || actual.sha256 !== published.sha256)
    return {
      refusal: {
        state: 'mismatch',
        platform,
        architecture,
        code: 'NATIVE_ASSET_DIGEST_MISMATCH',
        expected: { size: published.size, sha256: published.sha256 },
        actual,
      },
    };
  return { sourcePath, bytes, size: published.size, sha256: published.sha256 };
}

/**
 * Resolve this installed package's asset graph, without parsing downstream loader text.
 * `platform` is `'darwin'`, the only platform with native addons; another name throws.
 * Each selected addon is read and hashed once per call and checked against the size and
 * SHA256 published in the package's `native-assets.json`; the first one that differs refuses
 * with `NATIVE_ASSET_DIGEST_MISMATCH` and its `expected` and `actual` size and SHA256. Call it
 * once per build and reuse the result: its `assets` carry the verified bytes to write and its
 * plugin embeds those same bytes.
 */
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
  const declared: [string, ...string[]] =
    typeof input.architecture === 'string' ? [input.architecture] : input.architecture;
  const resolved = resolveTargets(input.platform, declared);
  if ('refusal' in resolved) return resolved.refusal;
  const architectures = resolved.targets;
  const root = installedPackageRoot();
  const published = NativeAssetManifestSchema.parse(
    JSON.parse(readFileSync(resolve(root, 'native-assets.json'), 'utf8')),
  );
  const manifest = PackageManifestSchema.parse(
    JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')),
  );
  const loaderPath = resolve(root, published.loader);
  const assets: NativePackagingAsset<boolean>[] = [];
  const specifiers: Record<string, string> = {};
  const embedded = new Map<string, Uint8Array>();
  for (const architecture of architectures) {
    const outputPath =
      typeof input.assetPath === 'string' ? input.assetPath : input.assetPath[architecture];
    if (!outputPath) throw new Error('Declared architecture has no output path');
    const verified = readVerifiedAsset(
      root,
      published.assets[architecture],
      input.platform,
      architecture,
    );
    if ('refusal' in verified) return verified.refusal;
    const { sourcePath, bytes, size, sha256 } = verified;
    if (input.delivery === 'embedded') embedded.set(sourcePath, new Uint8Array(bytes));
    const outputSpecifier = relative(dirname(input.entryPath), outputPath)
      .split('\\')
      .join('/');
    specifiers[architecture] =
      input.delivery === 'embedded'
        ? sourcePath
        : outputSpecifier.startsWith('.')
          ? outputSpecifier
          : `./${outputSpecifier}`;
    const asset = { outputPath, size, sha256, bytes };
    assets.push(typeof input.architecture === 'string' ? asset : { ...asset, architecture });
  }
  const contents = nativeLoaderSource(specifiers, 'static');
  const external = new Set(Object.values(specifiers));
  return {
    state: 'ready',
    platform: 'darwin',
    architecture: typeof input.architecture === 'string' ? architectures[0] : architectures,
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
        // Embedded delivery hands Bun the verified bytes, never a second read of the file.
        if (embedded.size > 0)
          build.onLoad({ filter: /\.node$/ }, (args) => {
            const bytes = embedded.get(args.path);
            return bytes ? { contents: bytes, loader: 'napi' } : undefined;
          });
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
