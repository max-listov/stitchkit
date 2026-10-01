import { startNativeCommand } from './command-owner';
import type { NativeCommandOptions, NativeCommandResult } from './contract';

export function runNativeCommand(input: NativeCommandOptions): Promise<NativeCommandResult> {
  return startNativeCommand(input).result;
}
