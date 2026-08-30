import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineRuntimeTool } from '../tools/runtime-tool';
import type {
  AgentCodingToolConfig,
  AgentCodingToolDefinition,
  AgentCodingToolLimits,
} from './coding-tool-contract';
import {
  atomicCodingReplace,
  authorizeCodingTool,
  editableCodingPath,
  textOccurrences,
  withCodingPathLock,
} from './coding-tool-paths';
import { readContainedUtf8File, scanContainedFiles } from './contained-files';

const DEFAULT_EXCLUDED_DIRECTORIES = [
  '.git',
  '.next',
  '.stitchkit',
  'build',
  'coverage',
  'dist',
  'node_modules',
];

const SearchInputSchema = z
  .object({ query: z.string().min(1), mode: z.enum(['path', 'content']).default('content') })
  .strict();
const SearchOutputSchema = z
  .object({
    matches: z.array(
      z.object({ path: z.string().min(1), line: z.int().positive().optional() }).strict(),
    ),
    truncated: z.boolean(),
    scannedFiles: z.int().nonnegative(),
    skippedDirectories: z.int().nonnegative(),
    skippedSymlinks: z.int().nonnegative(),
  })
  .strict();
const PatchInputSchema = z
  .object({
    path: z.string().min(1),
    baseSha256: z.string().length(64),
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().default(false),
    dryRun: z.boolean().default(true),
  })
  .strict();
const PatchOutputSchema = z
  .object({
    path: z.string().min(1),
    baseSha256: z.string().length(64),
    resultSha256: z.string().length(64),
    replacements: z.int().positive(),
    bytes: z.int().nonnegative(),
    applied: z.boolean(),
  })
  .strict();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createSearchAndPatchCodingTools(
  config: AgentCodingToolConfig,
  limits: AgentCodingToolLimits,
): readonly AgentCodingToolDefinition[] {
  const search = defineRuntimeTool({
    name: 'search_files',
    description:
      'Search bounded relative paths or UTF-8 file content under the workspace root.',
    identity: { serviceName: 'coding', action: 'search', method: 'POST' },
    input: SearchInputSchema,
    output: SearchOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input }) => {
      await authorizeCodingTool(config, {
        operation: 'search',
        query: input.query,
        mode: input.mode,
      });
      const root = await realpath(config.root);
      const excluded = new Set(
        config.search?.excludeDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES,
      );
      const scan = await scanContainedFiles({
        root,
        maxDepth: limits.maxSearchDepth,
        maxFiles: limits.maxSearchFiles,
        symlinks: 'skip',
        excludeDirectory: (relative) =>
          relative.split(path.sep).some((segment) => excluded.has(segment)),
      });
      const matches: Array<{ path: string; line?: number }> = [];
      let truncated = false;
      for (const file of scan.files) {
        if (input.mode === 'path') {
          if (file.relative.includes(input.query)) matches.push({ path: file.relative });
        } else {
          let text: string;
          try {
            text = (await readContainedUtf8File(file.absolute, limits.maxReadBytes)).text;
          } catch {
            continue;
          }
          const lines = text.split('\n');
          for (let index = 0; index < lines.length; index += 1) {
            if (lines[index]?.includes(input.query)) {
              matches.push({ path: file.relative, line: index + 1 });
              if (matches.length >= limits.maxSearchResults) break;
            }
          }
        }
        if (matches.length >= limits.maxSearchResults) {
          truncated = true;
          break;
        }
      }
      return {
        matches,
        truncated: truncated || scan.truncated,
        scannedFiles: scan.files.length,
        skippedDirectories: scan.skippedDirectories,
        skippedSymlinks: scan.skippedSymlinks,
      };
    },
  });

  const patch = defineRuntimeTool({
    name: 'apply_patch',
    description: 'Dry-run or atomically apply one exact guarded UTF-8 file patch.',
    identity: { serviceName: 'coding', action: 'patch-file', method: 'POST' },
    input: PatchInputSchema,
    output: PatchOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input }) => {
      const root = await realpath(config.root);
      const target = await editableCodingPath(root, input.path, limits.maxPathBytes);
      const read = await readContainedUtf8File(target.absolute, limits.maxWriteBytes);
      const source = read.text;
      const baseSha256 = sha256(source);
      if (baseSha256 !== input.baseSha256)
        throw new Error('Coding patch base digest is stale');
      const count = textOccurrences(source, input.oldText);
      if (count === 0) throw new Error('Coding patch text was not found');
      if (!input.replaceAll && count !== 1) throw new Error('Coding patch text is not unique');
      const replacements = input.replaceAll ? count : 1;
      const changed = input.replaceAll
        ? source.replaceAll(input.oldText, input.newText)
        : source.replace(input.oldText, input.newText);
      const bytes = Buffer.byteLength(changed);
      const resultSha256 = sha256(changed);
      if (bytes > limits.maxWriteBytes) throw new Error('Coding patch exceeds maxWriteBytes');
      await authorizeCodingTool(config, {
        operation: 'patch',
        path: target.relative,
        baseSha256,
        resultSha256,
        resultBytes: bytes,
        replacements,
        dryRun: input.dryRun,
      });
      if (!input.dryRun) {
        await withCodingPathLock(target.absolute, async () => {
          const current = await readContainedUtf8File(target.absolute, limits.maxWriteBytes);
          if (sha256(current.text) !== baseSha256)
            throw new Error('Coding patch base digest became stale before apply');
          await atomicCodingReplace(target.absolute, changed, current.mode);
        });
      }
      return {
        path: target.relative,
        baseSha256,
        resultSha256,
        replacements,
        bytes,
        applied: !input.dryRun,
      };
    },
  });
  return [search, patch];
}
