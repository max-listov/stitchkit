import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  APP_IDENTITY_PATH,
  createApplicationIdentity,
  renderAppIdentityModule,
  withIdentity,
} from './identity';

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.example',
  '.html',
  '.js',
  '.json',
  '.lock',
  '.md',
  '.mjs',
  '.prisma',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const TEMPLATE_RENAMES = new Map([
  // `.env` itself is never shipped — `scripts/local-env.ts` renders it from
  // `.env.example` with the application identity on first run, so a clone and
  // a rename both produce the same database name.
  ['_env.example', '.env.example'],
  ['_env.example.append', '.env.example'],
  ['_gitignore', '.gitignore'],
]);

const RootManifestSchema = z.looseObject({
  name: z.string().min(1),
  catalog: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * What never travels — as data, because two consumers read it.
 *
 * Copying is one of them; **packing** is the other, and it does not run this
 * function at all: `bun pm pack` reads the `files` field of
 * `create-stitchkit/package.json`. A name excluded here and forgotten there is
 * still published, which is exactly how `.build-stamp.json` — a build output
 * that is only true where its build ran — reached the packed template after
 * being excluded from the copy. `tests/scaffold.test.ts` holds the two lists
 * together, so an addition here fails until the manifest carries it too.
 */
export const IGNORED_DIRECTORIES = new Set([
  '.next',
  '.stitchkit',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

/** Whole file names that are output, not source. */
export const IGNORED_FILE_NAMES = new Set(['.env', '.build-stamp.json', 'next-env.d.ts']);

/** Suffixes with the same meaning. */
export const IGNORED_FILE_SUFFIXES = ['.log', '.tsbuildinfo'];

export function isTemplateSourcePathIncluded(sourcePath: string): boolean {
  const normalized = sourcePath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized) return true;

  const segments = normalized.split('/');
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return false;
  if (
    normalized === 'packages/db/src/generated' ||
    normalized.startsWith('packages/db/src/generated/')
  )
    return false;

  const name = basename(normalized);
  if (IGNORED_FILE_NAMES.has(name)) return false;
  return !IGNORED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function shouldIncludeTemplatePath(templateDirectory: string, sourcePath: string): boolean {
  return isTemplateSourcePathIncluded(relative(templateDirectory, sourcePath));
}

function portablePath(path: string): string {
  return path.split(sep).join('/');
}

export interface MaterialisedTemplateFile {
  sourcePath: string;
  outputPath: string;
  content: string | Uint8Array;
  append: boolean;
}

function isUnsafeDestination(destination: string): boolean {
  const root = parse(destination).root;
  const home = resolve(homedir());
  return destination === root || destination === home;
}

async function assertDestinationAvailable(destination: string): Promise<boolean> {
  if (isUnsafeDestination(destination)) {
    throw new Error('Refusing to scaffold into a filesystem root or home directory');
  }

  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink()) {
      throw new Error(`Destination cannot be a symbolic link: ${destination}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Destination exists and is not a directory: ${destination}`);
    }
    const entries = await readdir(destination);
    if (entries.length > 0) {
      throw new Error(`Destination is not empty: ${destination}`);
    }
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function collectMaterialisedFiles(
  templateDirectory: string,
  directory: string,
  files: MaterialisedTemplateFile[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = join(directory, entry.name);
    if (!shouldIncludeTemplatePath(templateDirectory, sourcePath)) continue;

    if (entry.isDirectory()) {
      await collectMaterialisedFiles(templateDirectory, sourcePath, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Template entries must be files or directories: ${sourcePath}`);
    }

    const targetName = TEMPLATE_RENAMES.get(entry.name);
    const sourceRelativePath = relative(templateDirectory, sourcePath);
    const outputRelativePath = targetName
      ? join(dirname(sourceRelativePath), targetName)
      : sourceRelativePath;
    const materialisedName = outputRelativePath.endsWith('.append')
      ? outputRelativePath.slice(0, -'.append'.length)
      : outputRelativePath;
    const fileExtension = extname(materialisedName);
    const content =
      TEXT_EXTENSIONS.has(fileExtension) || targetName
        ? await readFile(sourcePath, 'utf8')
        : await readFile(sourcePath);

    files.push({
      sourcePath: portablePath(sourceRelativePath),
      outputPath: portablePath(outputRelativePath),
      content,
      append: entry.name.endsWith('.append'),
    });
  }
}

async function materialiseTemplateFiles(
  templateDirectory: string,
): Promise<MaterialisedTemplateFile[]> {
  const files: MaterialisedTemplateFile[] = [];
  await collectMaterialisedFiles(templateDirectory, templateDirectory, files);
  return files;
}

async function writeMaterialisedFiles(
  destination: string,
  files: MaterialisedTemplateFile[],
): Promise<void> {
  for (const file of files) {
    const targetPath = join(destination, file.outputPath);
    await mkdir(dirname(targetPath), { recursive: true });
    if (file.append) {
      if (typeof file.content !== 'string') {
        throw new Error(`Append template entries must contain text: ${file.sourcePath}`);
      }
      const existing = await readFile(targetPath, 'utf8');
      await writeFile(targetPath, `${existing.trimEnd()}\n${file.content.trimStart()}`);
    } else {
      await writeFile(targetPath, file.content);
    }
  }
}

export async function scaffoldProject(
  templateDirectory: string,
  destination: string,
  options: {
    overlayDirectory?: string;
    displayName?: string;
    identityModule?: boolean;
    lockfile?: boolean;
    stitchkitCatalogTarget?: string;
  } = {},
): Promise<void> {
  const resolvedDestination = resolve(destination);
  const identity = createApplicationIdentity(resolvedDestination, options.displayName);
  const destinationExisted = await assertDestinationAvailable(resolvedDestination);
  await mkdir(resolvedDestination, { recursive: true });

  try {
    await writeMaterialisedFiles(
      resolvedDestination,
      await materialiseTemplateFiles(templateDirectory),
    );
    if (options.overlayDirectory) {
      await writeMaterialisedFiles(
        resolvedDestination,
        await materialiseTemplateFiles(options.overlayDirectory),
      );
    }
    if (options.lockfile === false) {
      await rm(join(resolvedDestination, 'bun.lock'), { force: true });
    }
    // The declaration travels with the template; only its identity is this
    // project's. Rewriting the whole file here would make the scaffolder a
    // second author of roles, build and release steps.
    const declarationPath = join(resolvedDestination, 'project.json');
    const declaration = withIdentity(
      JSON.parse(await readFile(declarationPath, 'utf8')),
      identity,
    );
    await writeFile(declarationPath, `${JSON.stringify(declaration, undefined, 2)}\n`);
    // Derived from the declaration, so it is stamped in the same pass.
    if (options.identityModule !== false) {
      const identityPath = join(resolvedDestination, APP_IDENTITY_PATH);
      await mkdir(dirname(identityPath), { recursive: true });
      await writeFile(identityPath, renderAppIdentityModule(declaration.identity));
    }
    const manifestPath = join(resolvedDestination, 'package.json');
    const manifest = RootManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8')),
    );
    const catalog = options.stitchkitCatalogTarget
      ? { ...(manifest.catalog ?? {}), stitchkit: options.stitchkitCatalogTarget }
      : manifest.catalog;
    const replaceLocalPackages = (dependencies: Record<string, string> | undefined) => {
      if (!dependencies) return dependencies;
      return {
        ...dependencies,
        ...(dependencies.stitchkit?.startsWith('file:') && { stitchkit: 'catalog:' }),
        ...(dependencies['stitchkit-tui']?.startsWith('file:') && {
          'stitchkit-tui': 'catalog:',
        }),
      };
    };
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          name: identity.slug,
          ...(catalog && { catalog }),
          ...(manifest.dependencies && {
            dependencies: replaceLocalPackages(manifest.dependencies),
          }),
          ...(manifest.devDependencies && {
            devDependencies: replaceLocalPackages(manifest.devDependencies),
          }),
        },
        undefined,
        2,
      )}\n`,
    );
  } catch (error) {
    if (!destinationExisted) {
      await rm(resolvedDestination, { recursive: true, force: true });
    } else {
      const entries = await readdir(resolvedDestination);
      await Promise.all(
        entries.map((entry) =>
          rm(join(resolvedDestination, entry), { recursive: true, force: true }),
        ),
      );
    }
    throw error;
  }
}
