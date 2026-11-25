/**
 * Host service supervision primitives: verified versioned artifact activation,
 * Linux `systemd` and macOS `launchd` unit rendering/inspection/reload with
 * automatic rollback, and live process / Unix-socket identity verification.
 *
 * Host commands run by absolute path with a declared environment, never through the
 * caller's `PATH`: `/usr/bin/systemctl`, `/bin/launchctl`, `/usr/bin/plutil`. Verifying
 * Unix-socket ownership with the default process adapter requires iproute2 `ss` at
 * `/usr/bin/ss` or `/usr/sbin/ss`; without it the check answers `socket-unverifiable`.
 */

export {
  type VerifiedArtifact,
  type VerifiedArtifactFile,
  type VerifyArtifactOptions,
  verifyArtifactDirectory,
} from '../service-host/artifact';
export {
  type ActivatedArtifactResult,
  type ActivateVersionedArtifactOptions,
  activateVersionedArtifact,
  type RollbackArtifactResult,
  type RollbackVersionedArtifactOptions,
  rollbackVersionedArtifact,
} from '../service-host/artifact-activation';
export {
  ARTIFACT_MANIFEST_FILENAME,
  type ArtifactErrorCode,
  type ArtifactFileEntry,
  ArtifactFileEntrySchema,
  type ArtifactManifest,
  ArtifactManifestSchema,
  ArtifactVerificationError,
  computeArtifactManifestDigest,
  DEFAULT_ARTIFACT_MAX_FILE_BYTES,
  DEFAULT_ARTIFACT_MAX_FILES,
} from '../service-host/artifact-manifest';
export {
  type ConfigReloader,
  type ConfigReloaderClock,
  type ConfigReloaderError,
  type ConfigReloaderOptions,
  type ConfigReloaderPhase,
  type ConfigReloaderShutdownOptions,
  type ConfigReloaderShutdownResult,
  type ConfigReloaderState,
  type ConfigReloaderStatus,
  type ConfigSource,
  type ConfigSourceReading,
  createPolledJsonConfigSource,
  DEFAULT_CONFIG_POLL_INTERVAL_MS,
  DEFAULT_CONFIG_START_TIMEOUT_MS,
  DEFAULT_CONFIG_STOP_TIMEOUT_MS,
  type PolledJsonConfigSourceOptions,
  startConfigReloader,
} from '../service-host/config-reloader';
export type { ServiceHostPathState } from '../service-host/host-adapter';
export {
  type ArgvMatchMode,
  createDefaultProcessIdentityAdapter,
  type ProcessIdentityAdapter,
  type ProcNetUnixSocket,
  parseProcNetUnixListeningSockets,
  type SupervisedProcessConflictReason,
  type SupervisedProcessUnavailableReason,
  type SupervisedProcessVerification,
  type VerifySupervisedProcessOptions,
  verifySupervisedProcess,
} from '../service-host/identity';
export {
  type BootoutLaunchdJobOptions,
  bootoutLaunchdJob,
  type InspectLaunchdJobOptions,
  inspectLaunchdJob,
  type LaunchdReloadResult,
  type ReloadLaunchdJobOptions,
  reloadLaunchdJob,
} from '../service-host/launchd';
export {
  createDefaultLaunchdHostAdapter,
  type LaunchdCommandResult,
  type LaunchdHostAdapter,
  type LintLaunchdPlistOptions,
  lintLaunchdPlist,
  PLUTIL_PATH,
  type ReadLaunchdPlistOptions,
  readLaunchdPlist,
} from '../service-host/launchd-plist';
export {
  LaunchdJobError,
  type LaunchdJobErrorCode,
  type LaunchdJobInspection,
  LaunchdKeepAliveSchema,
  type LaunchdPlistConfig,
  LaunchdPlistConfigSchema,
  type LaunchdSessionType,
  LaunchdSessionTypeSchema,
  parseLaunchctlPrint,
  renderLaunchdPlist,
} from '../service-host/launchd-render';
export {
  type ApplySystemdUnitOptions,
  installAndStartSystemdUnit,
  reloadSystemdUnit,
  type SystemdApplyResult,
} from '../service-host/systemd';
export {
  type CheckSystemdUnitOptions,
  checkSystemdUnit,
  createDefaultSystemdHostAdapter,
  type SystemdCommandResult,
  type SystemdHostAdapter,
  type SystemdUnitCheckResult,
  type SystemdUnitCheckStatus,
  type SystemdUnitQueryOptions,
  systemdMainPid,
  systemdUnitActive,
} from '../service-host/systemd-inspect';
export {
  renderSystemdServiceUnit,
  type SystemdServiceUnitConfig,
  SystemdServiceUnitConfigSchema,
} from '../service-host/systemd-render';
export {
  type SystemdBindReadOnlyPath,
  type SystemdScope,
  SystemdScopeSchema,
  SystemdUnitError,
  type SystemdUnitErrorCode,
} from '../service-host/systemd-render-shared';
export {
  type CheckSystemdTimerPairOptions,
  checkSystemdTimerPair,
  type InstallSystemdTimerPairOptions,
  installSystemdTimerPair,
  type SystemdTimerPairCheckResult,
  type SystemdTimerPairInstallResult,
} from '../service-host/systemd-timer';
export {
  renderSystemdTimerUnit,
  type SystemdTimerUnitConfig,
  SystemdTimerUnitConfigSchema,
} from '../service-host/systemd-timer-render';
