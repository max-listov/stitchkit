import { createHash } from 'node:crypto';
import { z } from 'zod';

/** A relative path inside a package or an output root: no drive, backslash, traversal or empty part. */
export const RelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[a-z]:/i.test(value) &&
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0),
    'Expected a relative path without traversal',
  );

/**
 * The repository's source layout (`native-layout.json`): where the generated loader and each
 * architecture's addon live inside the package. Build input only; it is never published.
 */
export const NativeLayoutSchema = z.strictObject({
  loader: RelativePathSchema,
  assets: z.strictObject({ arm64: RelativePathSchema, x64: RelativePathSchema }),
});

/** One published addon: its package path and the size and SHA256 of the bytes Stitchkit built. */
export const NativeAssetEntrySchema = z.strictObject({
  path: RelativePathSchema,
  size: z.int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/**
 * The published manifest (`native-assets.json`), written when the package is built. An
 * architecture is listed only when its addon was present then; an absent entry means the
 * package does not publish that addon. Any other `formatVersion` is refused.
 */
export const NativeAssetManifestSchema = z.strictObject({
  formatVersion: z.literal(2, {
    error: 'Native asset manifest formatVersion must be 2 for this Stitchkit',
  }),
  loader: RelativePathSchema,
  assets: z.strictObject({
    arm64: NativeAssetEntrySchema.optional(),
    x64: NativeAssetEntrySchema.optional(),
  }),
});

/** The published manifest as parsed. */
export type NativeAssetManifest = z.infer<typeof NativeAssetManifestSchema>;

/** Size and lowercase hex SHA256 of addon bytes: the one digest the manifest and the reader use. */
export function nativeAssetDigest(bytes: Uint8Array): { size: number; sha256: string } {
  return { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * How a generated loader names its addons.
 * `static`: a literal `require` the bundler follows and embeds or copies.
 * `beside-loader`: a path computed at runtime from the loader's own directory, which no bundler
 * follows. Only a packaging plugin turns the second form into the first.
 */
export type NativeLoaderResolution = 'static' | 'beside-loader';

const templateText = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');

/** One lazy loader for package, companion and embedded delivery. */
export function nativeLoaderSource(
  assets: Readonly<Record<string, string>>,
  resolution: NativeLoaderResolution,
): string {
  const quote = (value: string) =>
    `'${JSON.stringify(value).slice(1, -1).replaceAll("'", "\\'")}'`;
  const target = (asset: string) =>
    resolution === 'static'
      ? quote(asset)
      : `\`\${__dirname}/${templateText(asset.replace(/^\.\//, ''))}\``;
  const branches = Object.entries(assets).map(
    ([architecture, asset]) =>
      `    if (process.arch === ${quote(architecture)}) return require(${target(asset)});`,
  );
  return [
    '/** Generated from the owning native asset graph. Loading remains lazy. */',
    ...(resolution === 'static'
      ? []
      : [
          '// The addon path is computed, so a bundler never follows or embeds it. A packaging',
          '// plugin replaces this file with a static loader when an artifact must carry the addon.',
        ]),
    'module.exports = function loadDarwinAddon() {',
    '  try {',
    ...branches,
    "    throw new Error('Unsupported Darwin addon architecture');",
    '  } catch (cause) {',
    "    throw new Error('Darwin addon loading failed', { cause });",
    '  }',
    '};',
    '',
  ].join('\n');
}
