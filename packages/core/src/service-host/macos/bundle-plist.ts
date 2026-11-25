import { z } from 'zod';
import { serializeCanonicalJson } from '../../internal/canonical-json';
import { computeSha256Hex } from '../artifact-manifest';
import {
  renderPlistDocument,
  renderPlistKeyElement,
  renderPlistStringElement,
  renderPlistValue,
} from '../plist-xml';
import type { MacosIconSource } from './icon';

/** Custom `Info.plist` key storing the SHA-256 digest of the desired bundle specification. */
export const BUNDLE_SPEC_DIGEST_PLIST_KEY = 'StitchkitBundleSpecDigest';

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const SAFE_BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;
const MANAGED_INFO_PLIST_KEYS = new Set([
  'LSBackgroundOnly',
  'LSUIElement',
  'LSMinimumSystemVersion',
  'NSHighResolutionCapable',
  BUNDLE_SPEC_DIGEST_PLIST_KEY,
]);

/** Zod schema for rendering a macOS `.app` `Contents/Info.plist` document. */
export const MacosBundleInfoPlistConfigSchema = z
  .strictObject({
    bundleIdentifier: z.string().min(1),
    bundleName: z.string().min(1),
    displayName: z.string().min(1).optional(),
    executableName: z.string().min(1),
    bundleVersion: z.string().min(1).default('1'),
    shortVersionString: z.string().min(1).default('1.0.0'),
    iconFile: z.string().min(1).optional(),
    lsBackgroundOnly: z.boolean().default(true),
    lsUIElement: z.boolean().default(true),
    lsMinimumSystemVersion: z.string().min(1).default('13.0'),
    specDigest: z.string().regex(/^[0-9a-f]{64}$/),
    extraEntries: z
      .record(z.string(), z.union([z.string(), z.boolean(), z.number()]))
      .optional(),
  })
  .check((ctx) => {
    const value = ctx.value;
    if (!SAFE_BUNDLE_ID_PATTERN.test(value.bundleIdentifier)) {
      ctx.issues.push({
        code: 'custom',
        input: value.bundleIdentifier,
        path: ['bundleIdentifier'],
        message: 'bundleIdentifier must contain only ASCII letters, digits, dots, or hyphens',
      });
    }
    if (
      value.executableName === '.' ||
      value.executableName === '..' ||
      !SAFE_SEGMENT_PATTERN.test(value.executableName)
    ) {
      ctx.issues.push({
        code: 'custom',
        input: value.executableName,
        path: ['executableName'],
        message: 'executableName must be a single safe path segment',
      });
    }
    if (value.extraEntries !== undefined) {
      for (const key of Object.keys(value.extraEntries)) {
        if (key.startsWith('CFBundle') || MANAGED_INFO_PLIST_KEYS.has(key)) {
          ctx.issues.push({
            code: 'custom',
            input: value.extraEntries,
            path: ['extraEntries', key],
            message: `${key} is managed automatically and cannot be overridden via extraEntries`,
          });
        }
      }
    }
  });

/** Input configuration accepted by {@link renderBundleInfoPlist}. */
export type MacosBundleInfoPlistConfig = z.input<typeof MacosBundleInfoPlistConfigSchema>;

function plistEntry(key: string, value: string | boolean | number): string {
  const renderedKey = `    ${renderPlistKeyElement(key, key)}`;
  const renderedVal =
    typeof value === 'string'
      ? `    ${renderPlistStringElement(key, value)}`
      : renderPlistValue(key, value, { indent: 4 });
  return `${renderedKey}\n${renderedVal}`;
}

/**
 * Render a deterministic Apple XML 1.0 `Contents/Info.plist` for a signed
 * macOS `.app` launcher bundle, embedding `StitchkitBundleSpecDigest` so
 * idempotency checks detect specification drift.
 */
