/**
 * The `stitchkit/agent-executor` family of the optional-peer matrix: every subpath runs with no
 * peer installed, and only the two Claude Agent SDK subpaths name the SDK's types.
 */
export function agentExecutorPeerCases({ featureSource, minimalPeers }) {
  return [
    {
      id: 'agent-executor',
      subpath: './agent-executor',
      fixture: 'minimal',
      installedPeers: minimalPeers,
      target: 'node',
      source: featureSource('stitchkit/agent-executor', 'projectExecutorDeltas'),
      runtimePeers: [],
      declarationPeers: [],
      execute: true,
    },
    {
      id: 'agent-executor-claude',
      subpath: './agent-executor/claude',
      fixture: 'minimal',
      installedPeers: minimalPeers,
      target: 'node',
      source: featureSource('stitchkit/agent-executor/claude', 'createClaudeCliDriver'),
      runtimePeers: [],
      declarationPeers: [],
      execute: true,
    },
    {
      id: 'agent-executor-acp',
      subpath: './agent-executor/acp',
      fixture: 'minimal',
      installedPeers: minimalPeers,
      target: 'node',
      source: featureSource('stitchkit/agent-executor/acp', 'createAcpDriver'),
      runtimePeers: [],
      declarationPeers: [],
      execute: true,
    },
    {
      // The leaf takes the SDK's `query` from the application: it runs without
      // the SDK installed, and only its declarations name the SDK's types.
      id: 'agent-executor-claude-sdk',
      subpath: './agent-executor/claude-sdk',
      fixture: 'minimal',
      installedPeers: minimalPeers,
      target: 'node',
      source: featureSource('stitchkit/agent-executor/claude-sdk', 'createClaudeSdkDriver'),
      runtimePeers: [],
      declarationPeers: ['@anthropic-ai/claude-agent-sdk'],
      execute: true,
    },
    {
      id: 'agent-executor-codex',
      subpath: './agent-executor/codex',
      fixture: 'minimal',
      installedPeers: minimalPeers,
      target: 'node',
      source: featureSource('stitchkit/agent-executor/codex', 'createCodexDriver'),
      runtimePeers: [],
      declarationPeers: [],
      execute: true,
    },
    {
      id: 'agent-executor-testing',
      subpath: './agent-executor/testing',
      fixture: 'minimal',
      installedPeers: minimalPeers,
      target: 'node',
      source: featureSource('stitchkit/agent-executor/testing', 'runAgentEngineConformance'),
      runtimePeers: [],
      declarationPeers: [],
      execute: true,
    },
    {
      // The fake `query` and the session stub are typed by the SDK they stand in for; they
      // run without it, and only this subpath's declarations name the SDK's types.
      id: 'agent-executor-testing-claude-sdk',
      subpath: './agent-executor/testing/claude-sdk',
      fixture: 'minimal',
      installedPeers: minimalPeers,
      target: 'node',
      source: featureSource(
        'stitchkit/agent-executor/testing/claude-sdk',
        'createFakeClaudeSdkQuery',
      ),
      runtimePeers: [],
      declarationPeers: ['@anthropic-ai/claude-agent-sdk'],
      execute: true,
    },
  ];
}
