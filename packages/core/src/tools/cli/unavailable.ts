import { AppError, STITCH_ERROR_STATUS } from '../../contract/errors';
import { type ToolFailure, toolResultFromError } from '../execute-result';

/** One refusal for direct dispatch and a known, unavailable --wait target. */
export function unavailableCommand(reason: string): ToolFailure {
  return toolResultFromError(
    new AppError('CLI_COMMAND_UNAVAILABLE', {
      message: reason,
      status: STITCH_ERROR_STATUS.CLI_COMMAND_UNAVAILABLE,
      retryable: false,
    }),
  );
}
