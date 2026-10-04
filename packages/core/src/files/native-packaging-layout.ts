import { z } from 'zod';

const PackagePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[a-z]:/i.test(value) &&
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0),
    'Expected a relative package path without traversal',
  );

export const NativeLayoutSchema = z.object({
  formatVersion: z.literal(1),
  loader: PackagePathSchema,
  assets: z.object({ arm64: PackagePathSchema, x64: PackagePathSchema }),
});

/** One lazy loader for package, companion and embedded delivery. */
export function nativeLoaderSource(assets: Readonly<Record<string, string>>): string {
  const quote = (value: string) =>
    `'${JSON.stringify(value).slice(1, -1).replaceAll("'", "\\'")}'`;
  const branches = Object.entries(assets).map(
    ([architecture, asset]) =>
      `    if (process.arch === ${quote(architecture)}) return require(${quote(asset)});`,
  );
  return [
    '/** Generated from the owning native asset graph. Loading remains lazy. */',
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
