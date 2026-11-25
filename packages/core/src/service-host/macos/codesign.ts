import {
  CODESIGN_PATH,
  createDefaultMacosCommandRunner,
  type MacosCommandRunner,
  SECURITY_PATH,
} from './runner';

const DEVELOPER_ID_PREFIX = 'Developer ID Application:';
const DEVELOPER_ID_INTERMEDIATE_AUTHORITY = 'Developer ID Certification Authority';
const APPLE_ROOT_AUTHORITY = 'Apple Root CA';
const SHA1_PATTERN = /^[0-9A-Fa-f]{40}$/;
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const CDHASH_PATTERN = /^[0-9a-fA-F]{40,64}$/;
const HARDENED_RUNTIME_FLAG = 0x10000;
const IDENTITY_LINE_PATTERN = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"(.*)$/;
const TEAM_SUFFIX_PATTERN = /\(([A-Z0-9]{10})\)\s*$/;

/** Failure classifications thrown by {@link MacosCodesignError}. */
export type MacosCodesignErrorCode =
  | 'INVALID_IDENTITY'
  | 'NO_DEVELOPER_ID'
  | 'AMBIGUOUS_IDENTITY'
  | 'COMMAND_FAILED'
  | 'VERIFICATION_FAILED';

/** Structured error thrown by macOS code-signing and verification helpers. */
export class MacosCodesignError extends Error {
  constructor(
    readonly code: MacosCodesignErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MacosCodesignError';
  }
}

/** Valid `Developer ID Application` certificate discovered in a macOS keychain. */
export interface DeveloperIdIdentity {
  sha1: string;
  commonName: string;
  teamId: string | null;
}

/** Structured fields parsed from the `stderr` output of `codesign -dvvv`. */
export interface ParsedCodesignDetails {
  identifier: string | null;
  teamIdentifier: string | null;
  cdHash: string | null;
  signature: string | null;
  flags: string | null;
  hasHardenedRuntime: boolean;
  authorities: readonly string[];
}

/** Verified Developer ID signature metadata for a signed macOS `.app` bundle. */
export interface VerifiedBundleSignature {
  bundlePath: string;
  identifier: string;
  teamIdentifier: string;
  cdHash: string;
  authorities: readonly string[];
  hasHardenedRuntime: boolean;
}

/** Options for {@link findDeveloperIds}. */
export interface FindDeveloperIdsOptions {
  keychain?: string;
  timeoutMs?: number;
  runner?: MacosCommandRunner;
}

/** Options for {@link resolveSigningIdentity}. */
export interface ResolveSigningIdentityOptions extends FindDeveloperIdsOptions {
  /** Explicit Developer ID Application identity (common name or 40-hex SHA-1). */
  identity?: string | null;
}

/** Options for {@link verifySignedBundle}. */
export interface VerifySignedBundleOptions {
  bundlePath: string;
  expectedBundleId: string;
  expectedTeamId?: string;
  /** Require the hardened runtime flag (`0x10000(runtime)`) in `CodeDirectory` (default: `true`). */
  requireHardenedRuntime?: boolean;
  timeoutMs?: number;
  runner?: MacosCommandRunner;
}

/** Options for {@link signBundle}. */
export interface SignBundleOptions {
  bundlePath: string;
  /** Developer ID Application identity (never ad-hoc `'-'`). */
  identity: string;
  /** Enable hardened runtime (`--options runtime`, default: `true`). */
  hardenedRuntime?: boolean;
  /** Include Apple secure timestamp (`--timestamp`, default: `true`). */
  timestamp?: boolean;
  /** Pass `--deep` when signing nested helpers (default: `false`). */
  deep?: boolean;
  /** Optional path to an entitlements plist passed via `--entitlements`. */
  entitlementsPath?: string;
  timeoutMs?: number;
  runner?: MacosCommandRunner;
}

/**
 * Parse `/usr/bin/security find-identity -v -p codesigning` stdout, keeping
 * only valid `Developer ID Application:` identities without `CSSMERR_*` flags.
 */
