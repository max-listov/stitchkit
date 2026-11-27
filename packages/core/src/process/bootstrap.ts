import { ownerLossGuardStarted } from './owner-loss-guard';
import { workRootStarted } from './work-root';

/**
 * Bootstrap the package's private process invocations before an application's own argv dispatcher.
 *
 * A single-file application starts itself again for two package-owned jobs: the owner-loss guard
 * of `runNativeCommand` and the recorded root of work launched with `placement: { kind:
 * 'process-root' }`. Call this once before routing argv. `false` means the application owns this
 * invocation and may dispatch it; `true` means the package owns it and the application must skip
 * its dispatcher. A work root replaces the process with its command while this module loads, so
 * `true` is returned for it only when that command could not start.
 */
export function bootstrapPackageProcess(): boolean {
  return ownerLossGuardStarted() || workRootStarted();
}
