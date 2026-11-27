/**
 * A client project to build packages from, and an empty consumer to install them into.
 *
 * The project is what an application repository looks like to `buildClientPackage`: a tsconfig,
 * two entries that share a schema module, an unrelated server file that does not typecheck, and
 * `zod` and `typescript` resolvable from it. The consumer is the test's own — a directory with
 * nothing but the archive and its peers — so a test asserts on what an installed package does,
 * not on what the build reported about itself.
 */
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runNativeCommand } from '../../src/process/command';
import { trackGroupLeader } from './process-reaper';

const MODULES = join(import.meta.dir, '../../node_modules');

/** The repository's own zod: the peer every fixture package declares. */
export const ZOD = realpathSync(join(MODULES, 'zod'));
/** The compiler a test runs its own consumer typecheck with. */
export const TSC = join(realpathSync(join(MODULES, 'typescript')), 'bin/tsc');

/** Write files under `root`, creating their directories. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/**
 * A client project. `imports` is how its modules name each other: without an extension, the way
 * bundler-resolved source does, or with `.ts`.
 */
export async function createClientProject(imports: 'extensionless' | 'ts'): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'sk-client-package-'));
  const ext = imports === 'ts' ? '.ts' : '';
  await writeFiles(project, {
    'tsconfig.json': `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Preserve',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: imports === 'ts',
      },
      include: ['src'],
    })}\n`,
    'src/schema.ts':
      "import { z } from 'zod';\n" +
      "export const SessionSchema = z.object({ id: z.string(), state: z.enum(['idle', 'busy']) });\n" +
      'export type Session = z.infer<typeof SessionSchema>;\n' +
      'export class ControlError extends Error {}\n',
    'src/client/index.ts':
      `export { ControlError, type Session, SessionSchema } from '../schema${ext}';\n` +
      'export const createControlClient = () => ({ ready: true });\n',
    'src/client/monitoring.ts':
      `import { type Session, SessionSchema } from '../schema${ext}';\n` +
      `export { ControlError, SessionSchema } from '../schema${ext}';\n` +
      'export const readSessions = (list: readonly unknown[]): Session[] =>\n' +
      '  list.map((item) => SessionSchema.parse(item));\n',
    // Not part of any client: a package build must not typecheck or emit it.
    'src/server.ts': "export const port: number = 'not a number';\n",
  });
  await mkdir(join(project, 'node_modules'));
  await symlink(ZOD, join(project, 'node_modules/zod'));
  await symlink(
    realpathSync(join(MODULES, 'typescript')),
    join(project, 'node_modules/typescript'),
  );
  return project;
}

/** The options every fixture package shares: two entries over one schema, zod as the peer. */
export function clientPackageOptions(project: string) {
  return {
    name: '@example/control-client',
    version: '1.4.0',
    entries: {
      '.': join(project, 'src/client/index.ts'),
      './monitoring': join(project, 'src/client/monitoring.ts'),
    },
    tsconfig: join(project, 'tsconfig.json'),
    peerDependencies: { zod: '^4.0.0' },
    outDir: join(project, 'dist'),
  };
}

/** Run one tool of a test to its end; the reaper owns it from before it exists. */
export async function runTool(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number | null; output: string }> {
  const result = await runNativeCommand({
    executable,
    args,
    cwd,
    envPolicy: 'ambient',
    capture: true,
    maxOutputBytes: 4 * 1024 * 1024,
    timeoutMs: 120_000,
    onLeaderStarted: trackGroupLeader,
  });
  const decoder = new TextDecoder();
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`.trim(),
  };
}

/**
 * Install an archive and its peers into a directory that has nothing else. `overrides` says where
 * a dependency of the archive comes from when no registry has it.
 */
export async function installConsumer(
  dependencies: Record<string, string>,
  overrides: Record<string, string> = {},
): Promise<string> {
  const consumer = await mkdtemp(join(tmpdir(), 'sk-client-consumer-'));
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      private: true,
      type: 'module',
      dependencies,
      overrides,
    }),
  );
  // Copied, not hard-linked from the installer's cache: a test that edits an installed file to
  // build a control must not edit the cached package every later install is made from.
  const installed = await runTool(
    'bun',
    ['install', '--ignore-scripts', '--backend=copyfile'],
    consumer,
  );
  if (installed.exitCode !== 0) {
    await rm(consumer, { recursive: true, force: true });
    throw new Error(`consumer install failed: ${installed.output}`);
  }
  return consumer;
}
