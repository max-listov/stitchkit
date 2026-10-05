import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { MAX_TIMER_MS } from '../../internal/timers';
import {
  CliBuildManifestSchema,
  type CliBuildStamp,
  type CliBuildTarget,
  CliBuildTargetSchema,
} from './manifest';
import type { CliSigningKey, CliTrustRoot } from './signature';

const positive = z.int().positive().max(Number.MAX_SAFE_INTEGER);
const timer = positive.max(MAX_TIMER_MS);
const component = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const PublicationTargetSchema = CliBuildTargetSchema.extend({
  platform: component,
  arch: component,
});
export const PublicationVersionSchema = z
  .string()
  .max(128)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/,
  )
  .refine((value) => {
    const core = value.split(/[+-]/)[0];
    if (!core || core.split('.').some((part) => !Number.isSafeInteger(Number(part))))
      return false;
    const prerelease = value.split('+')[0]?.split('-').slice(1).join('-');
    return (
      !prerelease ||
      prerelease
        .split('.')
        .every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'))
    );
  }, 'version must use finite canonical semver numbers');
const limitsSchema = z.object({
  maxTargets: positive.default(16),
  maxManifestBytes: positive.default(256 * 1024),
  maxAssetBytes: positive.default(256 * 1024 * 1024),
  maxCompressedBytes: positive.default(256 * 1024 * 1024),
  maxDirectoryEntries: positive.default(128),
  maxStoredVersions: positive.min(3).default(16),
  lockTimeoutMs: timer.default(10_000),
  timeoutMs: timer.default(600_000),
});
const dataSchema = CliBuildManifestSchema.pick({
  name: true,
  version: true,
  commit: true,
}).extend({
  name: component,
  version: PublicationVersionSchema,
  commit: z.string().min(1).max(128),
  storageRoot: z.string().min(1).refine(isAbsolute, 'storageRoot must be absolute'),
  baseUrl: z.url().refine((raw) => {
    const url = new URL(raw);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, 'baseUrl must be an http(s) directory URL without credentials/query/fragment'),
  targets: z.array(PublicationTargetSchema).min(1),
  limits: limitsSchema.prefault({}),
  retention: positive.min(2).default(2),
});
const phaseSchema = z.enum(['prepare', 'build', 'commit', 'promote']);
/**
 * Step of `publishCli` that the app's `admit` callback is called for: `prepare`, `build`,
 * `commit` or `promote`.
 */
export type CliPublicationPhase = z.infer<typeof phaseSchema>;
/**
 * Input to `publishCli`: identity, storage root, base URL and targets, plus `build` (bytes per
 * target) and `admit` (checked before every phase).
 */
export type CliPublicationOptions = Omit<z.input<typeof dataSchema>, 'limits' | 'targets'> & {
  targets: readonly CliBuildTarget[];
  limits?: z.input<typeof limitsSchema>;
  /** App-owned admission must validate the same source snapshot on every phase. */
  admit(input: {
    phase: CliPublicationPhase;
    identity: Readonly<Pick<z.infer<typeof dataSchema>, 'name' | 'version' | 'commit'>>;
    signal: AbortSignal;
  }): void | Promise<void>;
  /** The helper owns paths. Builders receive one common immutable stamp. */
  build(input: {
    target: Readonly<CliBuildTarget>;
    stamp: Readonly<CliBuildStamp>;
    signal: AbortSignal;
  }):
    | Uint8Array
    | ReadableStream<Uint8Array>
    | Promise<Uint8Array | ReadableStream<Uint8Array>>;
  signal?: AbortSignal;
  signing?: { keyId: string; privateKey: CliSigningKey };
  trust?: CliTrustRoot;
};
export type PublicationData = z.infer<typeof dataSchema>;

export function publicationData(options: CliPublicationOptions): PublicationData {
  const data = dataSchema.parse(options);
  if (data.targets.length > data.limits.maxTargets)
    throw new RangeError('CLI publication target cap exceeded');
  if (data.targets.length + 1 > data.limits.maxDirectoryEntries)
    throw new RangeError('CLI version layout exceeds directory entry cap');
  if (data.retention >= data.limits.maxStoredVersions)
    throw new RangeError('retention must leave one recovery slot below maxStoredVersions');
  const names = data.targets.map((target) => assetFilename(data.name, target));
  if (new Set(names).size !== names.length)
    throw new TypeError('CLI publication targets must be unique');
  if (typeof options.admit !== 'function' || typeof options.build !== 'function')
    throw new TypeError('CLI publication needs build and admit callbacks');
  return data;
}

export function assetFilename(name: string, target: CliBuildTarget): string {
  return `${name}-${target.platform}-${target.arch}.gz`;
}

export function assetUrl(baseUrl: string, version: string, filename: string): string {
  return new URL(
    `${encodeURIComponent(version)}/${encodeURIComponent(filename)}`,
    `${baseUrl.replace(/\/+$/, '')}/`,
  ).toString();
}
