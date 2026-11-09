import path from 'node:path';
import { z } from 'zod';
import { containedEntryMetadata, openContainedDirectory } from '../internal/contained-files';
import type { ContainedFileHandle } from '../internal/contained-handle';
import { defineRuntimeTool } from '../tools/runtime-tool';
import { discoveryCollector, discoveryRun } from './coding-discovery';
import { boundSearchDiagnostics } from './coding-search-output';
import type {
  AgentCodingToolConfig,
  AgentCodingToolDefinition,
  AgentCodingToolLimits,
} from './coding-tool-contract';
import { CodingDeniedEntrySchema } from './coding-tool-contract';
import {
  authorizeCodingPathChain,
  authorizeCodingTool,
  boundedCodingRelativePath,
  isCodingPathAuthorized,
} from './coding-tool-paths';
import { refuseUnopenableCodingDirectory } from './coding-tool-refusals';
import { scanContainedFiles } from './contained-scan';
import { DiscoveryCoverageSchema } from './contained-scan-contract';
import { compileWorkspaceGlob } from './workspace-glob';

/** The same set search_files skips. List shows these directories explicitly. */
export const DEFAULT_EXCLUDED_DIRECTORIES = [
  '.git',
  '.next',
  '.stitchkit',
  'build',
  'coverage',
  'dist',
  'node_modules',
];
const ListInputSchema = z.object({ path: z.string().min(1).default('.') }).strict();
const diagnostics = {
  denied: z.array(CodingDeniedEntrySchema).optional(),
  deniedTruncated: z.boolean().optional(),
  errors: z
    .array(z.object({ path: z.string(), operation: z.string(), code: z.string() }).strict())
    .optional(),
  errorsTruncated: z.boolean().optional(),
  coverage: DiscoveryCoverageSchema,
};
const ListOutputSchema = z
  .object({
    path: z.string().min(1),
    entries: z.array(
      z
        .object({
          name: z.string().min(1),
          kind: z.enum(['file', 'directory', 'symlink', 'other']),
          bytes: z.int().nonnegative().optional(),
          excluded: z.boolean().optional(),
        })
        .strict(),
    ),
    truncated: z.boolean(),
    ...diagnostics,
  })
  .strict();
const GlobInputSchema = z
  .object({ pattern: z.string().min(1).max(4096), path: z.string().min(1).default('.') })
  .strict();
const GlobOutputSchema = z
  .object({
    paths: z.array(z.string().min(1)),
    truncated: z.boolean(),
    resultTruncated: z.boolean(),
    skippedDirectories: z.int().nonnegative(),
    scannedFiles: z.int().nonnegative(),
    ...diagnostics,
  })
  .strict();

