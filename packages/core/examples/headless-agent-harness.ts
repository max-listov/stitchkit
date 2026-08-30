/**
 * The reusable composition is a published entrypoint. This example keeps the
 * shortest discoverable import without owning a second implementation.
 */

export type {
  AgentHarnessLimits,
  AgentHarnessProfileEvent,
  AgentHarnessResource,
  AgentHarnessResourceDiagnostic,
  AgentHarnessResourceKind,
  AgentHarnessResourceResult,
  HeadlessAgentHarness,
  HeadlessAgentHarnessConfig,
  HeadlessAgentModelResolver,
} from 'stitchkit/agent-runtime/harness';
export {
  AgentHarnessLimitsSchema,
  AgentHarnessProfileEventSchema,
  AgentHarnessResourceDiagnosticSchema,
  AgentHarnessResourceKindSchema,
  AgentHarnessResourceSchema,
  createHeadlessAgentHarness,
} from 'stitchkit/agent-runtime/harness';
