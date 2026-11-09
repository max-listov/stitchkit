import path from 'node:path';
import { openPinnedDirectory } from '../internal/contained-directory';
import type { ContainedFile } from '../internal/contained-files';
import { withSignalDeadline } from '../internal/deadline';
import { defineRuntimeTool } from '../tools/runtime-tool';
import {
  type SearchInput,
  SearchInputSchema,
  type SearchMatch,
  type SearchOutput,
  SearchOutputSchema,
} from './coding-search-contract';
import { compileSearchRegex } from './coding-search-matcher';
import { boundSearchDiagnostics } from './coding-search-output';
import type { AgentCodingToolConfig, AgentCodingToolLimits } from './coding-tool-contract';
import { DEFAULT_EXCLUDED_DIRECTORIES } from './coding-tool-listing';
import {
  authorizeCodingPath,
  authorizeCodingTool,
  isCodingPathAuthorized,
} from './coding-tool-paths';
import { codingRefusal } from './coding-tool-refusals';
import { scanContainedFiles } from './contained-scan';
import { ContainedScanBudget, ScanStopped } from './contained-scan-budget';
import { compileWorkspaceGlob } from './workspace-glob';

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** CPU time spent matching before the event loop gets a turn. */
const YIELD_EVERY_MS = 16;

function collectMatches(
  input: SearchInput,
  limits: AgentCodingToolLimits,
  budget: ContainedScanBudget,
  output: SearchOutput,
  availableBytes: number,
) {
  const matcher = input.regex ? compileSearchRegex(input.query, () => budget.check()) : null;
  let usedBytes = 0;
  const hit = (text: string): boolean => {
    budget.check();
    if (Buffer.byteLength(text) > 8_192) {
      budget.reasons.add('max-line-bytes');
      return false;
    }
    return matcher ? matcher.test(text) : text.includes(input.query);
  };
  const append = (match: SearchMatch): void => {
    const bytes = jsonBytes(match) + 1;
    if (usedBytes + bytes > availableBytes) budget.stop('max-output-bytes');
    output.matches.push(match);
    usedBytes += bytes;
    // No extra result is read merely to prove there was one beyond the cap.
    if (output.matches.length >= limits.maxSearchResults) budget.stop('max-results');
  };
  // Matching one file is CPU work no event can interrupt; yielding between lines lets a
  // caller's abort arrive, so cancellation waits at most one line, not the whole deadline.
  let since = performance.now();
  const yieldBetweenLines = async () => {
    if (performance.now() - since < YIELD_EVERY_MS) return;
    await new Promise((resolve) => setImmediate(resolve));
    since = performance.now();
    budget.check();
  };
  return async (file: ContainedFile): Promise<boolean> => {
    if (input.mode === 'path') {
      if (hit(file.relative)) append({ path: file.relative });
      return true;
    }
    if (file.content === undefined) return true;
    const lines = file.content.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      await yieldBetweenLines();
      const line = lines[index];
      if (line === undefined || !hit(line)) continue;
      append({
        path: file.relative,
        line: index + 1,
        text: line,
        ...(input.context > 0 && {
          before: lines.slice(Math.max(0, index - input.context), index),
          after: lines.slice(index + 1, index + 1 + input.context),
        }),
      });
    }
    return true;
  };
}

