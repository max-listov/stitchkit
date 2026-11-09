import type { SearchOutput } from './coding-search-contract';
import { type ContainedScanBudget, ScanStopped } from './contained-scan-budget';

/** Matches are admitted while streaming; diagnostics get the remaining serialized byte budget. */
export function boundSearchDiagnostics(
  output: Pick<SearchOutput, 'denied' | 'errors' | 'deniedTruncated' | 'errorsTruncated'>,
  budget: ContainedScanBudget,
  maxBytes: number,
): void {
  const canContinue = (): boolean => {
    try {
      budget.check();
      return true;
    } catch (error) {
      if (!(error instanceof ScanStopped)) throw error;
      return false;
    }
  };
  canContinue();
  const denied = output.denied;
  const errors = output.errors;
  if (denied) output.denied = [];
  if (errors) output.errors = [];
  // Reasons and truncation flags can grow after admission; their space is reserved once.
  const available = maxBytes - Buffer.byteLength(JSON.stringify(output)) - 256;
  let used = 0;
  const take = <T>(items: readonly T[], truncated: () => void): T[] => {
    const admitted: T[] = [];
    for (const item of items) {
      if (!canContinue()) {
        truncated();
        break;
      }
      const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (used + bytes > available) {
        budget.reasons.add('max-output-bytes');
        truncated();
        break;
      }
      used += bytes;
      admitted.push(item);
    }
    return admitted;
  };
  if (denied)
    output.denied = take(denied, () => {
      output.deniedTruncated = true;
    });
  if (errors)
    output.errors = take(errors, () => {
      output.errorsTruncated = true;
    });
}
