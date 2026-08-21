import type { EndpointMcpPolicy } from '../contract';

/** Validate declarative multi-round policy without importing the optional MCP SDK. */
export function validateMcpRoundPolicy(
  tool: { name: string },
  policy: EndpointMcpPolicy,
  runtime?: { stateConfigured: boolean; maxRounds: number },
): void {
  if (!runtime?.stateConfigured) {
    throw new Error(
      `[stitchkit] MCP tool "${tool.name}" declares inputRequired but no multiRound.state key is configured`,
    );
  }
  const { maxRounds } = runtime;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error('[stitchkit] multiRound.serving.maxRounds must be a positive integer');
  }
  if (policy.inputRequired.length === 0) {
    throw new Error(
      `[stitchkit] MCP tool "${tool.name}" must declare at least one input round`,
    );
  }
  if (policy.inputRequired.length > maxRounds) {
    throw new Error(
      `[stitchkit] MCP tool "${tool.name}" declares ${policy.inputRequired.length} input rounds, exceeding maxRounds ${maxRounds}`,
    );
  }
  const keys = new Set<string>();
  for (const request of policy.inputRequired) {
    if (keys.has(request.key)) {
      throw new Error(
        `[stitchkit] MCP tool "${tool.name}" declares duplicate input key "${request.key}"`,
      );
    }
    keys.add(request.key);
  }
}
