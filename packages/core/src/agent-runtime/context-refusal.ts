/**
 * A deliberate application-side refusal to start the next provider step
 * because its assembled context exceeds the selected model's budget.
 *
 * Throw this from `loop.prepareStep`. The runtime records
 * `context_overflow`; every other callback error remains a
 * `provider_failure` with its original internal diagnostic.
 */
export class AgentContextOverflowError extends Error {
  readonly name = 'AgentContextOverflowError';

  constructor(
    message = 'Agent context exceeds the configured model budget',
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
