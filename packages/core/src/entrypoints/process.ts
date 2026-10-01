/** POSIX Node/Bun finite native commands, independent of the agent runtime. */

export {
  observeProcessInstance,
  type ProcessInstance,
  type ProcessInstanceObservation,
  ProcessInstanceSchema,
  type ProcessOwnerEvidence,
  probeProcessOwner,
} from '../internal/process-instance';
export { runNativeCommand } from '../process/command';
export {
  NativeCommandError,
  type NativeCommandOptions,
  type NativeCommandResult,
  type NativeCommandSettlement,
} from '../process/contract';
