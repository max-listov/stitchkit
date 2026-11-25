import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { readRegularFile } from '../../files/regular-file';
import {
  loadDarwinBinding,
  requireDarwinServiceHostMethod,
} from '../../internal/darwin-binding';
import { errnoOf } from '../../internal/errno';
import { messageOf } from '../../internal/error-message';
import { computeSha256Hex } from '../artifact-manifest';
import {
  createDefaultLaunchdHostAdapter,
  lintLaunchdPlist,
  readLaunchdPlist,
} from '../launchd-plist';
import {
  BUNDLE_SPEC_DIGEST_PLIST_KEY,
  computeBundleSpecDigest,
  type MacosBundleDigestInput,
  renderBundleInfoPlist,
} from './bundle-plist';
import {
  resolveSigningIdentity,
  signBundle,
  type VerifiedBundleSignature,
  verifySignedBundle,
} from './codesign';
import { generateAppIconIcns } from './icon';
import { forgetRegistration, registerBundle } from './launch-services';
import {
  compileMacosLauncher,
  type MacosLauncherConfig,
  renderMacosLauncherSource,
} from './launcher';
import {
  createDefaultMacosCommandRunner,
  isProtectedMacosSystemPath,
  type MacosCommandRunner,
} from './runner';

/** Failure classifications thrown by {@link MacosBundleInstallError}. */
export type MacosBundleInstallErrorCode =
  | 'INVALID_PATH'
  | 'STAGING_FAILED'
  | 'VERIFICATION_FAILED'
  | 'SWAP_FAILED'
  | 'ROLLBACK_FAILED';

/**
 * Structured error thrown by {@link ensureSignedBundle}. When post-swap
 * verification fails and rollback itself fails, `stagingDir` is preserved and
 * `preservedPreviousBundlePath` points to the intact previous `.app`.
 */
export class MacosBundleInstallError extends Error {
  readonly code: MacosBundleInstallErrorCode;
  readonly rolledBack: boolean;
  readonly rollbackError: unknown;
  readonly preservedPreviousBundlePath: string | undefined;

  constructor(
    code: MacosBundleInstallErrorCode,
    message: string,
    options?: ErrorOptions & {
      rolledBack?: boolean;
      rollbackError?: unknown;
      preservedPreviousBundlePath?: string;
    },
  ) {
    super(message, options);
    this.name = 'MacosBundleInstallError';
    this.code = code;
    this.rolledBack = options?.rolledBack ?? false;
    this.rollbackError = options?.rollbackError;
    this.preservedPreviousBundlePath = options?.preservedPreviousBundlePath;
  }
}

/** Injectable host operations boundary for {@link ensureSignedBundle}. */
export interface MacosBundleHostAdapter {
  runner: MacosCommandRunner;
  swapDirectories(fromDirPath: string, toDirPath: string): Promise<void>;
  readPlist(plistPath: string): Promise<Record<string, unknown> | null>;
  lintPlist(plistPath: string): Promise<void>;
  registerBundle(appPath: string): Promise<void>;
  forgetRegistration(appPath: string): Promise<void>;
  rasterizeSvg?: (svg: string, sizePx: number, outPngPath: string) => Promise<void>;
}

/** Options for {@link ensureSignedBundle}. */
export interface EnsureSignedBundleOptions extends MacosBundleDigestInput {
  /** Absolute destination path ending in `.app` (never a symlink or system directory). */
  bundlePath: string;
  launcher: MacosLauncherConfig;
  signingIdentity?: string | null;
  expectedTeamId?: string;
  /** Rebuild and reinstall even when the existing bundle matches `specDigest` and verifies cleanly. */
  force?: boolean;
  /** Register the installed bundle with LaunchServices and forget the staged path (default: `true`). */
  registerWithLaunchServices?: boolean;
  /** Optional post-swap check; throwing triggers automatic rollback to the previous bundle. */
  afterSwapVerify?: (signature: VerifiedBundleSignature) => Promise<void>;
  arch?: 'arm64' | 'x86_64';
  adapter?: Partial<MacosBundleHostAdapter>;
}

/** Outcome returned by {@link ensureSignedBundle}. */
export interface EnsureSignedBundleResult {
  state: 'current' | 'installed';
  bundlePath: string;
  specDigest: string;
  signature: VerifiedBundleSignature;
}

