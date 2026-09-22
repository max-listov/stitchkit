/**
 * The two halves of self-update: an update *check* that can never hurt, and an
 * update *apply* that can never leave a broken binary behind.
 *
 * They are separate on purpose. A check that replaces the binary by itself turns
 * every invocation into a possible surprise, and a check that can fail loudly
 * turns an unreachable network into a broken tool. So: the check is bounded, at
 * most once per interval, and silent on every failure; replacing the binary is
 * an explicit command.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { writeFileAtomic } from '../internal/atomic-file';
import { fetchGuarded, PrivateAddressRefusal, readCapped } from '../internal/secure-fetch';
import {
  type CliBuildAsset,
  type CliBuildManifest,
  CliBuildManifestSchema,
  type CliBuildTarget,
  currentCliBuildTarget,
  selectCliBuildAsset,
} from './cli-manifest';
import {
  type CliSignatureVerdict,
  type CliTrustRoot,
  cliSignatureAccepted,
  verifyCliManifest,
} from './cli-signature';

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MANIFEST_MAX_BYTES = 256 * 1_024;
/** A compiled single-platform CLI is tens of megabytes; this is the ceiling. */
const DEFAULT_MAX_ASSET_BYTES = 256 * 1_024 * 1_024;

export interface CliUpdateCheckConfig {
  manifestUrl: string;
  currentVersion: string;
  /** At most one network check per interval; default 24 h. */
  intervalMs?: number;
  /** When the last check happened, from the application's own state. */
  lastCheckedAt?: number;
  now?: number;
  /** Header+body deadline for the check; default 2 s. */
  timeoutMs?: number;
  target?: CliBuildTarget;
  allowPrivateHosts?: boolean;
  /**
   * Keys this build trusts. With none, nothing is enforced and the verdict says
   * so out loud (`unenforced`) rather than leaving "checked" to be assumed.
   */
  trust?: CliTrustRoot;
}

/**
 * Four answers, never three. "Could not ask" is not "up to date": collapsing
 * them is how a tool goes quiet about its own staleness for months.
 */
export type CliUpdateCheck =
  | { status: 'skipped'; nextCheckAt: number }
  | { status: 'current'; version: string; signature?: CliSignatureVerdict }
  | {
      status: 'outdated';
      version: string;
      manifest: CliBuildManifest;
      asset?: CliBuildAsset;
      /** What the signature check concluded — always present once it ran. */
      signature?: CliSignatureVerdict;
    }
  | { status: 'unknown'; reason: string };

interface ParsedVersion {
  numbers: readonly number[];
  prerelease: string | undefined;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return undefined;
  const numbers = [match[1], match[2], match[3]].map((part) => Number(part));
  if (numbers.some((part) => !Number.isFinite(part))) return undefined;
  return { numbers, prerelease: match[4] };
}

/**
 * Compare two versions, or refuse to. `undefined` means "these are not
 * comparable", which the caller reports as unknown rather than guessing an
 * order — an update prompt derived from a guess is worse than no prompt.
 */
