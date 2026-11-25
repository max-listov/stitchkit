import { expect } from 'bun:test';

/** The refusal of the one timer rule (`assertTimerMs`): the option's name and the value it received. */
export function timerRefusal(option: string, value: number, min: 0 | 1 = 1): RangeError {
  return new RangeError(
    `${option} must be an integer from ${min} to 2147483647 milliseconds, received ${value}`,
  );
}

/**
 * Assert that `run` throws the timer rule's refusal. Bun's `toThrow(error)` compares only the
 * message, so the class is checked on its own: a `TypeError` with the same text is a failure.
 */
export function expectTimerRefusal(
  run: () => unknown,
  option: string,
  value: number,
  min: 0 | 1 = 1,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RangeError);
  expect(thrown).toMatchObject({ message: timerRefusal(option, value, min).message });
}

/** {@link expectTimerRefusal} for a call that refuses by rejecting. */
export async function expectTimerRejection(
  pending: Promise<unknown>,
  option: string,
  value: number,
  min: 0 | 1 = 1,
): Promise<void> {
  const thrown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(RangeError);
  expect(thrown).toMatchObject({ message: timerRefusal(option, value, min).message });
}
