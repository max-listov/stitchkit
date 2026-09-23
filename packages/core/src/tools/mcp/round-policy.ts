import type { EndpointMcpInputRequired, EndpointMcpPolicy } from '../../contract/define';

/**
 * The declared rounds, when the declaration is a fixed list.
 *
 * A resolver has nothing to read at declaration time — that is the whole point
 * of it — so everything that inspects a policy statically (surface projection,
 * the surface fingerprint, mount-time validation) asks this first and treats
 * `undefined` as "known only per call".
 */
export function staticInputRounds(
  policy: EndpointMcpPolicy,
): readonly EndpointMcpInputRequired[] | undefined {
  return Array.isArray(policy.inputRequired) ? policy.inputRequired : undefined;
}

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
  const declared = staticInputRounds(policy);
  // A resolver is checked when it answers — `validateResolvedInputRounds` below.
  // There is nothing here to check and nothing to defer: refusing to mount a
  // tool because its questions are not knowable yet would refuse the feature.
  if (!declared) return;
  if (declared.length === 0) {
    throw new Error(
      `[stitchkit] MCP tool "${tool.name}" must declare at least one input round`,
    );
  }
  assertRoundShape(tool, declared, maxRounds);
}

/**
 * Validate what a resolver actually returned, on the call that returned it.
 *
 * The same two rules the static list is held to — unique keys, no more rounds
 * than the runtime allows — because a resolver can break both, and a policy
 * that is only checked when it happens to be written down is not checked.
 *
 * An empty list is legal here and only here: for a resolver it means "this call
 * needs nothing", which is the answer the feature exists to allow. Declaring
 * zero rounds statically still means the author wrote a policy that can never
 * ask anything, and that stays an error.
 */
export function validateResolvedInputRounds(
  tool: { name: string },
  resolved: readonly EndpointMcpInputRequired[],
  maxRounds: number,
): void {
  assertRoundShape(tool, resolved, maxRounds);
}

function assertRoundShape(
  tool: { name: string },
  rounds: readonly EndpointMcpInputRequired[],
  maxRounds: number,
): void {
  if (rounds.length > maxRounds) {
    throw new Error(
      `[stitchkit] MCP tool "${tool.name}" declares ${rounds.length} input rounds, exceeding maxRounds ${maxRounds}`,
    );
  }
  const keys = new Set<string>();
  for (const request of rounds) {
    if (keys.has(request.key)) {
      throw new Error(
        `[stitchkit] MCP tool "${tool.name}" declares duplicate input key "${request.key}"`,
      );
    }
    keys.add(request.key);
  }
}
