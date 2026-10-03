import { NativeCommandError } from './contract';

/** A failed native admission still owns one bounded external-resource settlement. */
export async function failedCommandStart(
  cause: unknown,
  cleanup: (error: NativeCommandError) => Promise<void>,
): Promise<never> {
  const error = new NativeCommandError('COMMAND_UNAVAILABLE', 'Command could not start', {
    cause,
  });
  await cleanup(error);
  throw error;
}
