const AGENT_TOOL_ERROR_BRAND = Symbol.for('stitchkit.AgentToolError');

/**
 * A mounted tool failed with a model-safe, transport-shaped error envelope.
 *
 * The AI SDK must observe a throw so it emits `tool-error`; returning this
 * envelope would incorrectly mark the call successful. The original cause is
 * retained for local observability while `message` contains only the safe
 * envelope that may be sent to the model provider.
 */
export class AgentToolError extends Error {
  public readonly output: Record<string, unknown>;

  constructor(output: Record<string, unknown>, cause?: unknown) {
    let message = 'Tool execution failed';
    try {
      message = JSON.stringify(output);
    } catch {
      // Non-JSON application details never cross the provider boundary.
    }
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AgentToolError';
    this.output = output;
    Object.defineProperty(this, AGENT_TOOL_ERROR_BRAND, { value: true });
  }
}

export function isAgentToolError(value: unknown): value is AgentToolError {
  return typeof value === 'object' && value !== null && AGENT_TOOL_ERROR_BRAND in value;
}
