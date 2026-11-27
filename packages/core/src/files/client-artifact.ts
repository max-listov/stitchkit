/**
 * A client as one file a consumer can take without the package it came from.
 *
 * A package that owns a server usually ships a typed client for it, and the
 * consumers of that client must not inherit the server's dependency tree: a
 * terminal UI, a process supervisor, a provider SDK. So the client is bundled
 * into a single self-contained file, its hash is published beside it, and —
 * because "self-contained" is a claim a later import can silently break — the
 * build refuses a bundle whose module graph reaches a forbidden module.
 *
 * A client published to a registry with its types, entries and peers is the
 * other product: `buildClientPackage` in `client-package.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  type ForbiddenModule,
  readClientBuildGraph,
  refuseForbiddenModules,
  runClientTool,
} from './client-build';

/** What `buildClientArtifact` builds from, where it writes and what it must refuse. */
export interface ClientArtifactOptions {
  /** The client's entry module. */
  entry: string;
  /** Where the self-contained file is written; `<outFile>.sha256` is written beside it. */
  outFile: string;
  /** The runtime the file is built for. Default `node`, which Bun also runs. */
  runtime?: 'node' | 'bun' | 'browser';
  /**
   * Modules the client must not reach. A bare or scoped name (`'chalk'`,
   * `'@scope/name'`, `'node:child_process'`) is a package or platform module,
   * matched by the specifier that imports it and by its installed path; a
   * string with a slash is a fragment of the project's own source path
   * (`'src/terminal/'`); a `RegExp` is tested against each bundled module's
   * absolute path.
   */
  forbiddenModules?: readonly ForbiddenModule[];
  /** The tools the build runs. `bun` defaults to `bun` on `PATH`. */
  executables?: { bun?: string };
  /** Deadline of the build. Default 120 000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A built client: the file, its SHA-256 and the modules inside it. */
export interface ClientArtifact {
  /** Absolute path of the self-contained file. */
  file: string;
  /** Lowercase hex SHA-256 of the file. */
  sha256: string;
  bytes: number;
  /** Absolute path of the `<sha256>  <name>` file beside it. */
  sha256File: string;
  /** Absolute path of every module bundled into the file. */
  modules: string[];
}

/**
 * Build one self-contained client file with its SHA-256.
 *
 * Nothing is left at `outFile` when the build is refused: a file from an
 * earlier build is removed first, so a failed build cannot be mistaken for a
 * fresh artifact.
 */
export async function buildClientArtifact(
  options: ClientArtifactOptions,
): Promise<ClientArtifact> {
  const file = resolve(options.outFile);
  const sha256File = `${file}.sha256`;
  const work = await mkdtemp(join(tmpdir(), 'stitchkit-client-artifact-'));
  try {
    await rm(file, { force: true });
    await rm(sha256File, { force: true });
    const root = dirname(resolve(options.entry));
    const built = join(work, 'client.js');
    const metafilePath = join(work, 'meta.json');
    const build = await runClientTool(
      { timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal },
      options.executables?.bun ?? 'bun',
      [
        'build',
        resolve(options.entry),
        `--target=${options.runtime ?? 'node'}`,
        '--format=esm',
        `--outfile=${built}`,
        `--metafile=${metafilePath}`,
      ],
      root,
    );
    if (!build.ok) {
      throw new Error(`Client artifact build failed (exit ${build.exit}): ${build.output}`);
    }
    const graph = await readClientBuildGraph(metafilePath, root);
    refuseForbiddenModules(graph, options.forbiddenModules ?? []);

    const bytes = await readFile(built);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    await writeFile(sha256File, `${digest}  ${basename(file)}\n`);
    return {
      file,
      sha256: digest,
      bytes: bytes.byteLength,
      sha256File,
      modules: [...graph.modules.keys()].sort(),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
