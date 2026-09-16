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
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fetchGuarded, readCapped } from '../internal/secure-fetch';
import {
  type CliBuildAsset,
  type CliBuildManifest,
  CliBuildManifestSchema,
  type CliBuildTarget,
  currentCliBuildTarget,
  selectCliBuildAsset,
} from './cli-manifest';

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
}

/**
 * Four answers, never three. "Could not ask" is not "up to date": collapsing
 * them is how a tool goes quiet about its own staleness for months.
 */
export type CliUpdateCheck =
  | { status: 'skipped'; nextCheckAt: number }
  | { status: 'current'; version: string }
  | { status: 'outdated'; version: string; manifest: CliBuildManifest; asset?: CliBuildAsset }
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
    if (order >= 0) return { status: 'current', version: manifest.version };
    const asset = selectCliBuildAsset(manifest, config.target ?? currentCliBuildTarget());
    return {
      status: 'outdated',
      version: manifest.version,
      manifest,
      ...(asset && { asset }),
    };
  } catch (error) {
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
}

export interface AppliedCliUpdate {
  path: string;
  bytes: number;
  sha256: string;
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

  const bytes = config.asset.compression === 'gzip' ? gunzipSync(transferred) : transferred;
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

  // Beside the target, so the rename stays on one filesystem and is atomic.
  const staged = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}`);
  writeFileSync(staged, bytes, { mode: 0o755 });
  chmodSync(staged, 0o755);
  renameSync(staged, target);
  return { path: target, bytes: bytes.length, sha256 };
}
