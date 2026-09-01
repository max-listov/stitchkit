import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { conflict } from '../contract';
import { defineRuntimeTool } from '../tools/runtime-tool';
import type {
  AgentCodingToolConfig,
  AgentCodingToolDefinition,
  AgentCodingToolLimits,
} from './coding-tool-contract';
import { compileWorkspaceGlob, DEFAULT_EXCLUDED_DIRECTORIES } from './coding-tool-listing';
import {
  authorizeCodingTool,
  boundedCodingRelativePath,
  textOccurrences,
  withCodingPathLock,
} from './coding-tool-paths';
import {
  codingPathRefusal,
  codingRefusal,
  refuseMissingCodingPath,
} from './coding-tool-refusals';
import {
  assertContainedParentCurrent,
  openContainedParent,
  openContainedParentFile,
  readContainedUtf8Handle,
  scanContainedFiles,
  writeContainedFile,
} from './contained-files';

const SearchInputSchema = z
  .object({
    query: z.string().min(1),
    mode: z.enum(['path', 'content']).default('content'),
    /** Treat `query` as a regular expression from the linear subset below. */
    regex: z.boolean().default(false),
    /** Lines of surrounding context to return with each content match. */
    context: z.int().nonnegative().max(10).default(0),
    /** Only search files whose relative path matches this `**`/`*`/`?` pattern. */
    include: z.string().min(1).optional(),
  })
  .strict();
