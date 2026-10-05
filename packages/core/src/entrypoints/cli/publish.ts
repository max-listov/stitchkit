/**
 * `stitchkit/cli/publish` — publishing a CLI distribution. Evolving.
 *
 * `publishCli` writes a complete, verified version of an application's CLI binaries into a
 * local distribution directory and moves the public manifest last. It is release
 * infrastructure, so its shape follows how distributions are published and is not held to the
 * stable promise of `stitchkit/cli` (ADR 0245). The wire contract it writes — the manifest,
 * its signatures, the installer and the updater that read it — stays in `stitchkit/cli`.
 *
 * ```ts
 * import { publishCli } from 'stitchkit/cli/publish';
 * const result = await publishCli({ storageRoot, name, version, commit, baseUrl, targets, admit, build });
 * ```
 */

export {
  type CliPublicationOptions,
  type CliPublicationPhase,
  type CliPublicationResult,
  publishCli,
} from '../../tools/cli/publication';
