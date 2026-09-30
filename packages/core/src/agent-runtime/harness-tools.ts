import type { ToolSet } from 'ai';
import type { ServiceDef } from '../server/types';
import { type AgentMountConfig, mountAgent } from '../tools/agent';
import { composeToolLifecycle } from '../tools/lifecycle';
import type { AgentRuntimeRunContext } from './runtime';

/** Full mount configuration, resolved from the validated context of each run. */
export interface AgentHarnessToolsConfig extends AgentMountConfig {
  services: ServiceDef | ServiceDef[];
}

/** Mount through the existing tool runner, always retaining the run's execution fence. */
export function createAgentHarnessTools<CONTEXT>(
  resolve: (
    run: AgentRuntimeRunContext<CONTEXT>,
  ) => AgentHarnessToolsConfig | Promise<AgentHarnessToolsConfig>,
): (run: AgentRuntimeRunContext<CONTEXT>) => Promise<ToolSet> {
  return async (run) => {
    const { services, lifecycle, ...config } = await resolve(run);
    return mountAgent(services, {
      ...config,
      lifecycle: composeToolLifecycle(lifecycle, run.toolFenceLifecycle),
    });
  };
}
