/**
 * `stitchkit/cli` — the CLI transport entrypoint.
 *
 * `createCli` turns a `defineContract` into a command-line program, the fourth
 * surface alongside the HTTP API, MCP tools and agent tools. This entrypoint is
 * deliberately light: it pulls in neither the MCP SDK nor the `ai` package, so a
 * consumer can build a CLI binary without those optional peers.
 *
 * stitchkit ships no executable — write your own:
 *
 * ```ts
 * #!/usr/bin/env node
 * import { createCli } from 'stitchkit/cli';
 * await createCli({ name: 'myapp', version: '1.0.0', services: [...] });
 * ```
 *
 * and point your app's `package.json` `bin` at it.
 */
export { type CliConfig, type CliSurfaceSource, createCli } from './tools/cli';
export {
  CliArgumentError,
  type CliArgvRoute,
  type CliGlobalOptionsParse,
  type CliResultView,
  type CliRunOptions,
  extractCliGlobalOptions,
  type ParsedCliArgs,
  parseCliArgs,
  routeCliArgv,
} from './tools/cli-args';
export {
  type CliCommandContext,
  type CliCommandDefinition,
  type CliCommandDefinitionBase,
  type CliCommandDefinitionWithOutput,
  type CliCommandDefinitionWithoutOutput,
  defineCliCommand,
} from './tools/cli-command';
export {
  type CliWriters,
  DEFAULT_EXIT_CODES,
  type EmitOptions,
  type ExitCodeMap,
  emitResult,
} from './tools/cli-format';
export {
  type CliInstallerConfig,
  renderCliInstaller,
} from './tools/cli-installer';
export {
  assertCliPublishable,
  type CliBuildAsset,
  CliBuildAssetSchema,
  type CliBuildManifest,
  CliBuildManifestSchema,
  type CliBuildStamp,
  CliBuildStampSchema,
  type CliBuildTarget,
  CliBuildTargetSchema,
  currentCliBuildTarget,
  formatCliBuildStamp,
  selectCliBuildAsset,
} from './tools/cli-manifest';
export type { CliPresentationPolicyConfig } from './tools/cli-policy';
export {
  CliProfileError,
  type CliProfileStore,
  type CliProfileStoreConfig,
  createCliProfileStore,
  type ResolvedCliProfile,
} from './tools/cli-profile';
export {
  type CliBuildSignature,
  CliBuildSignatureSchema,
  type CliSignatureVerdict,
  type CliTrustRoot,
  cliManifestSigningPayload,
  cliSignatureAccepted,
  signCliManifest,
  verifyCliManifest,
} from './tools/cli-signature';
export {
  type AppliedCliUpdate,
  applyCliUpdate,
  type CliRollbackConfig,
  type CliUpdateApplyConfig,
  type CliUpdateCheck,
  type CliUpdateCheckConfig,
  checkCliUpdate,
  compareCliVersions,
  type RolledBackCliUpdate,
  rollbackCliUpdate,
} from './tools/cli-update';
export { type CliViewOutput, renderCliView } from './tools/cli-view';
export { type CliWaitConfig, type PollParams, pollUntilDone } from './tools/cli-wait';
/**
 * The second half of `parseCliArgs`. The parser leaves array and object values
 * as strings on purpose, because `executeToolMethod` runs this pass next; a
 * consumer that parses argv and then sends the call itself needs both halves,
 * and reaching for the `stitchkit/tools` barrel to get one function would pull
 * the MCP and AI peers into a binary this entrypoint keeps free of them.
 */
export { coerceJsonArgs } from './tools/coerce';
