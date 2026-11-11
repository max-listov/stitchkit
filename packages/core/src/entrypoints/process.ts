/**
 * POSIX Node/Bun finite native commands, independent of the agent runtime, and contract
 * operations executed in one-call child processes on top of them.
 */

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
  type NativeCommandStopPolicy,
} from '../process/contract';
export {
  createOperationProcesses,
  type OperationCallContext,
  type OperationProcesses,
  type OperationProcessesConfig,
} from '../process/operation';
export {
  type OperationProcessIo,
  type OperationProcessService,
  runOperationProcess,
} from '../process/operation-child';
export {
  type NativeCommandStream,
  type NativeCommandStreamOptions,
  streamNativeCommand,
} from '../process/stream';
