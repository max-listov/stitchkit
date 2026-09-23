/**
 * Who built the binary — which the asset digest cannot answer.
 *
 * The digest proves the bytes that arrived are the bytes the manifest named. It
 * proves nothing about who named them: the manifest and the assets come from
 * one origin, and whoever can replace one can replace the other. Authorship
 * needs a key the build carries and the server never holds.
 *
 * So the signature covers the manifest's identity AND every asset's digest —
 * `{name, version, commit, builtAt, assets[]}` — and the chain closes on the
 * file that will execute rather than on the document describing it. Signing the
 * document alone would leave an attacker free to swap an asset URL's contents
 * and keep a valid signature over an unchanged document.
 *
 * Ed25519 over `node:crypto`; no dependency is added for this.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';
import { serializeCanonicalJson } from '../../internal/canonical-json';
import type { CliBuildManifest } from './manifest';

/** The detached signature a published manifest carries beside its own fields. */
export const CliBuildSignatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  /** Which key signed it — so a root can rotate without a flag day. */
  keyId: z.string().min(1),
  /** Base64 of the raw 64-byte Ed25519 signature. */
  signature: z.string().min(1),
});

export type CliBuildSignature = z.infer<typeof CliBuildSignatureSchema>;

/**
 * What a verification concluded. Five answers, and `unenforced` is the one that
 * earns its keep: a build with no pinned key must keep updating, and the fact
 * that nothing was checked has to be VISIBLE rather than assumed. A silent
 * "fine" from a check that never ran is the failure mode this whole file exists
 * to remove.
 */
export type CliSignatureVerdict =
  | 'valid'
  | 'unenforced'
  | 'missing'
  | 'unknown-key'
  | 'invalid';

/** The keys a build trusts, by id. A build with none enforces nothing. */
export interface CliTrustRoot {
  /**
   * `keyId` → public key, as SPKI PEM or base64 of the raw 32-byte Ed25519 key.
   * Compiled into the binary: a trust root fetched at runtime from the same
   * origin as the manifest proves nothing.
   */
  keys: Readonly<Record<string, string>>;
}

/**
 * The exact bytes a signature covers.
 *
 * Canonical JSON, so two producers that agree on the content agree on the
 * bytes — key order and whitespace are not allowed to decide whether a
 * signature verifies. Every asset contributes its target, its compression, its
 * size and its digest; `url` does not, because where a file is served from is
 * the publisher's business and moving it must not invalidate the proof of what
 * it contains. Everything that decides what happens to the bytes BEFORE the
 * digest can be checked is signed; only the address is free.
 */
export function cliManifestSigningPayload(manifest: CliBuildManifest): string {
  return serializeCanonicalJson({
    name: manifest.name,
    version: manifest.version,
    commit: manifest.commit,
    builtAt: manifest.builtAt,
    assets: manifest.assets.map((asset) => ({
      platform: asset.platform,
      arch: asset.arch,
      // `compression` is signed because it decides how the transferred bytes
      // are expanded, and expansion happens BEFORE the digest can be checked.
      // Left unsigned, one byte of the document turns a 300 KB download into a
      // 300 MB allocation with the signature still valid.
      compression: asset.compression,
      size: asset.size,
      sha256: asset.sha256,
    })),
  });
}

function publicKeyOf(material: string): KeyObject {
  const trimmed = material.trim();
  if (trimmed.includes('BEGIN PUBLIC KEY')) return createPublicKey(trimmed);
  // Raw 32-byte Ed25519 key, base64 — wrapped in the fixed SPKI prefix the
  // algorithm's DER encoding uses, so a publisher can pin the key without
  // carrying PEM armour through a config file.
  const raw = Buffer.from(trimmed, 'base64');
  if (raw.length !== 32) {
    throw new Error('[stitchkit] an Ed25519 public key is 32 bytes or SPKI PEM');
  }
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

/**
 * A private key as it comes out of a file or a secret store: PEM text, or DER
 * bytes.
 *
 * Deliberately not `KeyObject`. That type belongs to `node:crypto`, and naming
 * it in a published signature puts `import("node:crypto")` into the declaration
 * files of a package whose browser-safe entries a consumer resolves without
 * Node types at all — the whole surface stops typechecking for them over a
 * function they never call.
 */
export type CliSigningKey = string | Uint8Array;

/** Sign a manifest — for the publisher, which is the only side that holds a key. */
export function signCliManifest(
  manifest: CliBuildManifest,
  options: { keyId: string; privateKey: CliSigningKey },
): CliBuildSignature {
  const signature = cryptoSign(
    null,
    Buffer.from(cliManifestSigningPayload(manifest), 'utf8'),
    createPrivateKey(
      typeof options.privateKey === 'string'
        ? options.privateKey
        : { key: Buffer.from(options.privateKey), format: 'der', type: 'pkcs8' },
    ),
  );
  return {
    algorithm: 'ed25519',
    keyId: options.keyId,
    signature: signature.toString('base64'),
  };
}

/**
 * Verify a manifest against the build's own trust root.
 *
 * Never throws: a verdict is the answer, including for a malformed key or a
 * signature that is not base64 at all. A caller deciding whether to download
 * something wants a decision, not an exception to translate into one.
 */
export function verifyCliManifest(
  manifest: CliBuildManifest,
  signature: CliBuildSignature | undefined,
  trust?: CliTrustRoot,
): CliSignatureVerdict {
  const keys = trust?.keys;
  if (!keys || Object.keys(keys).length === 0) return 'unenforced';
  if (!signature) return 'missing';
  const material = Object.hasOwn(keys, signature.keyId) ? keys[signature.keyId] : undefined;
  if (material === undefined) return 'unknown-key';
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(cliManifestSigningPayload(manifest), 'utf8'),
      publicKeyOf(material),
      Buffer.from(signature.signature, 'base64'),
    );
    return ok ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Whether a verdict permits installing the build it describes. */
export function cliSignatureAccepted(verdict: CliSignatureVerdict): boolean {
  return verdict === 'valid' || verdict === 'unenforced';
}
