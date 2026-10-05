// biome-ignore-all assist/source/organizeImports: Each compiler control must remain next to its export.
/**
 * CLI publication is its own evolving leaf (ADR 0245): `stitchkit/cli/publish` exports it with
 * strict peer-free declarations, and the stable `stitchkit/cli` entry does not.
 */
import {
  type CliPublicationOptions,
  type CliPublicationPhase,
  type CliPublicationResult,
  publishCli,
} from 'stitchkit/cli/publish';

const publish: (options: CliPublicationOptions) => Promise<CliPublicationResult> = publishCli;
const phase: CliPublicationPhase = 'promote';
void publish;
void phase;

// @ts-expect-error stitchkit/cli no longer exports publishCli; import it from stitchkit/cli/publish.
export { publishCli as stablePublishCli } from 'stitchkit/cli';
// @ts-expect-error stitchkit/cli no longer exports the publication options type.
export type { CliPublicationOptions as StablePublicationOptions } from 'stitchkit/cli';
