import type { DiagnosticJournalLockDiagnosis } from './diagnostic-journal-contract';

function assertNever(value: never): never {
  throw new Error(`Unhandled lock diagnosis value: ${String(value)}`);
}

function formatOwnerSuffix(owner: DiagnosticJournalLockDiagnosis['owner']): string {
  if (owner === null) return 'owner metadata missing or unreadable';
  const parts = [`pid=${owner.pid}`, `host=${owner.host}`];
  if (owner.machine !== undefined) parts.push(`machine=${owner.machine}`);
  if (owner.acquiredAt.length > 0) parts.push(`acquiredAt=${owner.acquiredAt}`);
  return parts.join(', ');
}

function formatLivenessNote(liveness: DiagnosticJournalLockDiagnosis['liveness']): string {
  switch (liveness) {
    case 'alive':
      return 'liveness reported alive';
    case 'gone':
      return 'liveness reported gone';
    case 'not-probed':
      return 'liveness not probed';
    default:
      return assertNever(liveness);
  }
}

function formatThisMachineSummary(
  liveness: DiagnosticJournalLockDiagnosis['liveness'],
  identity: DiagnosticJournalLockDiagnosis['identity'],
): string {
  if (identity === undefined) {
    switch (liveness) {
      case 'alive':
        return 'Lock PID is present on this machine without kernel process identity (cannot prove it is still the original holder)';
      case 'gone':
        return 'Lock belongs to this machine and its recorded owner is no longer running (stale lock)';
      case 'not-probed':
        return 'Lock belongs to this machine, but owner liveness was not probed';
      default:
        return assertNever(liveness);
    }
  }

  switch (identity) {
    case 'matched':
      switch (liveness) {
        case 'alive':
          return 'Lock is actively held on this machine by a live process with matching kernel process identity';
        case 'gone':
          return 'Lock matched kernel process identity on this machine, but the process is now gone';
        case 'not-probed':
          return 'Lock matched kernel process identity on this machine, with liveness not probed';
        default:
          return assertNever(liveness);
      }
    case 'descriptor-closed':
      return 'Lock names the current process on this machine, but this process holds no open descriptor on the lock file (stale lock from an earlier image)';
    case 'pid-gone':
      return 'Lock belongs to this machine, but the recorded process is no longer running (stale lock)';
    case 'reused-pid':
      return 'Lock PID on this machine was reused by a different process; the original owner is gone (stale lock)';
    case 'different-boot':
      return 'Lock belongs to this machine from a prior boot; the original owner is gone (stale lock)';
    case 'legacy':
      switch (liveness) {
        case 'alive':
          return 'Legacy lock on this machine without kernel process identity: PID exists, but PID presence alone cannot prove it is still the original holder';
        case 'gone':
          return 'Legacy lock on this machine without kernel process identity: recorded PID is no longer running';
        case 'not-probed':
          return 'Legacy lock on this machine without kernel process identity: liveness was not probed';
        default:
          return assertNever(liveness);
      }
    case 'unavailable':
      return `Lock belongs to this machine, but process identity evidence is unavailable (${formatLivenessNote(liveness)}); ownership cannot be verified`;
    default:
      return assertNever(identity);
  }
}

/**
 * Format a {@link DiagnosticJournalLockDiagnosis} into a single truthful,
 * operator-facing diagnostic string covering every combination of
 * `attribution x liveness x identity x owner` without drawing conclusions from
 * bare PID presence alone.
 */
export function formatDiagnosticJournalLockDiagnosis(
  diagnosis: DiagnosticJournalLockDiagnosis,
): string {
  const details = formatOwnerSuffix(diagnosis.owner);
  switch (diagnosis.attribution) {
    case 'this-machine':
      return `${formatThisMachineSummary(diagnosis.liveness, diagnosis.identity)} (${details})`;
    case 'another-machine':
      return `Lock belongs to another machine; ${formatLivenessNote(diagnosis.liveness)} from this host (${details})`;
    case 'unattributable':
      if (diagnosis.owner === null) {
        return `Lock owner metadata is missing or unreadable; ${formatLivenessNote(diagnosis.liveness)}`;
      }
      return `Lock cannot be attributed to this machine; ${formatLivenessNote(diagnosis.liveness)} (${details})`;
    default:
      return assertNever(diagnosis.attribution);
  }
}
