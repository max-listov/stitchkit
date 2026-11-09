import { mock } from 'bun:test';
import { openSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-spelling-model-'));
const handle = await open(root, 'r');
Object.defineProperty(process, 'platform', { value: 'darwin' });
mock.module(
  fileURLToPath(new URL('../../src/internal/darwin-binding.ts', import.meta.url)),
  () => ({
    loadDarwinBinding: () => ({
      reopenDirectory: () => openSync(root, 'r'),
      statAt: () => ({ mode: 0o040755, size: 0 }),
      listAt: (_fd: number, _limit: number, progress: (entry: boolean) => void) => {
        progress(true);
        return [];
      },
    }),
  }),
);
try {
  const { misspelledContainedSegment } = await import('../../src/internal/contained-files');
  const { ContainedScanBudget, ScanStopped } = await import(
    '../../src/agent-runtime/contained-scan-budget'
  );
  const budget = new ContainedScanBudget({ maxEntries: 1 });
  let result: string | undefined;
  try {
    result = await misspelledContainedSegment(handle, 'foo', {
      check: () => budget.check(),
      directory: () => budget.directory(),
      entry: () => budget.entry(),
      remainingEntries: () => budget.remainingEntries(),
      wait: (operation, dispose) => budget.wait(operation, dispose),
    });
  } catch (error) {
    if (!(error instanceof ScanStopped)) throw error;
  }
  console.log(
    JSON.stringify({
      ...(result && { result }),
      observed: budget.visitedEntries,
      reasons: [...budget.reasons],
    }),
  );
} finally {
  await handle.close();
  await rm(root, { recursive: true, force: true });
}