export function createListingCodingTools(
  config: AgentCodingToolConfig,
  limits: AgentCodingToolLimits,
): readonly AgentCodingToolDefinition[] {
  const excluded = new Set(config.search?.excludeDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);
  const relativePath = (requested: string) =>
    requested === '.'
      ? '.'
      : boundedCodingRelativePath(path.resolve(config.root), requested, limits.maxPathBytes);
  const dispose = (handle: ContainedFileHandle) => {
    void handle.close().catch(() => undefined);
  };
  const list = defineRuntimeTool({
    name: 'list_directory',
    description: 'List bounded direct workspace entries with explicit coverage.',
    identity: { serviceName: 'coding', action: 'list-directory', method: 'POST' },
    input: ListInputSchema,
    output: ListOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input, signal }) => {
      const relative = relativePath(input.path);
      const run = discoveryRun(config, limits, relative, '*', 'list');
      const { budget } = run;
      budget.limits.maxEntries = Math.min(limits.maxListEntries, limits.maxSearchEntries);
      const output: z.infer<typeof ListOutputSchema> = {
        path: relative,
        entries: [],
        truncated: false,
        coverage: run.coverage,
      };
      const retain = discoveryCollector(output, budget, limits.maxSearchOutputBytes);
      await run.run(signal, async (root) => {
        await budget.wait(() => authorizeCodingPathChain(config, relative, root, budget));
        await budget.wait(() =>
          authorizeCodingTool(config, { operation: 'list', path: relative }),
        );
        const directory = await budget
          .wait(
            () => openContainedDirectory(root, relative, () => budget.directory()),
            dispose,
          )
          .catch((error: unknown) => refuseUnopenableCodingDirectory(error, relative));
        try {
          const scan = await scanContainedFiles({
            root: directory,
            basePath: relative,
            budget,
            maxDepth: 0,
            maxFiles: limits.maxSearchFiles,
            symlinks: 'skip',
            skipUnreadable: true,
            maxDiagnostics: limits.maxListEntries,
            authorizePath: (candidate) => isCodingPathAuthorized(config, candidate),
            visitEntry: async (parent, entry) => {
              if (output.entries.length >= limits.maxListEntries) budget.stop('max-results');
              const metadata =
                entry.kind === 'file'
                  ? await budget.wait(() =>
                      containedEntryMetadata({ handle: parent, basename: entry.name }),
                    )
                  : null;
              const item = {
                ...entry,
                ...(metadata?.size !== undefined && { bytes: metadata.size }),
                ...(entry.kind === 'directory' &&
                  excluded.has(entry.name) && { excluded: true }),
              };
              retain(item);
              output.entries.push(item);
              return false;
            },
          });
          if (scan.denied.length) {
            output.denied = scan.denied.map(({ relative, kind }) => ({
              path: relative,
              kind,
            }));
            output.deniedTruncated = scan.deniedTruncated;
          }
          if (scan.errors.length) {
            output.errors = scan.errors;
            output.errorsTruncated = scan.errorsTruncated;
          }
        } finally {
          await directory.close();
        }
      });
      output.entries.sort((a, b) =>
        a.kind === b.kind
          ? a.name.localeCompare(b.name)
          : a.kind === 'directory'
            ? -1
            : b.kind === 'directory'
              ? 1
              : 0,
      );
      run.refresh();
      boundSearchDiagnostics(output, budget, limits.maxSearchOutputBytes);
      run.refresh();
      output.truncated = !output.coverage.complete;
      return output;
    },
  });
  const glob = defineRuntimeTool({
    name: 'glob',
    description: 'List bounded workspace files matching **/*/? with explicit coverage.',
    identity: { serviceName: 'coding', action: 'glob', method: 'POST' },
    input: GlobInputSchema,
    output: GlobOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input, signal }) => {
      const relative = relativePath(input.path);
      const run = discoveryRun(config, limits, relative, input.pattern, 'skip');
      const { budget } = run;
      const output: z.infer<typeof GlobOutputSchema> = {
        paths: [],
        truncated: false,
        resultTruncated: false,
        skippedDirectories: 0,
        scannedFiles: 0,
        coverage: run.coverage,
      };
      const retain = discoveryCollector(output, budget, limits.maxSearchOutputBytes);
      await run.run(signal, async (root) => {
        const matcher = compileWorkspaceGlob(input.pattern, () => budget.check());
        await budget.wait(() => authorizeCodingPathChain(config, relative, root, budget));
        await budget.wait(() =>
          authorizeCodingTool(config, {
            operation: 'glob',
            pattern: input.pattern,
            path: relative,
          }),
        );
        const directory = await budget
          .wait(
            () => openContainedDirectory(root, relative, () => budget.directory()),
            dispose,
          )
          .catch((error: unknown) => refuseUnopenableCodingDirectory(error, relative));
        const prefix = relative === '.' ? '' : `${relative}/`;
        try {
          const scan = await scanContainedFiles({
            root: directory,
            basePath: relative,
            budget,
            maxDepth: limits.maxSearchDepth,
            maxFiles: limits.maxSearchFiles,
            symlinks: 'skip',
            skipUnreadable: true,
            maxDiagnostics: limits.maxSearchResults,
            excludeDirectory: (directory) =>
              directory.split('/').some((segment) => excluded.has(segment)) ||
              !matcher.mayContain(directory.slice(prefix.length)),
            authorizePath: (candidate) => isCodingPathAuthorized(config, candidate),
            visitFile: (file) => {
              if (!matcher.test(file.relative.slice(prefix.length))) return true;
              if (output.paths.length >= limits.maxSearchResults) {
                output.resultTruncated = true;
                budget.stop('max-results');
              }
              retain(file.relative);
              output.paths.push(file.relative);
              if (output.paths.length >= limits.maxSearchResults) {
                output.resultTruncated = true;
                budget.stop('max-results');
              }
              return true;
            },
          });
          output.scannedFiles = scan.scannedFiles;
          output.skippedDirectories = scan.skippedDirectories;
          if (scan.denied.length) {
            output.denied = scan.denied.map(({ relative, kind }) => ({
              path: relative,
              kind,
            }));
            output.deniedTruncated = scan.deniedTruncated;
          }
          if (scan.errors.length) {
            output.errors = scan.errors;
            output.errorsTruncated = scan.errorsTruncated;
          }
        } finally {
          await directory.close();
        }
      });
      output.paths.sort();
      run.refresh();
      boundSearchDiagnostics(output, budget, limits.maxSearchOutputBytes);
      run.refresh();
      output.truncated = !output.coverage.complete;
      return output;
    },
  });
  return [list, glob];
}
