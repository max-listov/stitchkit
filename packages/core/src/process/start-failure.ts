import { NativeCommandError, type NativeCommandSettlement } from './contract';
import { commandCleanupError } from './group';

/** A failed native admission still owns one bounded external-resource settlement. */
export function failedCommandStart(
  cause: unknown,
  settle: (event: NativeCommandSettlement) => Promise<void>,
) {
  const error = new NativeCommandError('COMMAND_UNAVAILABLE', 'Command could not start', {
    cause,
  });
  const result = (async (): Promise<never> => {
    try {
      await settle({ kind: 'error', cause });
    } catch (cleanup) {
      throw commandCleanupError(
        new AggregateError([error, cleanup], 'Command failed and cleanup failed'),
      );
    }
    throw error;
  })();
  void result.catch(() => undefined);
  return {
    result,
    async stop() {
      await result.catch((failure) => {
        if (failure instanceof NativeCommandError && failure.code === 'COMMAND_CLEANUP')
          throw failure;
      });
    },
  };
}
