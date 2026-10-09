export const OWNER_LOSS_GUARD_FLAG = '--stitchkit-owner-loss-guard-v1';

export interface OwnerLossGuardInvocation {
  readonly entry: string;
  readonly signalTarget: 'group' | 'leader';
}

/** The owner-loss guard is certified only on the two POSIX kernels exercised by release CI. */
export function ownerLossAvailable(platform: NodeJS.Platform): boolean {
  return platform === 'linux' || platform === 'darwin';
}

/** Replace a direct command with the package-owned guard that becomes its process-group leader. */
export function ownerLossGuardCommand(
  guard: OwnerLossGuardInvocation,
  executable: string,
  args: readonly string[],
): [string, ...string[]] {
  return [
    process.execPath,
    guard.entry,
    OWNER_LOSS_GUARD_FLAG,
    guard.signalTarget,
    executable,
    ...args,
  ];
}
