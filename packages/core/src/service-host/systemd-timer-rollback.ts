import type { SystemdHostAdapter } from './systemd-inspect';
import type { EnablementLinks } from './systemd-links';
import type { SystemdScope } from './systemd-render-shared';
import { restoreUnitEnablement, runSystemctlChecked } from './systemd-unit-ops';

/** Captured state required to roll back a partially installed `.service` + `.timer` pair. */
export interface PairRollbackPoint {
  scope: SystemdScope;
  serviceUnitPath: string;
  timerUnitName: string;
  timerUnitPath: string;
  previousServiceBytes: Uint8Array | null;
  previousServiceMode: number;
  previousTimerBytes: Uint8Array | null;
  previousTimerMode: number;
  timerWasActive: boolean;
  previousTimerUnitFileState: string | null;
  linkDirs: readonly string[];
  linkNames: ReadonlySet<string>;
  linksBefore: EnablementLinks;
  wroteService: boolean;
  wroteTimer: boolean;
  didEnable: boolean;
  didActivate: boolean;
}

/** Restore both unit files, enablement links, and timer activation state after a failed install. */
export async function rollbackTimerPair(
  adapter: SystemdHostAdapter,
  point: PairRollbackPoint,
): Promise<void> {
  const { scope, timerUnitName, timerUnitPath, serviceUnitPath } = point;
  const enablementPoint = {
    scope,
    unitName: timerUnitName,
    previousBytes: point.previousTimerBytes,
    previousUnitFileState: point.previousTimerUnitFileState,
    linkDirs: point.linkDirs,
    linkNames: point.linkNames,
    linksBefore: point.linksBefore,
  };
  if (point.didActivate && point.previousTimerBytes === null) {
    await runSystemctlChecked(adapter, scope, ['stop', '--', timerUnitName]);
  }
  if (point.didEnable && point.previousTimerBytes === null) {
    await restoreUnitEnablement(adapter, enablementPoint);
  }
  if (point.wroteService) {
    if (point.previousServiceBytes === null) await adapter.removeFile(serviceUnitPath);
    else {
      await adapter.writeFileAtomic(serviceUnitPath, point.previousServiceBytes, {
        mode: point.previousServiceMode,
      });
    }
  }
  if (point.wroteTimer) {
    if (point.previousTimerBytes === null) await adapter.removeFile(timerUnitPath);
    else {
      await adapter.writeFileAtomic(timerUnitPath, point.previousTimerBytes, {
        mode: point.previousTimerMode,
      });
    }
  }
  await runSystemctlChecked(adapter, scope, ['daemon-reload']);
  if (point.didActivate && point.previousTimerBytes !== null) {
    await runSystemctlChecked(adapter, scope, [
      point.timerWasActive ? 'restart' : 'stop',
      '--',
      timerUnitName,
    ]);
  }
  if (point.didEnable && point.previousTimerBytes !== null) {
    await restoreUnitEnablement(adapter, enablementPoint);
  }
}
