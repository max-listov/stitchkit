import {
  type TelegramOutboundBudgetConfig,
  telegramOutboundBudget,
} from '../../src/entrypoints/telegram';
import type { ManualClock } from '../../src/entrypoints/testing';

/** A Bot API-shaped refusal the classifier reads without prose guessing. */
export function refusal(error_code: number, description: string, retry_after?: number): Error {
  return Object.assign(new Error(description), {
    error_code,
    description,
    ...(retry_after !== undefined && { parameters: { retry_after } }),
  });
}

/** An abortable sleeper driven by the same manual clock the budget reads. */
export function sleepOn(clock: ManualClock) {
  return (milliseconds: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        timer.cancel();
        reject(signal?.reason);
      };
      const timer = clock.schedule(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** A budget for a token nobody else holds, paced by `clock`. */
export function manualBudget(
  clock: ManualClock,
  overrides: Partial<TelegramOutboundBudgetConfig> = {},
): {
  config: TelegramOutboundBudgetConfig;
  budget: ReturnType<typeof telegramOutboundBudget>;
} {
  const config: TelegramOutboundBudgetConfig = {
    token: `fixture-${crypto.randomUUID()}`,
    messagesPerSecond: 24,
    now: () => clock.now(),
    sleep: sleepOn(clock),
    ...overrides,
  };
  return { config, budget: telegramOutboundBudget(config) };
}
