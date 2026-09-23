import type { ToolTransport } from '../contract/define';
import type { EndpointToolAnnotations } from '../contract/tool-options';
import type { RuntimeToolIdentity } from './runtime-tool';

/** Pathless operation identity fields whose semantic method is owned by the factory. */
export type NativeToolIdentity = Pick<
  RuntimeToolIdentity,
  'serviceName' | 'action' | 'scope' | 'meta'
>;

/** Shared declaration fields for framework-managed generic native operations. */
export interface ManagedNativeToolConfig {
  name?: string;
  description: string;
  identity: NativeToolIdentity;
  /** Default: MCP and AGENT. CLI is always explicit opt-in. */
  transports?: readonly ToolTransport[];
  annotations?: EndpointToolAnnotations;
}

export function managedNativeIdentity(
  identity: NativeToolIdentity,
  method: RuntimeToolIdentity['method'],
): RuntimeToolIdentity {
  return { ...identity, method };
}
