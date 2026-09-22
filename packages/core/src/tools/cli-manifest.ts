/**
 * The build manifest a CLI is distributed by — one schema, so the publisher,
 * the server and the installed binary cannot disagree about it.
 *
 * Everything here is Zod and arithmetic: no filesystem, no network. The half
 * that downloads lives in `cli-update.ts`, the half that writes shell in
 * `cli-installer.ts`, and both read these shapes.
 */
import { z } from 'zod';
import { CliBuildSignatureSchema } from './cli-signature';

/** What a build runs on. The values are Node's own, so a CLI can name its own. */
export const CliBuildTargetSchema = z.object({
  platform: z.string().min(1),
  arch: z.string().min(1),
});

export type CliBuildTarget = z.infer<typeof CliBuildTargetSchema>;

/**
 * One downloadable build.
 *
 * `size` and `sha256` describe the **decompressed** bytes — what will actually
 * be executed. A digest over the transferred archive proves the transfer and
 * says nothing about the file that ends up on the PATH, which is the one the
 * user runs.
 */
export const CliBuildAssetSchema = CliBuildTargetSchema.extend({
  url: z.url(),
  compression: z.enum(['gzip', 'none']).default('none'),
  size: z.int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
});

export type CliBuildAsset = z.infer<typeof CliBuildAssetSchema>;

/**
 * The document a CLI's distribution endpoint serves.
 *
 * `commit` and `builtAt` are here, not only inside the binary, because the
 * question "is what I am running the build this version means" is asked from
 * both sides.
 */
export const CliBuildManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  commit: z.string().min(1),
  builtAt: z.iso.datetime(),
  assets: z.array(CliBuildAssetSchema),
  /**
   * Detached proof of who built this, when the publisher signs.
   *
   * It has to be declared here rather than read beside the schema, because an
   * ordinary `z.object` strips what it does not know: a signature published in
   * this very document reached nobody, and a signed install had to fetch the
   * manifest a second time and parse it twice to see its own signature.
   */
  signature: CliBuildSignatureSchema.optional(),
});

export type CliBuildManifest = z.infer<typeof CliBuildManifestSchema>;

/** The stamp a build carries inside itself, so the tool can say what it is. */
export const CliBuildStampSchema = z.object({
  version: z.string().min(1),
  commit: z.string().min(1),
  builtAt: z.iso.datetime(),
});

export type CliBuildStamp = z.infer<typeof CliBuildStampSchema>;

/** One line a `--version` can print: what it is, not what the reader infers. */
export function formatCliBuildStamp(stamp: CliBuildStamp, name?: string): string {
  const prefix = name ? `${name} ` : '';
  return `${prefix}${stamp.version} (${stamp.commit.slice(0, 12)}, built ${stamp.builtAt})`;
}

/** The target the running process is on, in the manifest's own vocabulary. */
export function currentCliBuildTarget(): CliBuildTarget {
  return { platform: process.platform, arch: process.arch };
}

/** The asset for one target, or `undefined` when this build was not published. */
export function selectCliBuildAsset(
  manifest: CliBuildManifest,
  target: CliBuildTarget = currentCliBuildTarget(),
): CliBuildAsset | undefined {
  return manifest.assets.find(
    (asset) => asset.platform === target.platform && asset.arch === target.arch,
  );
}

/**
 * Refuse republishing a version from a different commit.
 *
 * A version is a promise about contents. Publishing `1.4.2` twice from two trees
 * means everyone who already installed `1.4.2` is told they are current and
 * never receives the fix — and nothing about their machine looks wrong. The
 * check is one comparison and belongs in the publisher, before the upload.
 */
function isManifestList(
  value: CliBuildManifest | readonly CliBuildManifest[],
): value is readonly CliBuildManifest[] {
  return Array.isArray(value);
}

export function assertCliPublishable(
  previous: CliBuildManifest | readonly CliBuildManifest[] | undefined,
  next: CliBuildManifest,
): void {
  // A list, not one document, because the promise a version makes does not stop
  // at a channel boundary. With two release tracks a publisher calls this with
  // the manifest of the track being published and gets silence: `1.2.3` went to
  // beta from one commit and goes to stable from another, and the only thing
  // that notices is the person who installed the beta, is told they are
  // current, and never receives the stable build. Nothing on their machine
  // looks wrong.
  const published: readonly CliBuildManifest[] =
    previous === undefined ? [] : isManifestList(previous) ? previous : [previous];
  for (const candidate of published) {
    if (candidate.version !== next.version) continue;
    if (candidate.commit === next.commit) continue;
    throw new Error(
      `[stitchkit] ${next.name} ${next.version} was already published from commit ${candidate.commit}; ` +
        `refusing to republish it from ${next.commit} — bump the version instead`,
    );
  }
}
