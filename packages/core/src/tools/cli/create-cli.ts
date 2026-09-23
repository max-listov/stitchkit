/**
 * The CLI transport — the fourth surface a `defineContract` drives, alongside
 * HTTP, MCP and agent tools. `createCli` turns contract services into a
 * command-line program: `<app> <command> [positional] [--flags]`, one command
 * per contract tool exposed on `'CLI'`.
 *
 * It is a peer of `mountMcp` / `mountAgent`, not a wrapper around the HTTP
 * client: a command runs through the very same `executeToolMethod` pipeline —
 * the same validation, the same `lifecycle.beforeHandle` auth gate, the same
 * error model — so a CLI call accepts and rejects exactly as the other
 * transports do (ADR 0014 parity). The CLI-unique parts live around that core:
 * argv parsing (`cli-args`), stdout/exit formatting (`cli-format`) and `--wait`
 * polling (`cli-wait`).
 *
 * Exposure is opt-in: a method appears as a command only when its contract
 * `expose` lists `'CLI'` (the default `['MCP','AGENT']` keeps it off the CLI).
 *
 * stitchkit ships no binary — `createCli` is the building block. A consuming app
 * writes the executable (`#!/usr/bin/env node` → `createCli({ … })`) and the
 * `bin` entry in its own `package.json`.
 */
import type { ZodObject } from 'zod';
import type { CliConfig } from './config';
import {
  type CliInvocationResult,
  type CliInvoker,
  type CliInvokerCommand,
  type CliInvokerConfig,
  type CliSurfaceSource,
  cliInvocationResult,
  createCliInvoker,
} from './invoke';
import { createCliIo } from './io';
import { runManagedInvocation } from './run-managed';
import { runNativeCommand } from './run-native';
import { createCliSession, resolveCliRoute } from './session';

export type {
  CliConfig,
  CliInvocationResult,
  CliInvoker,
  CliInvokerCommand,
  CliInvokerConfig,
  CliSurfaceSource,
};
export { cliInvocationResult, createCliInvoker };

/**
 * Build and run one mixed contract/runtime/native CLI surface, then exit.
 *
 * The phases run in a fixed order and each ends the invocation when it answers:
 * startup (`createCliSession`, where configuration faults throw), routing and
 * `--version`, native commands (before any identity is resolved), then the
 * managed surface — the top-level listing or one managed command.
 */
export async function createCli<
  TAuth = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TGlobals extends ZodObject = ZodObject,
>(config: CliConfig<TAuth, TContext, TGlobals>): Promise<void> {
  const io = createCliIo(config);
  const argv = config.argv ?? process.argv.slice(2);
  if (config.auth !== undefined && config.resolveAuth !== undefined) {
    throw new Error('[stitchkit] createCli: use either auth or resolveAuth, not both');
  }
  const session = createCliSession(config, io);

  const route = resolveCliRoute(session, argv);
  if (route === undefined) return;

  const { command } = route;
  const native = command === undefined ? undefined : session.nativeCommands.get(command);
  if (native && command !== undefined) {
    return runNativeCommand(session, route, command, native);
  }
  return runManagedInvocation(session, route);
}
