import type { AgentMessage, AgentRun, AgentRunMetrics, AgentTerminalReason } from './schemas';

/** What one completed run reports back to whoever submitted it. */
export interface AgentRuntimeResult {
  run: AgentRun;
  message: AgentMessage;
  reason: AgentTerminalReason;
  snapshotVersion: number;
  policyName?: string;
  metrics?: AgentRunMetrics;
}