const SearchOutputSchema = z
  .object({
    matches: z.array(
      z
        .object({
          path: z.string().min(1),
          line: z.int().positive().optional(),
          text: z.string().optional(),
          before: z.array(z.string()).optional(),
          after: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    truncated: z.boolean(),
    scannedFiles: z.int().nonnegative(),
    skippedDirectories: z.int().nonnegative(),
    skippedSymlinks: z.int().nonnegative(),
  })
  .strict();

/**
 * Refuse the regex constructs that make matching super-linear.
 *
 * JavaScript's `RegExp` cannot be interrupted: catastrophic backtracking on one
 * line hangs the thread, and no clock check between lines can stop it. A
 * timeout was the first plan and is not implementable here, so the bound is on
 * the pattern instead — backreferences and lookaround are what turn a match
 * super-linear, and a workspace search does not need either. Line length is
 * capped as the second half of the same bound.
 */
function compileSearchRegex(pattern: string): RegExp {
  if (/\\[1-9]/.test(pattern) || /\(\?<?[=!]/.test(pattern)) {
    codingRefusal('BAD_REQUEST', 'This pattern uses a construct search does not allow', {
      details: { pattern },
      hint: 'Backreferences and lookaround are refused because they cannot be bounded. Rewrite without them.',
    });
  }
  try {
    return new RegExp(pattern);
  } catch (error) {
    codingRefusal('BAD_REQUEST', 'This pattern is not a valid regular expression', {
      details: { pattern, reason: error instanceof Error ? error.message : 'unknown' },
      hint: 'Fix the expression, or pass regex: false to search for it literally.',
    });
  }
}

/** Beyond this a single line is not searched — the other half of the regex bound. */
const MAX_SEARCHED_LINE_BYTES = 8_192;
/**
 * One exact-snippet edit.
 *
 * `expectedSha256` is optional. It used to be required, and requiring it is
 * what made this tool unusable for half of a nine-model run: the model had to
 * carry a 64-hex digest from its last read into every edit, and a `dryRun`
 * default of `true` made an edit two calls whose protocol the schema never
 * showed. `oldText` is itself a freshness guard for the region being changed —
 * it cannot match text that is no longer there — and a caller that wants the
 * stronger whole-file guarantee still passes the digest `read_file` returns.
 */
const EditInputSchema = z
  .object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().default(false),
    expectedSha256: z.string().length(64).optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();
const EditOutputSchema = z
  .object({
    path: z.string().min(1),
    baseSha256: z.string().length(64),
    sha256: z.string().length(64),
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
        ...(input.mode === 'content' && {
          readMaxBytes: limits.maxReadBytes,
          skipUnreadable: true,
        }),
        excludeDirectory: (relative) =>
          relative.split(path.sep).some((segment) => excluded.has(segment)),
      });
      const matcher = input.regex ? compileSearchRegex(input.query) : null;
      const included = input.include ? compileWorkspaceGlob(input.include) : null;
      const hit = (line: string): boolean => {
        if (line.length > MAX_SEARCHED_LINE_BYTES) return false;
        if (matcher) {
          matcher.lastIndex = 0;
          return matcher.test(line);
        }
        return line.includes(input.query);
      };
      const matches: Array<{
        path: string;
        line?: number;
        text?: string;
        before?: string[];
        after?: string[];
      }> = [];
      let truncated = false;
      for (const file of scan.files) {
        if (included && !included.test(file.relative)) continue;
        if (input.mode === 'path') {
          if (hit(file.relative)) matches.push({ path: file.relative });
        } else {
          const text = file.content?.text;
          if (text === undefined) continue;
          const lines = text.split('\n');
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (line === undefined || !hit(line)) continue;
            matches.push({
              path: file.relative,
              line: index + 1,
              text: line,
              ...(input.context > 0 && {
                before: lines.slice(Math.max(0, index - input.context), index),
                after: lines.slice(index + 1, index + 1 + input.context),
              }),
            });
            if (matches.length >= limits.maxSearchResults) break;
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

  const edit = defineRuntimeTool({
    name: 'edit_file',
    description: 'Replace an exact snippet in one workspace file.',
    identity: { serviceName: 'coding', action: 'edit-file', method: 'POST' },
    input: EditInputSchema,
    output: EditOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input }) => {
      const root = await realpath(config.root);
      const relative = boundedCodingRelativePath(input.path, limits.maxPathBytes);
      const parent = await openContainedParent(root, relative).catch((error: unknown) =>
        refuseMissingCodingPath(error, relative),
      );
      try {
        // Everything from the read to the write happens under one lock, against
        // content read inside it. Dropping the mandatory digest removed the
        // check that used to make a stale computation visible, so the window it
        // guarded has to be closed rather than narrowed: two concurrent edits of
        // different snippets in one file would otherwise each build a whole new
        // file from the same v0 and the second write would erase the first.
        // The lock is process-local — the nine-agents-in-one-process case is
        // covered, two processes over one workspace are not.
        return await withCodingPathLock(`${root}:${relative}`, async () => {
          const handle = await openContainedParentFile(parent).catch((error: unknown) =>
            refuseMissingCodingPath(error, relative),
          );
          const read = await readContainedUtf8Handle(handle, limits.maxWriteBytes).finally(
            () => handle.close(),
          );
          const source = read.text;
          const baseSha256 = sha256(source);
          if (input.expectedSha256 !== undefined && baseSha256 !== input.expectedSha256) {
            conflict('The file changed since it was read', {
              message: 'The file changed since it was read',
              path: relative,
              expectedSha256: input.expectedSha256,
              actualSha256: baseSha256,
            });
          }
          const count = textOccurrences(source, input.oldText);
          if (count === 0) {
            codingPathRefusal('NOT_FOUND', 'oldText does not appear in this file', relative, {
              details: { occurrences: 0 },
              hint: 'Read the file and copy the snippet exactly, including indentation.',
            });
          }
          if (!input.replaceAll && count !== 1) {
            codingPathRefusal(
              'CONFLICT',
              `oldText appears ${count} times, so the edit is ambiguous`,
              relative,
              {
                details: { occurrences: count },
                hint: 'Lengthen the snippet until it is unique, or pass replaceAll: true.',
              },
            );
          }
          const replacements = input.replaceAll ? count : 1;
          const changed = input.replaceAll
            ? source.replaceAll(input.oldText, input.newText)
            : source.replace(input.oldText, input.newText);
          const bytes = Buffer.byteLength(changed);
          const resultSha256 = sha256(changed);
          if (bytes > limits.maxWriteBytes) {
            codingPathRefusal(
              'BAD_REQUEST',
              `The result would be ${bytes} bytes, over the ${limits.maxWriteBytes}-byte limit`,
              relative,
              {
                details: { bytes, maxWriteBytes: limits.maxWriteBytes },
                hint: 'Make a smaller edit, or split the file.',
              },
            );
          }
          await authorizeCodingTool(config, {
            operation: 'edit',
            path: relative,
            baseSha256,
            resultSha256,
            resultBytes: bytes,
            replacements,
            dryRun: input.dryRun,
          });
          await assertContainedParentCurrent(root, relative, parent.handle);
          if (!input.dryRun) {
            await writeContainedFile({
              parent,
              content: changed,
              replace: true,
              mode: read.mode,
            });
          }
          return {
            path: relative,
            baseSha256,
            sha256: resultSha256,
            replacements,
            bytes,
            applied: !input.dryRun,
          };
        });
      } finally {
        await parent.handle.close();
      }
    },
  });
  return [search, edit];
}