export function renderBundleInfoPlist(config: MacosBundleInfoPlistConfig): string {
  const parsed = MacosBundleInfoPlistConfigSchema.parse(config);
  const entries: string[] = [
    plistEntry('CFBundleDevelopmentRegion', 'en'),
    plistEntry('CFBundleExecutable', parsed.executableName),
    plistEntry('CFBundleIdentifier', parsed.bundleIdentifier),
    plistEntry('CFBundleInfoDictionaryVersion', '6.0'),
    plistEntry('CFBundleName', parsed.bundleName),
  ];

  if (parsed.displayName !== undefined) {
    entries.push(plistEntry('CFBundleDisplayName', parsed.displayName));
  }

  entries.push(
    plistEntry('CFBundlePackageType', 'APPL'),
    plistEntry('CFBundleShortVersionString', parsed.shortVersionString),
    plistEntry('CFBundleVersion', parsed.bundleVersion),
  );

  if (parsed.iconFile !== undefined) {
    entries.push(plistEntry('CFBundleIconFile', parsed.iconFile));
  }

  entries.push(
    plistEntry('LSBackgroundOnly', parsed.lsBackgroundOnly),
    plistEntry('LSUIElement', parsed.lsUIElement),
    plistEntry('LSMinimumSystemVersion', parsed.lsMinimumSystemVersion),
    plistEntry('NSHighResolutionCapable', true),
    plistEntry(BUNDLE_SPEC_DIGEST_PLIST_KEY, parsed.specDigest),
  );

  if (parsed.extraEntries !== undefined) {
    const keys = Object.keys(parsed.extraEntries).sort();
    for (const key of keys) {
      const value = parsed.extraEntries[key];
      if (value === undefined) continue;
      entries.push(plistEntry(key, value));
    }
  }

  return renderPlistDocument(entries);
}

/** Minimal bundle spec fields hashed into `StitchkitBundleSpecDigest`. */
export interface MacosBundleDigestInput {
  bundleIdentifier: string;
  bundleName: string;
  displayName?: string;
  executableName: string;
  bundleVersion?: string;
  shortVersionString?: string;
  lsBackgroundOnly?: boolean;
  lsUIElement?: boolean;
  lsMinimumSystemVersion?: string;
  requireHardenedRuntime?: boolean;
  entitlementsPath?: string;
  entitlementsSha256?: string | null;
  signingIdentity?: string | null;
  expectedTeamId?: string;
  arch?: 'arm64' | 'x86_64';
  extraInfoPlistEntries?: Record<string, string | boolean | number>;
  icon?: MacosIconSource;
}

function iconDigestInput(icon: MacosIconSource | undefined): unknown {
  if (icon === undefined) return null;
  if (icon.kind === 'svg') {
    return {
      kind: 'svg',
      sha256: computeSha256Hex(icon.svg),
      applySquircleFrame: icon.applySquircleFrame ?? true,
      backgroundColor: icon.backgroundColor ?? null,
    };
  }
  return {
    kind: icon.kind,
    sha256: computeSha256Hex(icon.bytes),
    applySquircleFrame: icon.kind === 'png' ? (icon.applySquircleFrame ?? false) : true,
    backgroundColor: icon.backgroundColor ?? null,
  };
}

/** Compute the deterministic SHA-256 specification digest stored in `Contents/Info.plist`. */
export function computeBundleSpecDigest(
  spec: MacosBundleDigestInput,
  launcherSource: string,
): string {
  return computeSha256Hex(
    serializeCanonicalJson({
      bundleIdentifier: spec.bundleIdentifier,
      bundleName: spec.bundleName,
      displayName: spec.displayName ?? null,
      executableName: spec.executableName,
      bundleVersion: spec.bundleVersion ?? '1',
      shortVersionString: spec.shortVersionString ?? '1.0.0',
      lsBackgroundOnly: spec.lsBackgroundOnly ?? true,
      lsUIElement: spec.lsUIElement ?? true,
      lsMinimumSystemVersion: spec.lsMinimumSystemVersion ?? '13.0',
      requireHardenedRuntime: spec.requireHardenedRuntime ?? true,
      entitlementsPath: spec.entitlementsPath ?? null,
      entitlementsSha256: spec.entitlementsSha256 ?? null,
      signingIdentity: spec.signingIdentity ?? null,
      expectedTeamId: spec.expectedTeamId ?? null,
      arch: spec.arch ?? null,
      extraInfoPlistEntries: spec.extraInfoPlistEntries ?? null,
      launcherSourceSha256: computeSha256Hex(launcherSource),
      icon: iconDigestInput(spec.icon),
    }),
  );
}
