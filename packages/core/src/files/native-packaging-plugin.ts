import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { nativeLoaderSource } from './native-packaging-layout';

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

/** The installed package a plugin belongs to: its root, its version and its loader file. */
export interface NativePackagingOwner {
  readonly root: string;
  readonly version: string;
  /** Absolute path of the default loader, as the published manifest names it. */
  readonly loaderPath: string;
  /** The manifest's relative loader path, the suffix every installation's loader shares. */
  readonly loaderName: string;
}

const realpath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * The installation a loader file belongs to, when `path` is the default loader of a `stitchkit`
 * package: recognised by its published name and the `package.json` beside it, never by its text.
 */
function loaderInstallation(
  path: string,
  loaderName: string,
): { root: string; version: string } | undefined {
  const suffix = `/${loaderName}`;
  if (!path.endsWith(suffix)) return undefined;
  const root = path.slice(0, -suffix.length);
  const manifest = join(root, 'package.json');
  if (!existsSync(manifest)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const name = Reflect.get(parsed, 'name');
    const version = Reflect.get(parsed, 'version');
    if (name !== 'stitchkit') return undefined;
    return { root, version: typeof version === 'string' ? version : 'unknown' };
  } catch {
    return undefined;
  }
}

/**
 * The one Bun plugin of both deliveries: it swaps its own installation's default loader for a
 * static one, hands Bun the verified bytes of each embedded addon, and keeps companion addons
 * external to a build whose single entry is named exactly `entryPath`. A default loader of any
 * other installation fails the build: the entry imports a `stitchkit` this plugin did not package,
 * and an artifact that carried that loader would refuse the addon at run time.
 */
export function nativePlugin(
  owner: NativePackagingOwner,
  specifiers: Readonly<Record<string, string>>,
  embedded: ReadonlyMap<string, Uint8Array>,
  companionEntry: string | undefined,
): NativePackagingPlugin {
  const contents = nativeLoaderSource(specifiers, 'static');
  const external = new Set(Object.values(specifiers));
  const ownLoader = realpath(owner.loaderPath);
  const loaderFile = basename(owner.loaderName);
  return {
    name: 'stitchkit-native-packaging',
    setup(build) {
      if (companionEntry !== undefined) {
        if (build.config.entrypoints.length !== 1)
          throw new Error('Native companion packaging requires exactly one entrypoint');
        if (build.config.splitting)
          throw new Error('Native companion packaging requires splitting: false');
        const naming = build.config.naming;
        const entry = typeof naming === 'string' ? naming : naming?.entry;
        if (entry !== companionEntry)
          throw new Error('Native companion packaging naming.entry must match entryPath');
      }
      build.onLoad({ filter: /\.[cm]?js$/ }, (args) => {
        if (args.path === owner.loaderPath) return { contents, loader: 'js' };
        if (basename(args.path) !== loaderFile) return undefined;
        if (realpath(args.path) === ownLoader) return { contents, loader: 'js' };
        const foreign = loaderInstallation(args.path, owner.loaderName);
        if (!foreign) return undefined;
        throw new Error(
          `Native packaging of stitchkit ${owner.version} (${owner.root}) met the Darwin loader of ` +
            `stitchkit ${foreign.version} (${foreign.root}): the entry imports another installation, ` +
            'whose loader this plugin cannot package. Call createNativePackaging from the stitchkit ' +
            'the entry imports.',
        );
      });
      // Embedded delivery hands Bun the verified bytes, never a second read of the file.
      if (embedded.size > 0)
        build.onLoad({ filter: /\.node$/ }, (args) => {
          const bytes = embedded.get(args.path);
          return bytes ? { contents: bytes, loader: 'napi' } : undefined;
        });
      if (companionEntry !== undefined)
        build.onResolve({ filter: /./ }, (args) =>
          (args.importer === owner.loaderPath || realpath(args.importer) === ownLoader) &&
          external.has(args.path)
            ? { path: args.path, external: true }
            : undefined,
        );
    },
  };
}
