import { AppError, STITCH_ERROR_STATUS } from '../../contract/errors';
import { type ToolFailure, toolResultFromError } from '../execute-result';
import { isReservedBoolWord, parseReservedBool, separateBoolValue } from './args-fields';
import { classifyLongOptionToken } from './args-route';

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

/**
 * Choose only the error's format, without admitting arguments of a command that
 * cannot run. Its availability refusal takes precedence over argument errors.
 * Reuse the framework's token/boolean vocabulary; after -- everything is data.
 */
export function unavailableCommandJson(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    if (token === undefined) continue;
    const option = classifyLongOptionToken(token);
    if (option?.name !== 'json') continue;
    return option.value === undefined
      ? (separateBoolValue(argv[i + 1]) ?? true)
      : isReservedBoolWord(option.value) && parseReservedBool('json', option.value);
  }
  return false;
}
