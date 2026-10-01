/** POSIX Node/Bun finite native commands, independent of the agent runtime. */
export { runNativeCommand } from '../process/command';
export {
  NativeCommandError,
  type NativeCommandOptions,
  type NativeCommandResult,
} from '../process/contract';
