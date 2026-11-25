import type { AgentCodingToolConfig } from './coding-tool-contract';
import { codingRefusal } from './coding-tool-refusals';
import { createAgentCodingTools } from './coding-tools';
import type { AgentSandboxRestriction } from './sandbox';
import { SandboxError, type SandboxHandle } from './sandbox-contract';

/** Compose the maintained coding profile, preserving authorization, artifacts and limits. */
export function createSandboxCodingTools(
  handle: SandboxHandle,
  config: Omit<AgentCodingToolConfig, 'root' | 'sandbox'> & {
    requiredRestrictions?: readonly AgentSandboxRestriction[];
  },
) {
  const binding = handle.coding;
  if (!binding)
    throw new SandboxError(
      'SANDBOX_UNAVAILABLE',
      'Backend does not expose a host coding workspace',
    );
  binding.assertActive();
  const assertToolActive = () => {
    try {
      binding.assertActive();
    } catch (error) {
      if (error instanceof SandboxError)
        codingRefusal('SANDBOX_UNAVAILABLE', 'Sandbox session cannot execute this operation', {
          details: { reason: error.code },
        });
      throw error;
    }
  };
  const { requiredRestrictions, ...options } = config;
  return createAgentCodingTools({
    ...options,
    root: binding.root,
    sandbox: {
      adapter: binding.adapter,
      required: requiredRestrictions ?? [
        'write-contained',
        'process-contained',
        'secrets-hidden',
      ],
    },
    authorize(input) {
      assertToolActive();
      return options.authorize(input);
    },
    authorizePath(input) {
      assertToolActive();
      return options.authorizePath?.(input) ?? true;
    },
  });
}
