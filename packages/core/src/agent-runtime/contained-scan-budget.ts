import { raceAbort } from '../internal/abort-race';

import type { ScanStopReason } from './contained-scan-contract';

export class ScanStopped extends Error {}

/** Checkpoints cover CPU work; races bound async policies and dispose late capabilities. */
export class ContainedScanBudget {
  readonly reasons = new Set<ScanStopReason>();
  visitedDirectories = 0;
  visitedEntries = 0;
  readBytes = 0;

  constructor(
    readonly limits: {
      maxDirectories?: number;
      maxEntries?: number;
      maxBytes?: number;
      signal?: AbortSignal;
      deadline?: number;
    } = {},
  ) {}

  stop(reason: ScanStopReason): never {
    this.reasons.add(reason);
    throw new ScanStopped(reason);
  }

  check(): void {
    if (this.limits.deadline !== undefined && performance.now() >= this.limits.deadline)
      this.stop('timeout');
    if (this.limits.signal?.aborted) this.stop('cancelled');
  }

  async wait<T>(operation: () => Promise<T>, disposeLate?: (value: T) => void): Promise<T> {
    this.check();
    try {
      const pending = operation();
      const value = this.limits.signal
        ? await raceAbort(pending, this.limits.signal, disposeLate)
        : await pending;
      // An acquired capability belongs to the caller even if a CPU deadline elapsed
      // before this continuation. The caller checks inside its cleanup scope.
      return value;
    } catch (error) {
      this.check();
      throw error;
    }
  }

  directory(): void {
    this.check();
    if (this.visitedDirectories >= (this.limits.maxDirectories ?? Infinity))
      this.stop('max-directories');
    this.visitedDirectories += 1;
  }

  remainingEntries(): number | undefined {
    this.check();
    const max = this.limits.maxEntries;
    if (max === undefined) return undefined;
    if (this.visitedEntries >= max) this.stop('max-entries');
    return max - this.visitedEntries;
  }

  entry(): void {
    this.remainingEntries();
    this.visitedEntries += 1;
  }

  readAllowance(maxFileBytes: number): number {
    this.check();
    const remaining = (this.limits.maxBytes ?? Infinity) - this.readBytes;
    if (remaining <= 0) this.stop('max-bytes');
    return Math.min(maxFileBytes, remaining);
  }
}