/** Atomically exchange two directories using pinned `dirfd`s and `renameatx_np(..., RENAME_SWAP)`. */
export async function swapDirectoriesDarwin(
  fromDirPath: string,
  toDirPath: string,
): Promise<void> {
  const renameSwapAt = requireDarwinServiceHostMethod(loadDarwinBinding(), 'renameSwapAt');
  const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY;
  const fromParent = await open(dirname(fromDirPath), flags);
  try {
    const toParent = await open(dirname(toDirPath), flags);
    try {
      renameSwapAt(fromParent.fd, basename(fromDirPath), toParent.fd, basename(toDirPath));
    } finally {
      await toParent.close();
    }
  } finally {
    await fromParent.close();
  }
}

/** Build the default macOS bundle host adapter backed by real macOS utilities and Darwin N-API. */
export function createDefaultMacosBundleHostAdapter(
  overrides?: Partial<MacosBundleHostAdapter>,
): MacosBundleHostAdapter {
  const runner = overrides?.runner ?? createDefaultMacosCommandRunner();
  const launchdAdapter = createDefaultLaunchdHostAdapter();
  return {
    runner,
    swapDirectories: overrides?.swapDirectories ?? swapDirectoriesDarwin,
    readPlist:
      overrides?.readPlist ??
      ((plistPath) => readLaunchdPlist({ path: plistPath, adapter: launchdAdapter })),
    lintPlist:
      overrides?.lintPlist ??
      ((plistPath) => lintLaunchdPlist({ path: plistPath, adapter: launchdAdapter })),
    registerBundle:
      overrides?.registerBundle ??
      ((appPath) => registerBundle({ bundlePath: appPath, runner })),
    forgetRegistration:
      overrides?.forgetRegistration ??
      (async (appPath) => {
        await forgetRegistration({ bundlePath: appPath, runner });
      }),
    rasterizeSvg: overrides?.rasterizeSvg,
  };
}

function failInvalidPath(message: string): never {
  throw new MacosBundleInstallError('INVALID_PATH', message);
}

function normalizeBundleTargetPath(bundlePath: string): string {
  if (
    !bundlePath.startsWith('/') ||
    /[\0\r\n]/.test(bundlePath) ||
    bundlePath.split('/').includes('..')
  ) {
    failInvalidPath(
      `bundlePath must be a clean absolute path ending with ".app": ${JSON.stringify(bundlePath)}`,
    );
  }
  const normalized = posix.normalize(bundlePath).replace(/\/+$/, '');
  const lowered = normalized.toLowerCase();
  if (
    !lowered.endsWith('.app') ||
    lowered === '/.app' ||
    isProtectedMacosSystemPath(normalized, { applications: 'install-target' })
  ) {
    failInvalidPath(`Refusing to install bundle at forbidden or invalid path: ${bundlePath}`);
  }
  return normalized;
}

function assertValidEntitlementsPath(entitlementsPath: string): void {
  if (
    !entitlementsPath.startsWith('/') ||
    /[\0\r\n]/.test(entitlementsPath) ||
    entitlementsPath.split('/').includes('..')
  ) {
    failInvalidPath(
      `entitlementsPath must be a clean absolute path: ${JSON.stringify(entitlementsPath)}`,
    );
  }
}

async function inspectExistingBundle(bundlePath: string): Promise<boolean> {
  try {
    const stats = await lstat(bundlePath);
    if (stats.isSymbolicLink()) failInvalidPath(`Refusing to replace symlink: ${bundlePath}`);
    if (!stats.isDirectory())
      failInvalidPath(`Existing bundlePath is not a dir: ${bundlePath}`);
    return true;
  } catch (cause) {
    if (errnoOf(cause) === 'ENOENT') return false;
    throw cause;
  }
}

function verifyBundleForOptions(
  bundlePath: string,
  options: EnsureSignedBundleOptions,
  runner: MacosCommandRunner,
): Promise<VerifiedBundleSignature> {
  return verifySignedBundle({
    bundlePath,
    expectedBundleId: options.bundleIdentifier,
    expectedTeamId: options.expectedTeamId,
    requireHardenedRuntime: options.requireHardenedRuntime ?? true,
    runner,
  });
}

