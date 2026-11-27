/**
 * What `buildClientPackage` is asked for, what it returns and how it refuses.
 */
import { z } from 'zod';
import type { ForbiddenModule } from './client-build';

/**
 * Descriptive `package.json` fields of the client package. Any other field is
 * written as given, except the ones the build derives itself — see
 * `CLIENT_PACKAGE_OWNED_FIELDS`.
 */
export const ClientPackageManifestSchema = z.looseObject({
  description: z.string().optional(),
  license: z.string().optional(),
  repository: z
    .union([
      z.string(),
      z.object({ type: z.string(), url: z.string(), directory: z.string().optional() }),
    ])
    .optional(),
  homepage: z.string().optional(),
  keywords: z.array(z.string()).readonly().optional(),
  author: z
    .union([
      z.string(),
      z.object({ name: z.string(), email: z.string().optional(), url: z.string().optional() }),
    ])
    .optional(),
});

/** Descriptive `package.json` fields of the client package: description, license, repository and the like. */
export type ClientPackageManifest = z.input<typeof ClientPackageManifestSchema>;

/**
 * Manifest fields the build writes from its own options and results. One of
 * them in `manifest` would be a second, unproven statement of the same fact.
 */
export const CLIENT_PACKAGE_OWNED_FIELDS: readonly string[] = [
  'name',
  'version',
  'type',
  'main',
  'module',
  'types',
  'typings',
  'exports',
  'files',
  'dependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

/** What `buildClientPackage` builds, keeps external, refuses and proves. */
export interface ClientPackageOptions {
  /** The package name, bare or scoped. */
  name: string;
  version: string;
  /**
   * Package subpath → source module (`.ts` or `.tsx`). All of them are built
   * in one pass, so a module two entries import exists once in the package.
   */
  entries: Readonly<Record<'.' | `./${string}`, string>>;
  /**
   * The project tsconfig the declarations are emitted with. Its directory is
   * the root every entry lies under and the place peers are resolved from.
   */
  tsconfig: string;
  /** Packages the consumer provides: kept out of the output, written as `peerDependencies`. */
  peerDependencies?: Readonly<Record<string, string>>;
  /** Packages installed with the client: kept out of the output, written as `dependencies`. */
  dependencies?: Readonly<Record<string, string>>;
  /**
   * Modules the client must not reach, bundled or external. A bare or scoped
   * name or subpath (`'chalk'`, `'@scope/name'`, `'stitchkit/server'`) is
   * matched by the specifier that imports it and by its installed path; a
   * string with a slash that names no import is a fragment of the project's own
   * source path (`'src/terminal/'`); a `RegExp` is tested against each bundled
   * module's absolute path.
   */
  forbiddenModules?: readonly ForbiddenModule[];
  /**
   * The runtime the package is built for. `node` (default) is proven by
   * importing it in Node and in Bun, `bun` in Bun; `browser` is built for
   * browsers and imported in Bun.
   */
  runtime?: 'node' | 'bun' | 'browser';
  /** Directory the proven `<name>-<version>.tgz` is written to. */
  outDir: string;
  /** Further `package.json` fields; a field the build owns is refused. */
  manifest?: ClientPackageManifest;
  /** Extra files of the package: path inside the package → source file. */
  files?: Readonly<Record<string, string>>;
  /** What the installed archive must additionally satisfy. */
  proof?: {
    /**
     * Consumer source files typechecked against the installed package under
     * both module resolutions. Each imports the package by name and nothing
     * relative.
     */
    typecheck?: readonly string[];
    /** Per subpath: names the installed package must export. */
    exports?: Readonly<Record<string, readonly string[]>>;
    /** Names that more than one subpath exports as deliberately different values. */
    distinctExports?: readonly string[];
    /**
     * Type packages the consumer typecheck installs and loads, e.g.
     * `'@types/node'` for a client whose declarations name Node types.
     */
    types?: readonly string[];
  };
  /**
   * The tools the build runs. `bun` and `node` default to the ones on `PATH`,
   * `tsc` to the compiler of the `typescript` package resolved from the
   * tsconfig's directory, run by the runtime that runs the build.
   */
  executables?: { bun?: string; node?: string; tsc?: string };
  /** Deadline of each build, pack, install and proof step. Default 120 000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A proven client package: the archive, what is in it and what the proof ran. */
export interface ClientPackage {
  /** Absolute path of the archive. */
  tarball: string;
  /** Lowercase hex SHA-256 of the archive. */
  sha256: string;
  bytes: number;
  /** Every packed file — its path inside the package, SHA-256 and size — as installed from the archive. */
  files: readonly { path: string; sha256: string; bytes: number }[];
  /** Absolute path of every source module bundled into the package. */
  modules: readonly string[];
  /** Per subpath: the names the installed package exports at runtime. */
  exports: Readonly<Record<string, readonly string[]>>;
  /** Names more than one subpath exports, each proven to be one value across them. */
  sharedExports: readonly string[];
  proof: {
    /** The runtimes that imported every subpath of the installed package. */
    runtimes: readonly ('node' | 'bun')[];
    /** The module resolutions a strict consumer typechecked under. */
    resolutions: readonly ('bundler' | 'NodeNext')[];
    /** Version of the compiler that emitted the declarations and ran the typecheck. */
    typescript: string;
    /** Each peer and dependency the proof installed → its version. */
    externals: Readonly<Record<string, string>>;
  };
}

/** Every reason `buildClientPackage` refuses with. */
export const ClientPackageRefusalSchema = z.enum([
  /** The bundler failed. */
  'build',
  /** The compiler reported an error while emitting declarations. */
  'declarations',
  /** A declaration names a relative module that has no declaration in the package. */
  'declaration-unresolved',
  /** A declaration names a package that is neither a peer nor a dependency. */
  'declaration-dependency',
  /** Code of a peer or dependency ended up inside the package. */
  'bundled-peer',
  /** `manifest` carries a field the build writes itself. */
  'manifest-owned-field',
  /** Packing or installing the archive failed, or a peer is not installed for the build. */
  'install',
  /** The installed version of a peer or dependency is outside its declared range. */
  'peer-range',
  /** The installed package lacks a name `proof.exports` requires. */
  'missing-export',
  /** A name exported by several subpaths is a different value in each. */
  'shared-export-split',
  /** A strict consumer did not typecheck against the installed package. */
  'typecheck',
]);

/** The refusal of a client package; switch on `reason`, never on the message. */
export class ClientPackageError extends Error {
  constructor(
    /** Why the build refused: one of the reasons in the list above. */
    readonly reason: z.infer<typeof ClientPackageRefusalSchema>,
    message: string,
    /** What the refusal is about: the file, specifier, package or names, and a tool's output. */
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ClientPackageError';
  }
}