export function parseDeveloperIdsOutput(stdout: string): DeveloperIdIdentity[] {
  const identities: DeveloperIdIdentity[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const match = IDENTITY_LINE_PATTERN.exec(rawLine.trimEnd());
    if (!match) continue;
    const sha1 = (match[1] ?? '').toUpperCase();
    const commonName = (match[2] ?? '').trim();
    const trailing = match[3] ?? '';
    if (trailing.includes('CSSMERR_') || commonName.includes('CSSMERR_')) continue;
    if (!commonName.startsWith(DEVELOPER_ID_PREFIX) || seen.has(sha1)) continue;
    seen.add(sha1);
    const teamMatch = TEAM_SUFFIX_PATTERN.exec(commonName);
    identities.push({ sha1, commonName, teamId: teamMatch?.[1] ?? null });
  }
  return identities;
}

/** Query valid `Developer ID Application` identities via `/usr/bin/security`. */
export async function findDeveloperIds(
  options?: FindDeveloperIdsOptions,
): Promise<DeveloperIdIdentity[]> {
  const runner = options?.runner ?? createDefaultMacosCommandRunner();
  const args = ['find-identity', '-v', '-p', 'codesigning'];
  if (options?.keychain !== undefined) {
    if (
      options.keychain.length === 0 ||
      options.keychain.startsWith('-') ||
      /[\0\r\n]/.test(options.keychain)
    ) {
      throw new MacosCodesignError('INVALID_IDENTITY', 'Invalid keychain path');
    }
    args.push(options.keychain);
  }
  const result = await runner.runCommand(SECURITY_PATH, args, {
    timeoutMs: options?.timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new MacosCodesignError(
      'COMMAND_FAILED',
      `security find-identity failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return parseDeveloperIdsOutput(result.stdout);
}

function failIdentity(message: string): never {
  throw new MacosCodesignError('INVALID_IDENTITY', message);
}

/**
 * Fail-closed resolution of a `Developer ID Application` signing identity.
 * Refuses `null`, empty/whitespace, ad-hoc `'-'`, `CSSMERR_*`, non-Developer-ID,
 * zero (`NO_DEVELOPER_ID`), and >1 (`AMBIGUOUS_IDENTITY`) certificates.
 */
export async function resolveSigningIdentity(
  options?: ResolveSigningIdentityOptions,
): Promise<string> {
  if (options?.identity !== undefined) {
    if (options.identity === null) {
      failIdentity('Signing identity must not be null; ad-hoc signing is forbidden');
    }
    const trimmed = options.identity.trim();
    if (trimmed.length === 0 || trimmed === '-') {
      failIdentity('Empty or ad-hoc ("-") signing identity is forbidden');
    }
    if (trimmed.includes('CSSMERR_') || /[\0\r\n]/.test(trimmed)) {
      failIdentity(`Rejected invalid or flagged signing identity: ${JSON.stringify(trimmed)}`);
    }
    if (SHA1_PATTERN.test(trimmed)) {
      const upper = trimmed.toUpperCase();
      const matched = (await findDeveloperIds(options)).find((entry) => entry.sha1 === upper);
      if (!matched) {
        failIdentity(
          `Signing certificate SHA-1 ${upper} is not a valid Developer ID Application identity`,
        );
      }
      return matched.sha1;
    }
    if (
      !trimmed.startsWith(DEVELOPER_ID_PREFIX) ||
      trimmed.slice(DEVELOPER_ID_PREFIX.length).trim().length === 0
    ) {
      failIdentity(
        `Signing identity must start with "${DEVELOPER_ID_PREFIX}" and name a subject (got ${JSON.stringify(trimmed)})`,
      );
    }
    return trimmed;
  }

  const identities = await findDeveloperIds(options);
  if (identities.length === 0) {
    throw new MacosCodesignError(
      'NO_DEVELOPER_ID',
      'No valid Developer ID Application certificate found in keychain',
    );
  }
  if (identities.length > 1) {
    const names = identities.map((entry) => `${entry.commonName} (${entry.sha1})`).join(', ');
    throw new MacosCodesignError(
      'AMBIGUOUS_IDENTITY',
      `Multiple Developer ID Application certificates found; specify identity explicitly: ${names}`,
    );
  }
  const single = identities[0];
  if (!single)
    throw new MacosCodesignError(
      'NO_DEVELOPER_ID',
      'No valid Developer ID Application certificate',
    );
  return single.commonName;
}

/** Parse `stderr` emitted by `/usr/bin/codesign -dvvv <path>`. */
export function parseCodesignDetails(stderr: string): ParsedCodesignDetails {
  let identifier: string | null = null;
  let teamIdentifier: string | null = null;
  let cdHash: string | null = null;
  let signature: string | null = null;
  let flags: string | null = null;
  let hasHardenedRuntime = false;
  const authorities: string[] = [];

  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('Identifier=')) identifier = line.slice('Identifier='.length).trim();
    else if (line.startsWith('TeamIdentifier='))
      teamIdentifier = line.slice('TeamIdentifier='.length).trim();
    else if (line.startsWith('CDHash='))
      cdHash = line.slice('CDHash='.length).trim().toLowerCase();
    else if (line.startsWith('Signature=')) signature = line.slice('Signature='.length).trim();
    else if (line.startsWith('Authority=')) {
      const authority = line.slice('Authority='.length).trim();
      if (authority.length > 0) authorities.push(authority);
    } else if (line.startsWith('CodeDirectory ')) {
      const flagMatch = /\bflags=(0x[0-9a-fA-F]+(?:\([^)]*\))?)/.exec(line);
      if (flagMatch?.[1] !== undefined) {
        flags = flagMatch[1];
        const hexMatch = /^0x([0-9a-fA-F]+)/.exec(flags);
        const numeric = hexMatch?.[1] !== undefined ? Number.parseInt(hexMatch[1], 16) : 0;
        hasHardenedRuntime =
          (numeric & HARDENED_RUNTIME_FLAG) !== 0 || /\([^)]*\bruntime\b[^)]*\)/.test(flags);
      }
    }
  }

  return {
    identifier,
    teamIdentifier,
    cdHash,
    signature,
    flags,
    hasHardenedRuntime,
    authorities,
  };
}

function failVerify(message: string): never {
  throw new MacosCodesignError('VERIFICATION_FAILED', message);
}

/**
 * The code requirement of a Developer ID Application signature of `teamId`: a chain
 * anchored in Apple's own root, the Developer ID intermediate marker
 * (`1.2.840.113635.100.6.2.6`), the Developer ID Application leaf marker
 * (`1.2.840.113635.100.6.1.13`) and the team in the leaf's subject. A forged chain
 * with Apple's names satisfies a string comparison of `Authority=` lines and its
 * own designated requirement, never this.
 */
function developerIdRequirement(teamId: string): string {
  if (!TEAM_ID_PATTERN.test(teamId))
    failVerify(`Invalid TeamIdentifier: ${JSON.stringify(teamId)}`);
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;
}

function assertValidAuthorityChain(authorities: readonly string[]): void {
  const leaf = authorities[0] ?? '';
  const intermediate = authorities[1] ?? '';
  const root = authorities[2] ?? '';
  if (
    authorities.length !== 3 ||
    !leaf.startsWith(DEVELOPER_ID_PREFIX) ||
    leaf.slice(DEVELOPER_ID_PREFIX.length).trim().length === 0 ||
    intermediate !== DEVELOPER_ID_INTERMEDIATE_AUTHORITY ||
    root !== APPLE_ROOT_AUTHORITY
  ) {
    failVerify(`Invalid Developer ID certificate chain: [${authorities.join(' -> ')}]`);
  }
}

/**
 * Strictly verify a signed macOS `.app` bundle via `codesign -dvvv` and
 * `codesign --verify --deep --strict` against {@link developerIdRequirement},
 * enforcing a Developer ID Application chain anchored in Apple's root, non-adhoc signature, 10-char `TeamIdentifier`, exact `Identifier`,
 * valid hex `CDHash`, and hardened runtime (default: `true`).
 */
export async function verifySignedBundle(
  options: VerifySignedBundleOptions,
): Promise<VerifiedBundleSignature> {
  if (!options.bundlePath.startsWith('/') || /[\0\r\n]/.test(options.bundlePath)) {
    failVerify(`Invalid bundlePath: ${JSON.stringify(options.bundlePath)}`);
  }
  const runner = options.runner ?? createDefaultMacosCommandRunner();
  const cmdOpts = { timeoutMs: options.timeoutMs };

  const displayResult = await runner.runCommand(
    CODESIGN_PATH,
    ['-dvvv', options.bundlePath],
    cmdOpts,
  );
  if (displayResult.exitCode !== 0) {
    failVerify(
      `codesign -dvvv failed for ${options.bundlePath} (exit ${displayResult.exitCode}): ${displayResult.stderr.trim()}`,
    );
  }

  const details = parseCodesignDetails(displayResult.stderr);
  if (details.signature?.toLowerCase() === 'adhoc') {
    failVerify(`Bundle ${options.bundlePath} has an ad-hoc signature`);
  }
  if (details.identifier !== options.expectedBundleId) {
    failVerify(
      `Bundle identifier mismatch for ${options.bundlePath}: expected ${options.expectedBundleId}, observed ${details.identifier ?? 'none'}`,
    );
  }
  if (
    details.teamIdentifier === null ||
    details.teamIdentifier === 'not set' ||
    !TEAM_ID_PATTERN.test(details.teamIdentifier)
  ) {
    failVerify(
      `Invalid or missing TeamIdentifier for ${options.bundlePath}: ${details.teamIdentifier ?? 'none'}`,
    );
  }
  if (
    options.expectedTeamId !== undefined &&
    details.teamIdentifier !== options.expectedTeamId
  ) {
    failVerify(
      `TeamIdentifier mismatch for ${options.bundlePath}: expected ${options.expectedTeamId}, observed ${details.teamIdentifier}`,
    );
  }
  if (details.cdHash === null || !CDHASH_PATTERN.test(details.cdHash)) {
    failVerify(
      `Missing or malformed CDHash for ${options.bundlePath}: ${details.cdHash ?? 'none'}`,
    );
  }
  assertValidAuthorityChain(details.authorities);
  if ((options.requireHardenedRuntime ?? true) && !details.hasHardenedRuntime) {
    failVerify(`Bundle ${options.bundlePath} is missing the hardened runtime flag`);
  }

  // The names above are text the signer chose; the requirement makes codesign
  // evaluate the certificates themselves against Apple's anchor.
  const verifyResult = await runner.runCommand(
    CODESIGN_PATH,
    [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      `-R=${developerIdRequirement(details.teamIdentifier)}`,
      options.bundlePath,
    ],
    cmdOpts,
  );
  if (verifyResult.exitCode !== 0) {
    failVerify(
      `codesign --verify failed for ${options.bundlePath} (exit ${verifyResult.exitCode}): ${verifyResult.stderr.trim()}`,
    );
  }

  return {
    bundlePath: options.bundlePath,
    identifier: details.identifier,
    teamIdentifier: details.teamIdentifier,
    cdHash: details.cdHash,
    authorities: details.authorities,
    hasHardenedRuntime: details.hasHardenedRuntime,
  };
}

/** Sign a macOS `.app` bundle with a validated `Developer ID Application` identity. */
export async function signBundle(options: SignBundleOptions): Promise<void> {
  if (!options.bundlePath.startsWith('/') || /[\0\r\n]/.test(options.bundlePath)) {
    throw new MacosCodesignError(
      'COMMAND_FAILED',
      `Invalid bundlePath: ${JSON.stringify(options.bundlePath)}`,
    );
  }
  const runner = options.runner ?? createDefaultMacosCommandRunner();
  const validatedIdentity = await resolveSigningIdentity({
    identity: options.identity,
    runner,
    timeoutMs: options.timeoutMs,
  });

  const args = ['--force', '--sign', validatedIdentity];
  if (options.hardenedRuntime ?? true) args.push('--options', 'runtime');
  if (options.timestamp ?? true) args.push('--timestamp');
  if (options.deep === true) args.push('--deep');
  if (options.entitlementsPath !== undefined) {
    if (
      !options.entitlementsPath.startsWith('/') ||
      /[\0\r\n]/.test(options.entitlementsPath)
    ) {
      throw new MacosCodesignError('COMMAND_FAILED', 'Invalid entitlementsPath');
    }
    args.push('--entitlements', options.entitlementsPath);
  }
  args.push(options.bundlePath);

  const result = await runner.runCommand(CODESIGN_PATH, args, {
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new MacosCodesignError(
      'COMMAND_FAILED',
      `codesign failed for ${options.bundlePath} (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}