async function tryCurrentBundle(
  options: EnsureSignedBundleOptions,
  specDigest: string,
  adapter: MacosBundleHostAdapter,
): Promise<VerifiedBundleSignature | null> {
  try {
    const plist = await adapter.readPlist(join(options.bundlePath, 'Contents', 'Info.plist'));
    if (plist === null || plist[BUNDLE_SPEC_DIGEST_PLIST_KEY] !== specDigest) return null;
    return await verifyBundleForOptions(options.bundlePath, options, adapter.runner);
  } catch {
    return null;
  }
}

async function buildAndSignStagedBundle(
  options: EnsureSignedBundleOptions,
  stagedApp: string,
  specDigest: string,
  resolvedIdentity: string | undefined,
  adapter: MacosBundleHostAdapter,
): Promise<VerifiedBundleSignature> {
  const contentsDir = join(stagedApp, 'Contents');
  const macosDir = join(contentsDir, 'MacOS');
  const resourcesDir = join(contentsDir, 'Resources');
  await mkdir(macosDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });

  await compileMacosLauncher({
    config: options.launcher,
    outputPath: join(macosDir, options.executableName),
    arch: options.arch,
    runner: adapter.runner,
  });

  let iconFile: string | undefined;
  if (options.icon !== undefined) {
    await generateAppIconIcns({
      source: options.icon,
      outputPath: join(resourcesDir, 'AppIcon.icns'),
      runner: adapter.runner,
      rasterizeSvg: adapter.rasterizeSvg,
    });
    iconFile = 'AppIcon';
  }

  const { bundleIdentifier, bundleName, displayName, executableName, bundleVersion } = options;
  const infoPlist = renderBundleInfoPlist({
    bundleIdentifier,
    bundleName,
    displayName,
    executableName,
    bundleVersion,
    shortVersionString: options.shortVersionString,
    iconFile,
    lsBackgroundOnly: options.lsBackgroundOnly,
    lsUIElement: options.lsUIElement,
    lsMinimumSystemVersion: options.lsMinimumSystemVersion,
    specDigest,
    extraEntries: options.extraInfoPlistEntries,
  });

  const infoPlistPath = join(contentsDir, 'Info.plist');
  await writeFile(infoPlistPath, infoPlist, { encoding: 'utf8', mode: 0o644 });
  await adapter.lintPlist(infoPlistPath);

  const identity =
    resolvedIdentity ??
    (await resolveSigningIdentity({
      identity: options.signingIdentity,
      runner: adapter.runner,
    }));
  await signBundle({
    bundlePath: stagedApp,
    identity,
    hardenedRuntime: options.requireHardenedRuntime ?? true,
    entitlementsPath: options.entitlementsPath,
    runner: adapter.runner,
  });

  return verifyBundleForOptions(stagedApp, options, adapter.runner);
}

type InstallPhase = 'staged' | 'swapped' | 'installed' | 'rolled-back' | 'rollback-failed';

/**
 * Idempotently build, sign, pre-verify, atomically swap (`renameatx_np` with
 * `RENAME_SWAP`), post-verify, and register a macOS `.app` launcher bundle.
 * Preserves `stagingDir` and reports `preservedPreviousBundlePath` on double failure.
 */
