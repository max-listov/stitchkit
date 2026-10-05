import { NativeCommandError, type NativeCommandResult } from './contract';
import { commandCleanupError, waitForCommandClose } from './group';

/** The abort reason of `stop()`, matched by type rather than by its message. */
export class CommandStopped extends DOMException {
  constructor() {
    super('Command stopped', 'AbortError');
  }
}

/** Admission sees the same owner before transport setup and through terminal cleanup. */
export function createCommandLifetime(input: {
  result: Promise<NativeCommandResult>;
  controller: AbortController;
  finished: () => boolean;
  signal: () => Promise<void>;
  cleanupTimeoutMs: number;
}) {
  const acceptSettlement = (error: unknown) => {
    if (error instanceof NativeCommandError && error.code === 'COMMAND_CLEANUP') throw error;
  };
  return {
    result: input.result,
    async terminate() {
      let refused = false;
      let refusal: unknown;
      if (!input.finished()) {
        try {
          await input.signal();
        } catch (error) {
          refused = true;
          refusal = error;
          input.controller.abort(error);
        }
        try {
          await waitForCommandClose(input.result, input.cleanupTimeoutMs);
        } catch (error) {
          if (!input.finished()) input.controller.abort(error);
        }
      }
      await input.result.then(() => undefined, acceptSettlement);
      if (refused) throw commandCleanupError(refusal);
    },
    async stop() {
      if (!input.finished()) input.controller.abort(new CommandStopped());
      await input.result.then(() => undefined, acceptSettlement);
    },
  };
}
