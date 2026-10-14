export const AGENT_RUNTIME_TERMS = [
  'agent-runtime',
  'AgentRun',
  'AgentMessage',
  'createAgentRuntime',
  'AgentRuntimeStore',
  'inputPolicy',
  'AgentUsage',
  'AgentHistory',
  // The coding tools ship from `stitchkit/agent-runtime/coding-tools` and a
  // consumer of them is a consumer of this surface. Left out, the table read
  // "most recently 0.83.0" in the release that redefined what BOTH of their
  // authorization callbacks are asked about — the same way the application row
  // read "stable" through a break, which is why its own list was widened.
  'createAgentCodingTools',
  'AgentCodingTool',
  // Why a run ended is this surface's vocabulary, and an application branches
  // on it. Left out, the table read "most recently 0.85.0" in the release that
  // split three failures out of `provider_failure` — the third time this list
  // was too narrow for the break it was meant to count.
  'AgentTerminalReason',
  // The conversation reader is this surface's read side, and an application
  // that shows a person their own history is a consumer of it. Left out, the
  // table read "most recently 0.86.0" in the release that made a message page
  // say which of its messages compaction removed — the fourth time this list
  // was too narrow for the break it was meant to count.
  'AgentConversationReader',
  'AgentConversationMessagePage',
];

/**
 * The application kernel's own vocabulary.
 *
 * A second evolving surface deserves the same evidence as the first: the row
 * that says "evolving" is a claim, and the reader deciding whether to build on
 * it should not have to reconstruct the cadence from the changelog by hand.
 */
export const APPLICATION_TERMS = [
  'stitchkit/application',
  'createApplication',
  'ManagedResource',
  'managedServerResource',
  'ApplicationConfig',
  'ManagedSchedule',
  'bindProcessSignals',
  'ApplicationSnapshot',
  // The entry is more than the kernel: its admission, credit and journal primitives are public
  // from the same entrypoint, and a consumer of one is a consumer of `stitchkit/application`.
  // Leaving them out let the table read "stable for five minors" in the very release that broke
  // one of them.
  'BoundedAdmission',
  'CreditWindow',
  'DiagnosticJournal',
];

/**
 * A surface that is genuinely stable still has to prove it.
 *
 * The row said "stable" in the release that broke it — the same failure the
 * comment above records for the application kernel, arriving by the other door:
 * there the term list was too narrow, here the surface carried no evidence at
 * all, so nothing could go stale and nothing could fail. One in twenty-eight is
 * a stable surface; the sentence is what keeps that a measurement rather than a
 * claim nobody rechecks.
 */
export const OBSERVABILITY_TERMS = [
  'stitchkit/observability',
  'createObservability',
  'ObservabilityDrainReport',
  'ObservabilitySinkStatus',
  'RequestEvent',
  'createBoundedLogger',
  'sanitizePayload',
  'wrapInRequestContext',
];