export function compareCliVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  // A prerelease precedes its own release: 1.2.0-rc.1 < 1.2.0.
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** Ask whether a newer build exists. Never throws; never blocks for long. */
export async function checkCliUpdate(config: CliUpdateCheckConfig): Promise<CliUpdateCheck> {
  const now = config.now ?? Date.now();
  const interval = config.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  if (config.lastCheckedAt !== undefined && now - config.lastCheckedAt < interval) {
    return { status: 'skipped', nextCheckAt: config.lastCheckedAt + interval };
  }
  try {
    const response = await fetchGuarded(
      new URL(config.manifestUrl),
      config.allowPrivateHosts ?? false,
      {
        timeoutMs: config.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
        bodyTimeoutMs: config.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      },
    );
    if (!response.ok)
      return { status: 'unknown', reason: `manifest responded ${response.status}` };
    const body = await readCapped(response, MANIFEST_MAX_BYTES);
    if (!body) return { status: 'unknown', reason: 'manifest is larger than expected' };
    const parsed = CliBuildManifestSchema.safeParse(JSON.parse(body.toString('utf8')));
    if (!parsed.success) return { status: 'unknown', reason: 'manifest did not validate' };
    const manifest = parsed.data;
    const order = compareCliVersions(config.currentVersion, manifest.version);
    if (order === undefined) {
      return {
        status: 'unknown',
        reason: `cannot compare ${config.currentVersion} with ${manifest.version}`,
      };
    }
    const verdict = verifyCliManifest(manifest, manifest.signature, config.trust);
    if (order >= 0)
      return { status: 'current', version: manifest.version, signature: verdict };
    if (!cliSignatureAccepted(verdict)) {
      // Not a fifth status. `outdated` is an instruction to install, and we have
      // not established that there is a newer build worth installing — only that
      // a document claims one. "Could not ask" is the honest class for that, and
      // the reason names which check refused, so it is never mistaken for a
      // network failure.
      return { status: 'unknown', reason: `manifest signature: ${verdict}` };
    }
    const asset = selectCliBuildAsset(manifest, config.target ?? currentCliBuildTarget());
    return {
      status: 'outdated',
      version: manifest.version,
      manifest,
      ...(asset && { asset }),
      signature: verdict,
    };
  } catch (error) {
    // The boundary refusing an address and the network failing are both
    // "could not ask", and only one of them has a switch. Relaying the guard's
    // own sentence made a self-hosted endpoint look like a timeout, so the
    // remedy is named here, where the field that holds it is declared.
    if (error instanceof PrivateAddressRefusal) {
      return {
        status: 'unknown',
        reason:
          `${error.message} — the manifest endpoint is not public. Set ` +
          '`allowPrivateHosts` if it is your own deployment; the download keeps ' +
          'its own setting, because an asset URL comes from the document.',
      };
    }
    return {
      status: 'unknown',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CliUpdateApplyConfig {
  asset: CliBuildAsset;
  /** The file to replace; defaults to the running executable. */
  targetPath?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivateHosts?: boolean;
  /**
   * The document the asset came from, so authorship can be checked here too.
   *
   * `CliBuildAsset` cannot carry the proof: the signature covers the manifest's
   * identity and every asset's digest together, which is what closes the chain
   * on the file that executes. Passing both is what lets this refuse **before**
   * it downloads anything.
   */
  manifest?: CliBuildManifest;
  /** Keys this build trusts. With `manifest`, the pair is checked before the fetch. */
  trust?: CliTrustRoot;
  /**
   * Keep the bytes being replaced, here, so there is something to go back to.
   *
   * Written after the new bytes are verified and before the target is replaced:
   * a backup taken earlier could preserve a binary that was about to be
   * replaced by a download that then failed its digest, and a backup taken
   * later has nothing left to copy. The target's own mode is carried over — the
   * point of a backup is to be runnable.
   */
  backupPath?: string;
}

export interface AppliedCliUpdate {
  path: string;
  bytes: number;
  sha256: string;
  /** Where the replaced bytes were kept, when a backup was asked for and there was one. */
  backupPath?: string;
  /** Digest of the replaced bytes — what `rollbackCliUpdate` expects to find. */
  backupSha256?: string;
}

/**
 * Download, verify and replace the binary.
 *
 * The digest is taken over the decompressed bytes — the file that will be
 * executed — and the last step is a rename inside the target's own directory,
 * so the executable on the PATH is either the old one or the new one and never
 * a partial write.
 */
export async function applyCliUpdate(config: CliUpdateApplyConfig): Promise<AppliedCliUpdate> {
  const target = config.targetPath ?? process.execPath;
  if (config.trust) {
    // Before the fetch, deliberately. A signature checked after the download is
    // a signature checked after the bytes were already on the machine, and the
    // refusal it produces is a cleanup problem rather than a refusal.
    if (!config.manifest) {
      throw new Error(
        '[stitchkit] update: a trust root needs the manifest the asset came from',
      );
    }
    const verdict = verifyCliManifest(
      config.manifest,
      config.manifest.signature,
      config.trust,
    );
    if (!cliSignatureAccepted(verdict)) {
      throw new Error(
        `[stitchkit] update: refusing to install — manifest signature ${verdict}`,
      );
    }
    if (!config.manifest.assets.some((asset) => asset.sha256 === config.asset.sha256)) {
      // The signature covers the manifest's assets. An asset that is not one of
      // them is outside everything that was proven, however well-formed it looks.
      throw new Error('[stitchkit] update: the asset is not one the signed manifest names');
    }
  }
  const response = await fetchGuarded(
    new URL(config.asset.url),
    config.allowPrivateHosts ?? false,
    {
      timeoutMs: config.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      bodyTimeoutMs: config.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    },
  );
  if (!response.ok) {
    throw new Error(`[stitchkit] update download responded ${response.status}`);
  }
  const transferred = await readCapped(response, config.maxBytes ?? DEFAULT_MAX_ASSET_BYTES);
  if (!transferred) throw new Error('[stitchkit] update download exceeded the size ceiling');

  // Bounded by the size the manifest declares — which, with a trust root, is a
  // signed number. Unbounded, a 0.3 MB archive expands to 300 MB before any
  // digest can disagree with it, and the ceiling on the TRANSFER (256 MB)
  // permits roughly a thousand times that on the output.
  const bytes =
    config.asset.compression === 'gzip'
      ? gunzipSync(transferred, { maxOutputLength: config.asset.size })
      : transferred;
  if (bytes.length !== config.asset.size) {
    throw new Error(
      `[stitchkit] update is ${bytes.length} bytes, manifest says ${config.asset.size} — refusing to install it`,
    );
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== config.asset.sha256) {
    throw new Error(
      `[stitchkit] update digest ${sha256} does not match the manifest — refusing to install it`,
    );
  }

  const backup = config.backupPath ? keepReplacedBinary(target, config.backupPath) : undefined;
  writeFileAtomic(target, bytes, 0o755);
  return {
    path: target,
    bytes: bytes.length,
    sha256,
    ...(backup && { backupPath: backup.path, backupSha256: backup.sha256 }),
  };
}

/**
 * Copy the bytes about to be replaced, atomically and runnably.
 *
 * Nothing to copy is not a failure: on a first install there is no previous
 * build, and there is correspondingly nothing to roll back to.
 */
function keepReplacedBinary(
  target: string,
  backupPath: string,
): { path: string; sha256: string } | undefined {
  if (!existsSync(target)) return undefined;
  const previous = readFileSync(target);
  writeFileAtomic(backupPath, previous, statSync(target).mode & 0o777);
  return { path: backupPath, sha256: createHash('sha256').update(previous).digest('hex') };
}

export interface CliRollbackConfig {
  /** The file to restore onto; defaults to the running executable. */
  targetPath?: string;
  /** The copy kept by a previous `applyCliUpdate({ backupPath })`. */
  backupPath: string;
  /**
   * The digest the backup must have — `backupSha256` from that update.
   *
   * Required, not optional. A rollback that installs whatever happens to be at
   * the backup path is a second install of an unverified binary, and the moment
   * it is used is the moment nobody is in a position to check.
   */
  expectedSha256: string;
}

export interface RolledBackCliUpdate {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * Put the previous build back.
 *
 * Rolling back is a property of updating, not of the application: the same
 * attention to atomicity and file mode the replacement gets, applied in the
 * other direction. The digest is checked first, so a corrupted or swapped
 * backup is a refusal rather than an unbootable tool.
 */
export function rollbackCliUpdate(config: CliRollbackConfig): RolledBackCliUpdate {
  const target = config.targetPath ?? process.execPath;
  if (!existsSync(config.backupPath)) {
    throw new Error(`[stitchkit] rollback: no backup at ${config.backupPath}`);
  }
  const bytes = readFileSync(config.backupPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== config.expectedSha256) {
    throw new Error(
      `[stitchkit] rollback: backup digest ${sha256} does not match the expected ${config.expectedSha256} — refusing to restore it`,
    );
  }
  writeFileAtomic(target, bytes, statSync(config.backupPath).mode & 0o777);
  return { path: target, bytes: bytes.length, sha256 };
}
