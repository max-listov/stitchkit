import { relative, sep } from 'node:path';
import type { AgentCodingToolConfig } from './coding-tool-contract';
import { codingRefusal } from './coding-tool-refusals';
import { createAgentCodingTools } from './coding-tools';
import type { AgentProcessSandbox, AgentSandboxRestriction } from './sandbox';
import { SandboxError, type SandboxHandle } from './sandbox-contract';
import { sandboxPath } from './sandbox-session';

export interface SandboxCodingBinding {
  /** Trusted host path; never expose this binding to a model. */
  root: string;
  adapter: AgentProcessSandbox;
  assertActive(): void;
}

export function sandboxCommandCwd(root: string, cwd: string) {
  const path = relative(root, cwd).split(sep).join('/');
  return sandboxPath(path || '.');
}

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