async function searchFiles(
  config: AgentCodingToolConfig,
  limits: AgentCodingToolLimits,
  input: SearchInput,
  caller?: AbortSignal,
): Promise<SearchOutput> {
  const started = performance.now();
  const budget = new ContainedScanBudget({
    maxDirectories: limits.maxSearchDirectories,
    maxEntries: limits.maxSearchEntries,
    maxBytes: limits.maxSearchBytes,
    deadline: started + limits.searchTimeoutMs,
  });
  const output: SearchOutput = {
    matches: [],
    truncated: false,
    scannedFiles: 0,
    skippedDirectories: 0,
    skippedSymlinks: 0,
    coverage: {
      complete: true,
      reasons: [],
      scope: {
        path: '.',
        include: input.include ?? '**',
        excludedDirectories: config.search?.excludeDirectories ? 'configured' : 'default',
        symlinks: 'skip',
      },
      visitedDirectories: 0,
      visitedEntries: 0,
      readBytes: 0,
      elapsedMs: 0,
    },
  };
  const minimumBytes = jsonBytes(output);
  // Reserve counter digits, every reason, diagnostic flags and the explanatory hint.
  if (minimumBytes + 512 > limits.maxSearchOutputBytes) {
    codingRefusal(
      'BAD_REQUEST',
      'The search output budget cannot hold its coverage envelope',
      {
        hint: 'Increase maxSearchOutputBytes or shorten include.',
      },
    );
  }
  const visitFile = collectMatches(
    input,
    limits,
    budget,
    output,
    limits.maxSearchOutputBytes - minimumBytes - 512,
  );
  const excluded = new Set(config.search?.excludeDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);
  let rejectedByInclude = 0;
  let prunedByInclude = 0;
  if (caller?.aborted) budget.reasons.add('cancelled');
  else {
    try {
      await withSignalDeadline(
        limits.searchTimeoutMs,
        caller,
        () => 'search-timeout',
        async (signal) => {
          budget.limits.signal = signal;
          const included = input.include
            ? compileWorkspaceGlob(input.include, () => budget.check())
            : undefined;
          budget.directory();
          const root = await budget.wait(
            () => openPinnedDirectory(config.root),
            (handle) => {
              void handle.close().catch(() => undefined);
            },
          );
          try {
            await budget.wait(() =>
              authorizeCodingTool(config, {
                operation: 'search',
                query: input.query,
                mode: input.mode,
              }),
            );
            await budget.wait(() => authorizeCodingPath(config, '.'));
            const scan = await scanContainedFiles({
              root,
              maxDepth: limits.maxSearchDepth,
              maxFiles: limits.maxSearchFiles,
              symlinks: 'skip',
              skipUnreadable: true,
              budget,
              visitFile,
              maxDiagnostics: limits.maxSearchResults,
              ...(input.mode === 'content' && { readMaxBytes: limits.maxReadBytes }),
              excludeDirectory: (relative) => {
                if (relative.split(path.sep).some((segment) => excluded.has(segment)))
                  return true;
                if (included && !included.mayContain(relative)) {
                  prunedByInclude += 1;
                  return true;
                }
                return false;
              },
              includeFile: (candidate) => {
                if (included && !included.test(candidate)) {
                  rejectedByInclude += 1;
                  return false;
                }
                return true;
              },
              authorizePath: (candidate) => isCodingPathAuthorized(config, candidate),
            });
            output.scannedFiles = scan.scannedFiles;
            output.skippedDirectories = scan.skippedDirectories;
            output.skippedSymlinks = scan.skippedSymlinks;
            if (scan.denied.length > 0) {
              output.denied = scan.denied
                .slice(0, limits.maxSearchResults)
                .map(({ relative, kind }) => ({ path: relative, kind }));
              output.deniedTruncated =
                scan.deniedTruncated || scan.denied.length > output.denied.length;
            }
            if (scan.errors.length > 0) {
              output.errors = scan.errors.slice(0, limits.maxSearchResults);
              output.errorsTruncated =
                scan.errorsTruncated || scan.errors.length > output.errors.length;
            }
          } finally {
            await root.close();
          }
        },
      );
    } catch (error) {
      if (!(error instanceof ScanStopped)) throw error;
    }
  }
  if (
    input.include &&
    output.scannedFiles === 0 &&
    (rejectedByInclude > 0 || prunedByInclude > 0) &&
    budget.reasons.size === 0
  ) {
    output.hint =
      'The anchored include rejected the reached files or pruned incompatible directories. `*` does not cross `/`; use `**/` for subdirectories.';
  }
  const refresh = () => {
    output.coverage.reasons = [...budget.reasons];
    output.coverage.complete = budget.reasons.size === 0;
    output.truncated = !output.coverage.complete;
    output.coverage.visitedDirectories = budget.visitedDirectories;
    output.coverage.visitedEntries = budget.visitedEntries;
    output.coverage.readBytes = budget.readBytes;
    output.coverage.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  };
  refresh();
  boundSearchDiagnostics(output, budget, limits.maxSearchOutputBytes);
  refresh();
  if (jsonBytes(output) > limits.maxSearchOutputBytes)
    throw new Error('Search coverage envelope exceeded its reserved budget');
  return output;
}

export function createSearchCodingTool(
  config: AgentCodingToolConfig,
  limits: AgentCodingToolLimits,
) {
  return defineRuntimeTool({
    name: 'search_files',
    description:
      'Search bounded relative paths or UTF-8 file content under the workspace root; coverage explains incomplete results.',
    identity: { serviceName: 'coding', action: 'search', method: 'POST' },
    input: SearchInputSchema,
    output: SearchOutputSchema,
    transports: ['AGENT'],
    handler: ({ input, signal }) => searchFiles(config, limits, input, signal),
  });
}
