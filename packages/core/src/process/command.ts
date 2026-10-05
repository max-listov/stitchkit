import { startNativeCommand } from './command-owner';
import type { NativeCommandOptions, NativeCommandResult } from './contract';

/**
 * Runs one finite command directly (no shell) and resolves once it exits and its output
 * closes; always bound it with a signal or a timeout.
 */
export function runNativeCommand(input: NativeCommandOptions): Promise<NativeCommandResult> {
  return startNativeCommand(input).result;
}
