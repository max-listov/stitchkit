import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { createApplicationIdentity } from './identity';

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

const RootManifestSchema = z.looseObject({ name: z.string().min(1) });

const IGNORED_DIRECTORIES = new Set([
  '.next',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

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
  return (
    name !== '.env' &&
    name !== 'next-env.d.ts' &&
    !name.endsWith('.log') &&
    !name.endsWith('.tsbuildinfo')
  );
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

export async function materialiseTemplateFiles(
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
  options: { overlayDirectory?: string; displayName?: string } = {},
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
    await writeFile(
      join(resolvedDestination, 'app.config.json'),
      `${JSON.stringify(identity, undefined, 2)}\n`,
    );
    const manifestPath = join(resolvedDestination, 'package.json');
    const manifest = RootManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8')),
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, name: identity.slug }, undefined, 2)}\n`,
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
