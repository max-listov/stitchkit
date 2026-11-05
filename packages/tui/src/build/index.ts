/**
 * `stitchkit-tui/build` — compile a terminal application into one executable
 * for any platform Bun targets, from any machine.
 *
 * OpenTUI loads its native library from `@opentui/core-<os>-<arch>` through a
 * static `import()` per platform. A package manager installs only the package
 * of the machine it runs on, so `bun build --compile` for another platform
 * cannot resolve the target's package. The plugin here supplies it: the
 * version the installed `@opentui/core` pins, the tarball from the registry,
 * checked against the sha512 `bun.lock` recorded. Packages of other platforms
 * become a module that throws, so the executable carries one native library.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { BunPlugin } from 'bun';

const NATIVE_PACKAGE = /^@opentui\/core-(darwin|linux|win32)-(x64|arm64)(-musl)?$/;
const ABSENT_NAMESPACE = 'stitchkit-tui-absent-native';

export interface TerminalNativeTarget {
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'x64' | 'arm64';
  /** The `@opentui/core-…` package whose library this executable carries. */
  packageName: string;
}

/** Read a Bun compile target (`bun-linux-x64`, `bun-darwin-arm64-modern`, …). */
export function terminalNativeTarget(target: Bun.Build.CompileTarget): TerminalNativeTarget {
  const parts = target.split('-');
  const os = parts[1];
  const rawArch = parts[2];
  if (parts.includes('musl')) {
    // OpenTUI picks the musl library at run time from OPENTUI_LIBC, not from the
    // build: an executable cannot promise which one it would load.
    throw new Error(
      `stitchkit-tui/build: ${target} is not supported — OpenTUI selects musl at run time through OPENTUI_LIBC; build a glibc target`,
    );
  }
  const platform =
    os === 'darwin' ? 'darwin' : os === 'linux' ? 'linux' : os === 'windows' ? 'win32' : null;
  const arch =
    rawArch === 'x64' ? 'x64' : rawArch === 'arm64' || rawArch === 'aarch64' ? 'arm64' : null;
  if (!platform || !arch)
    throw new Error(`stitchkit-tui/build: unknown compile target ${target}`);
  return { platform, arch, packageName: `@opentui/core-${platform}-${arch}` };
}

/** The `[name@version, registry, meta, integrity]` entries of a text `bun.lock`. */
function lockIntegrity(lock: unknown, spec: string): string | null {
  const packages =
    typeof lock === 'object' && lock !== null ? Reflect.get(lock, 'packages') : null;
  if (typeof packages !== 'object' || packages === null) return null;
  for (const entry of Object.values(packages)) {
    if (!Array.isArray(entry) || entry[0] !== spec) continue;
    const integrity = entry.find(
      (value: unknown): value is string =>
        typeof value === 'string' && value.startsWith('sha512-'),
    );
    if (integrity) return integrity;
  }
  return null;
}

