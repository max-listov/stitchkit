import type { z } from 'zod';
import { openPinnedDirectory } from '../internal/contained-directory';
import type { ContainedFileHandle } from '../internal/contained-handle';
import { withSignalDeadline } from '../internal/deadline';
import type { AgentCodingToolConfig, AgentCodingToolLimits } from './coding-tool-contract';
import { codingRefusal } from './coding-tool-refusals';
import { ContainedScanBudget, ScanStopped } from './contained-scan-budget';
import type { DiscoveryCoverageSchema } from './contained-scan-contract';

export function discoveryRun(
  config: AgentCodingToolConfig,
  limits: AgentCodingToolLimits,
  path: string,
  include: string,
  symlinks: 'skip' | 'list',
) {
  const started = performance.now();
  const budget = new ContainedScanBudget({
    maxDirectories: limits.maxSearchDirectories,
    maxEntries: limits.maxSearchEntries,
    maxBytes: limits.maxSearchBytes,
    deadline: started + limits.searchTimeoutMs,
  });
  const coverage: z.infer<typeof DiscoveryCoverageSchema> = {
    complete: true,
    reasons: [],
    scope: {
      path,
      include,
      excludedDirectories: config.search?.excludeDirectories ? 'configured' : 'default',
      symlinks,
    },
    visitedDirectories: 0,
    visitedEntries: 0,
    readBytes: 0,
    elapsedMs: 0,
  };
  return {
    budget,
    coverage,
    async run(
      caller: AbortSignal | undefined,
      work: (root: ContainedFileHandle) => Promise<void>,
    ) {
      if (caller?.aborted) {
        budget.reasons.add('cancelled');
        return;
      }
      try {
        await withSignalDeadline(
          limits.searchTimeoutMs,
          caller,
          () => 'discovery-timeout',
          async (signal) => {
            budget.limits.signal = signal;
            budget.directory();
            const root = await budget.wait(
              () => openPinnedDirectory(config.root),
              (handle) => {
                void handle.close().catch(() => undefined);
              },
            );
            try {
              budget.check();
              await work(root);
            } finally {
              await root.close();
            }
          },
        );
      } catch (error) {
        if (!(error instanceof ScanStopped)) throw error;
      }
    },
    refresh() {
      coverage.complete = budget.reasons.size === 0;
      coverage.reasons = [...budget.reasons];
      coverage.visitedDirectories = budget.visitedDirectories;
      coverage.visitedEntries = budget.visitedEntries;
      coverage.readBytes = budget.readBytes;
      coverage.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    },
  };
}

/** Admission precedes retention; names cannot multiply the serialized output limit. */
export function discoveryCollector(
  output: unknown,
  budget: ContainedScanBudget,
  maximum: number,
) {
  const reserve = Buffer.byteLength(JSON.stringify(output)) + 512;
  if (reserve > maximum)
    codingRefusal('BAD_REQUEST', 'Discovery output budget cannot hold its coverage envelope', {
      hint: 'Increase maxSearchOutputBytes or shorten the path/pattern.',
    });
  let bytes = reserve;
  return (item: unknown) => {
    budget.check();
    const next = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + next > maximum) budget.stop('max-output-bytes');
    bytes += next;
  };
}
