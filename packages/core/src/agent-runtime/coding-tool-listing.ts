import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineRuntimeTool } from '../tools/runtime-tool';
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
import {
  codingPathRefusal,
  codingRefusal,
  refuseMissingCodingPath,
} from './coding-tool-refusals';
import { listContainedDirectory, scanContainedFiles } from './contained-files';

/** The same set `search_files` skips, so one workspace has one idea of noise. */
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
const ListOutputSchema = z
  .object({
    path: z.string().min(1),
    entries: z.array(
      z
        .object({
          name: z.string().min(1),
          kind: z.enum(['file', 'directory', 'symlink', 'other']),
          bytes: z.int().nonnegative().optional(),
          /** True for a directory the search tools skip; it is listed, never hidden. */
          excluded: z.boolean().optional(),
        })
        .strict(),
    ),
    truncated: z.boolean(),
    /**
     * Direct children the host's path policy refused. Present only when there
     * were any: their absence is what made a denied file look absent.
     */
    denied: z.array(CodingDeniedEntrySchema).optional(),
    deniedTruncated: z.boolean().optional(),
  })
  .strict();

const GlobInputSchema = z
  .object({ pattern: z.string().min(1), path: z.string().min(1).default('.') })
  .strict();
const GlobOutputSchema = z
  .object({
    paths: z.array(z.string().min(1)),
    truncated: z.boolean(),
    /** Result cut at the limit — distinct from a tree that was not fully walked. */
    resultTruncated: z.boolean(),
    /** Directories skipped as noise; a zero result with a positive count is not "no files". */
    skippedDirectories: z.int().nonnegative(),
    scannedFiles: z.int().nonnegative(),
    /** Entries the host's path policy refused while walking. Never content. */
    denied: z.array(CodingDeniedEntrySchema).optional(),
    deniedTruncated: z.boolean().optional(),
  })
  .strict();

/**
 * Compile one workspace glob into a regular expression.
 *
 * A deliberate subset — `**`, `*`, `?`, and nothing else — written here rather
 * than taken as a dependency: the whole surface has one runtime dependency, and
 * a matcher this size does not earn a second. Everything outside the subset is
 * escaped, so a pattern containing regex punctuation matches it literally
 * instead of meaning something the caller did not write.
 */
export function compileWorkspaceGlob(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` spans directories including none of them; a trailing `**` is
        // "everything below here".
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]+/)*';
          index += 2;
          continue;
        }
        source += '.*';
        index += 1;
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += character?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
  }
  return new RegExp(`^${source}$`);
}

export function createListingCodingTools(
  config: AgentCodingToolConfig,
  limits: AgentCodingToolLimits,
): readonly AgentCodingToolDefinition[] {
  const excluded = new Set(config.search?.excludeDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);

  const list = defineRuntimeTool({
    name: 'list_directory',
    description: 'List the direct entries of one workspace directory.',
    identity: { serviceName: 'coding', action: 'list-directory', method: 'POST' },
    input: ListInputSchema,
    output: ListOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input }) => {
      const root = await realpath(config.root);
      const relative =
        input.path === '.'
          ? '.'
          : boundedCodingRelativePath(root, input.path, limits.maxPathBytes);
      await authorizeCodingPathChain(config, relative);
      await authorizeCodingTool(config, { operation: 'list', path: relative });
      const listing = await listContainedDirectory(
        root,
        relative,
        limits.maxListEntries,
        (candidate) => isCodingPathAuthorized(config, candidate),
      ).catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('ancestor is not a directory')) {
          codingPathRefusal('BAD_REQUEST', 'This path is not a directory', relative, {
            hint: 'Pass a directory; use read_file for a file.',
          });
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          codingPathRefusal('NOT_FOUND', 'This directory does not exist', relative, {
            hint: 'List a parent directory to see what is there.',
          });
        }
        return refuseMissingCodingPath(error, relative);
      });
      return {
        path: relative,
        // An excluded directory is real and is shown as real. Hiding it would
        // be a lie about the disk; marking it says the search tools skip it.
        entries: listing.entries.map((entry) => ({
          ...entry,
          ...(entry.kind === 'directory' && excluded.has(entry.name) && { excluded: true }),
        })),
        truncated: listing.truncated,
        // A denied child is real too, and printing nothing would make it
        // indistinguishable from one that is not on the disk at all.
        ...(listing.denied.length > 0 && {
          denied: listing.denied.map((entry) => ({
            path: relative === '.' ? entry.name : path.join(relative, entry.name),
            kind: entry.kind,
          })),
          deniedTruncated: listing.deniedTruncated,
        }),
      };
    },
  });

  const glob = defineRuntimeTool({
    name: 'glob',
    description: 'List workspace files matching a `**`/`*`/`?` pattern.',
    identity: { serviceName: 'coding', action: 'glob', method: 'POST' },
    input: GlobInputSchema,
    output: GlobOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input }) => {
      const root = await realpath(config.root);
      const relative =
        input.path === '.'
          ? '.'
          : boundedCodingRelativePath(root, input.path, limits.maxPathBytes);
      await authorizeCodingPathChain(config, relative);
      await authorizeCodingTool(config, {
        operation: 'glob',
        pattern: input.pattern,
        path: relative,
      });
      let matcher: RegExp;
      try {
        matcher = compileWorkspaceGlob(input.pattern);
      } catch {
        codingRefusal('BAD_REQUEST', 'This glob pattern could not be compiled', {
          details: { pattern: input.pattern },
          hint: 'Use only `**`, `*` and `?`.',
        });
      }
      const scan = await scanContainedFiles({
        root,
        maxDepth: limits.maxSearchDepth,
        maxFiles: limits.maxSearchFiles,
        symlinks: 'skip',
        excludeDirectory: (directory) =>
          directory.split(path.sep).some((segment) => excluded.has(segment)),
        authorizePath: (candidate) => isCodingPathAuthorized(config, candidate),
      });
      const prefix = relative === '.' ? '' : `${relative}${path.sep}`;
      const matched = scan.files
        .filter((file) => file.relative.startsWith(prefix))
        .map((file) => file.relative)
        .filter((candidate) => matcher.test(candidate.slice(prefix.length)))
        .sort();
      const paths = matched.slice(0, limits.maxSearchResults);
      // A denied entry is only ours to report when it sits under the same
      // `path` the caller asked about. The walk covers the whole tree, so
      // without this a glob scoped to `src` named refusals at the root and in
      // unrelated subtrees the caller never asked to see.
      const scopedDenied = scan.denied.filter((entry) => entry.relative.startsWith(prefix));
      const denied = scopedDenied.slice(0, limits.maxSearchResults).map((entry) => ({
        path: entry.relative,
        kind: entry.kind,
      }));
      return {
        paths,
        // Two different facts, reported separately: the tree was not fully
        // walked, and the result was cut. A model told only "truncated" cannot
        // tell "look deeper" from "ask for less".
        truncated: scan.truncated,
        resultTruncated: matched.length > paths.length,
        skippedDirectories: scan.skippedDirectories,
        scannedFiles: scan.files.length,
        // A denied path is not a missing one: name it rather than let it vanish.
        ...(denied.length > 0 && {
          denied,
          deniedTruncated: scan.deniedTruncated || scopedDenied.length > denied.length,
        }),
      };
    },
  });

  return [list, glob];
}
