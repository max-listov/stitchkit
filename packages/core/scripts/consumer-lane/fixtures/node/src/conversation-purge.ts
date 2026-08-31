import {
  type AgentConversationPurgeDriver,
  type AgentConversationPurgeInput,
  type AgentConversationPurgeResult,
  type AgentRuntimeStore,
  purgeAgentConversation,
} from 'stitchkit/agent-runtime';

export function purge(
  store: AgentRuntimeStore,
  input: AgentConversationPurgeInput,
): Promise<AgentConversationPurgeResult> {
  return purgeAgentConversation(store, input);
}

export function driverCapability(
  driver: AgentConversationPurgeDriver<object>,
): AgentConversationPurgeDriver<object> {
  return driver;
}
