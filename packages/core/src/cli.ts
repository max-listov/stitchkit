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
export { type CliRunOptions, type ParsedCliArgs, parseCliArgs } from './tools/cli-args';
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
export { type CliWaitConfig, type PollParams, pollUntilDone } from './tools/cli-wait';