export async function ensureSignedBundle(
  rawOptions: EnsureSignedBundleOptions,
): Promise<EnsureSignedBundleResult> {
  const bundlePath = normalizeBundleTargetPath(rawOptions.bundlePath);
  const options: EnsureSignedBundleOptions =
    bundlePath === rawOptions.bundlePath ? rawOptions : { ...rawOptions, bundlePath };
  const hadExisting = await inspectExistingBundle(options.bundlePath);
  const adapter = createDefaultMacosBundleHostAdapter(options.adapter);
  // Validate explicit signingIdentity BEFORE tryCurrentBundle so forbidden identities
  // (e.g. null, ad-hoc '-') can never short-circuit to state: 'current'.
  const resolvedExplicitIdentity =
    options.signingIdentity !== undefined
      ? await resolveSigningIdentity({
          identity: options.signingIdentity,
          runner: adapter.runner,
        })
      : undefined;

  let entitlementsSha256: string | null = null;
  if (options.entitlementsPath !== undefined) {
    assertValidEntitlementsPath(options.entitlementsPath);
    try {
      entitlementsSha256 = computeSha256Hex(await readRegularFile(options.entitlementsPath));
    } catch (cause) {
      throw new MacosBundleInstallError(
        'STAGING_FAILED',
        `Unable to read entitlementsPath ${options.entitlementsPath}: ${messageOf(cause)}`,
        { cause },
      );
    }
  }

  const specDigest = computeBundleSpecDigest(
    {
      ...options,
      entitlementsSha256,
      signingIdentity: resolvedExplicitIdentity ?? options.signingIdentity,
    },
    renderMacosLauncherSource(options.launcher),
  );

  if (!options.force && hadExisting) {
    const currentSignature = await tryCurrentBundle(options, specDigest, adapter);
    if (currentSignature !== null) {
      return {
        state: 'current',
        bundlePath: options.bundlePath,
        specDigest,
        signature: currentSignature,
      };
    }
  }

  const parentDir = dirname(options.bundlePath);
  const appName = basename(options.bundlePath);
  await mkdir(parentDir, { recursive: true });
  const stagingDir = join(
    parentDir,
    `.${appName}-${randomBytes(6).toString('hex')}.install.noindex`,
  );
  const stagedApp = join(stagingDir, appName);
  const shouldRegister = options.registerWithLaunchServices ?? true;

  let phase: InstallPhase = 'staged';
  let preserveStagingDir = false;
  try {
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const stagedSignature = await buildAndSignStagedBundle(
      options,
      stagedApp,
      specDigest,
      resolvedExplicitIdentity,
      adapter,
    );

    try {
      if (hadExisting) await adapter.swapDirectories(stagedApp, options.bundlePath);
      else await rename(stagedApp, options.bundlePath);
    } catch (swapCause) {
      throw new MacosBundleInstallError(
        'SWAP_FAILED',
        `Failed to install staged bundle into ${options.bundlePath}: ${messageOf(swapCause)}`,
        { cause: swapCause },
      );
    }
    phase = 'swapped';

    const liveSignature = await verifyBundleForOptions(
      options.bundlePath,
      options,
      adapter.runner,
    );
    if (liveSignature.cdHash !== stagedSignature.cdHash) {
      throw new MacosBundleInstallError(
        'VERIFICATION_FAILED',
        `Post-swap CDHash mismatch for ${options.bundlePath}: expected ${stagedSignature.cdHash}, observed ${liveSignature.cdHash}`,
      );
    }
    if (options.afterSwapVerify !== undefined) await options.afterSwapVerify(liveSignature);
    if (shouldRegister) await adapter.registerBundle(options.bundlePath);
    phase = 'installed';

    return {
      state: 'installed',
      bundlePath: options.bundlePath,
      specDigest,
      signature: liveSignature,
    };
  } catch (cause) {
    let rollbackError: unknown;
    if (phase === 'swapped') {
      try {
        if (hadExisting) await adapter.swapDirectories(stagedApp, options.bundlePath);
        else await rm(options.bundlePath, { recursive: true, force: true });
        phase = 'rolled-back';
      } catch (rbErr) {
        phase = 'rollback-failed';
        preserveStagingDir = true;
        rollbackError = rbErr;
      }
    }
    if (phase === 'rollback-failed') {
      throw new MacosBundleInstallError(
        'ROLLBACK_FAILED',
        `${messageOf(cause)}; rollback also failed: ${messageOf(rollbackError)}`,
        {
          cause,
          rolledBack: false,
          rollbackError,
          preservedPreviousBundlePath: hadExisting ? stagedApp : undefined,
        },
      );
    }
    const code: MacosBundleInstallErrorCode =
      cause instanceof MacosBundleInstallError
        ? cause.code
        : phase === 'rolled-back'
          ? 'VERIFICATION_FAILED'
          : 'STAGING_FAILED';
    throw new MacosBundleInstallError(code, messageOf(cause), {
      cause,
      rolledBack: phase === 'rolled-back',
    });
  } finally {
    if (!preserveStagingDir) {
      if (phase === 'installed' && shouldRegister) {
        await adapter.forgetRegistration(stagedApp).catch(() => undefined);
      }
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