function findUp(start: string, name: string): string | null {
  let directory = resolve(start);
  while (true) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export interface TerminalNativePluginOptions {
  target: Bun.Build.CompileTarget;
  /** The lockfile that pins the native package's integrity; found upwards from the working directory. */
  lockfile?: string;
  /** Where verified tarballs are unpacked; reused across builds. */
  cacheDirectory?: string;
  registry?: string;
  fetch?: typeof fetch;
}

/** Bundle the target platform's OpenTUI native package, and no other platform's. */
export function terminalNativePlugin(options: TerminalNativePluginOptions): BunPlugin {
  const target = terminalNativeTarget(options.target);
  const cacheDirectory =
    options.cacheDirectory ?? join(homedir(), '.cache', 'stitchkit-tui', 'native');
  const registry = (options.registry ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  const download = options.fetch ?? fetch;
  const fetched = new Map<string, Promise<string>>();

  /** The version the importing `@opentui/core` pins for its platform packages. */
  async function pinnedVersion(importer: string): Promise<string> {
    const manifestPath = findUp(dirname(importer), 'package.json');
    const manifest: unknown = manifestPath
      ? JSON.parse(await readFile(manifestPath, 'utf8'))
      : null;
    const optional =
      typeof manifest === 'object' && manifest !== null
        ? Reflect.get(manifest, 'optionalDependencies')
        : null;
    const version =
      typeof optional === 'object' && optional !== null
        ? Reflect.get(optional, target.packageName)
        : null;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error(
        `stitchkit-tui/build: ${manifestPath ?? importer} does not pin ${target.packageName} to an exact version`,
      );
    }
    return version;
  }

  async function fetchPackage(version: string): Promise<string> {
    const spec = `${target.packageName}@${version}`;
    const lockfile = options.lockfile ?? findUp(process.cwd(), 'bun.lock');
    if (!lockfile) throw new Error(`stitchkit-tui/build: no bun.lock pins ${spec}`);
    const integrity = lockIntegrity(Bun.JSONC.parse(await readFile(lockfile, 'utf8')), spec);
    if (!integrity) {
      throw new Error(
        `stitchkit-tui/build: ${lockfile} records no integrity for ${spec}; run bun install`,
      );
    }
    const directory = join(
      cacheDirectory,
      `${target.packageName.replace('/', '+')}@${version}`,
    );
    const entry = join(directory, 'package', 'index.bun.js');
    if (existsSync(entry)) return entry;
    const basename = target.packageName.split('/')[1];
    const url = `${registry}/${target.packageName}/-/${basename}-${version}.tgz`;
    const response = await download(url);
    if (!response.ok)
      throw new Error(`stitchkit-tui/build: ${url} answered ${response.status}`);
    const tarball = new Uint8Array(await response.arrayBuffer());
    const actual = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    if (actual !== integrity) {
      throw new Error(
        `stitchkit-tui/build: ${url} does not match bun.lock (${integrity}, got ${actual})`,
      );
    }
    // Unpack beside the cache and move into place, so a half-written package is never reused.
    const staging = `${directory}.${process.pid}.partial`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'package.tgz'), tarball);
    const tar = Bun.spawn(['tar', '-xzf', 'package.tgz'], { cwd: staging, stderr: 'pipe' });
    if ((await tar.exited) !== 0) {
      throw new Error(
        `stitchkit-tui/build: cannot unpack ${url}: ${await new Response(tar.stderr).text()}`,
      );
    }
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
    if (!existsSync(entry))
      throw new Error(`stitchkit-tui/build: ${spec} has no index.bun.js`);
    return entry;
  }

  return {
    name: 'stitchkit-tui-native',
    setup(build) {
      build.onResolve({ filter: NATIVE_PACKAGE }, async (args) => {
        if (args.path !== target.packageName) {
          return { path: args.path, namespace: ABSENT_NAMESPACE };
        }
        try {
          // Installed for this machine already: Bun resolves it as usual.
          return { path: Bun.resolveSync(args.path, dirname(args.importer)) };
        } catch {
          const version = await pinnedVersion(args.importer);
          let pending = fetched.get(version);
          if (!pending) {
            pending = fetchPackage(version);
            fetched.set(version, pending);
          }
          return { path: await pending };
        }
      });
      build.onLoad({ filter: /.*/, namespace: ABSENT_NAMESPACE }, (args) => ({
        contents: `throw new Error(${JSON.stringify(
          `${args.path} is not in this executable: it was built for ${target.packageName}`,
        )});\n`,
        loader: 'js',
      }));
    },
  };
}

export interface CompileTerminalAppOptions {
  entry: string;
  outfile: string;
  /** The platform the executable runs on; the machine building it may be another. */
  target: Bun.Build.CompileTarget;
  /** Extra `define`s; `process.env.NODE_ENV` is `"production"`, so React runs its production build. */
  define?: Record<string, string>;
  plugins?: BunPlugin[];
  native?: Omit<TerminalNativePluginOptions, 'target'>;
  minify?: boolean;
}

/**
 * Compile one standalone executable of a terminal application. React's
 * production build is chosen at build time, where it belongs: setting
 * NODE_ENV at run time cannot change JSX that was already compiled.
 */
export async function compileTerminalApp(
  options: CompileTerminalAppOptions,
): Promise<{ outfile: string }> {
  const outfile = resolve(options.outfile);
  const result = await Bun.build({
    entrypoints: [options.entry],
    compile: { target: options.target, outfile },
    define: { 'process.env.NODE_ENV': '"production"', ...options.define },
    minify: options.minify ?? true,
    // The plugin's refusals (integrity, lockfile, musl) are the message; keep them.
    throw: false,
    plugins: [
      terminalNativePlugin({ target: options.target, ...options.native }),
      ...(options.plugins ?? []),
    ],
  });
  if (!result.success) {
    const causes = result.logs.map((log) => log.message).join('\n  ');
    throw new Error(`stitchkit-tui/build: ${options.entry} did not compile:\n  ${causes}`);
  }
  return { outfile };
}
