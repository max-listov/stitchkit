import path from 'node:path';
import type { ComponentProps } from 'react';
import type {
  AgentRecoverableDescriptor,
  AgentRuntimeRecoveryDecision,
} from 'stitchkit/agent-runtime';
import { AgentTuiApp } from './App';
import type { AgentTuiConfig } from './config';
import { createFileAgentModelSelectionStore } from './config';
import { createAgentTuiController } from './controller';
import { createAgentTuiDiagnosticRecorder } from './diagnostics';
import {
  type AgentTuiSessionRequest,
  type AgentTuiSessionResponse,
  createAgentTuiConversationId,
  createAgentTuiSessionId,
  startAgentTuiSessionHost,
} from './session';
import { runTerminalApp } from './widgets/app';
import { useTerminalPalette } from './widgets/theme';

/** The agent shell in the palette `runTerminalApp` resolved for this terminal. */
function ThemedAgentTuiApp(props: Omit<ComponentProps<typeof AgentTuiApp>, 'theme'>) {
  return <AgentTuiApp {...props} theme={useTerminalPalette()} />;
}

function runtimeContext<CONTEXT>(config: AgentTuiConfig<CONTEXT>): Promise<CONTEXT> {
  return Promise.resolve(config.context());
}

export interface RunningAgentTui {
  sessionId: string;
  close(): Promise<void>;
}

export function defaultAgentTuiRecoveryDecision({
  run,
}: AgentRecoverableDescriptor): AgentRuntimeRecoveryDecision {
  return run.state === 'queued' ? { action: 'resume' } : { action: 'skip' };
}

export function resolveAgentTuiInitialConversationId(initialConversationId?: string): string {
  return initialConversationId ?? createAgentTuiConversationId();
}

/** Start the official terminal host around one headless runtime controller. */
export async function runAgentTui<CONTEXT>(
  config: AgentTuiConfig<CONTEXT>,
): Promise<RunningAgentTui> {
  const workspace = path.resolve(config.workspace ?? process.cwd());
  const sessionId = createAgentTuiSessionId();
  const initialConversationId = resolveAgentTuiInitialConversationId(
    config.initialConversationId,
  );
  const diagnostics = await createAgentTuiDiagnosticRecorder({ workspace, sessionId });
  const catalog = await config.modelCatalog.load();
  const selections = createFileAgentModelSelectionStore(workspace);
  const bundle = await config.createRuntime({ catalog, selections, diagnostics });
  await bundle.harness.recover({
    resolveContext: () => runtimeContext(config),
    decide: config.recover ?? defaultAgentTuiRecoveryDecision,
  });
  const controller = await createAgentTuiController({
    harness: bundle.harness,
    catalog,
    selections,
    conversationId: initialConversationId,
    context: () => runtimeContext(config),
    ...(config.preferredModelId && { preferredModelId: config.preferredModelId }),
    onDiagnostic: ({ conversationId, runId, event }) =>
      diagnostics.write({ conversationId, ...(runId && { runId }), event }),
  });
  const handle = async (request: AgentTuiSessionRequest): Promise<AgentTuiSessionResponse> => {
    try {
      if (request.operation === 'submit') {
        const runId = await controller.submit(request.text, request.idempotencyKey);
        diagnostics.record({
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          type: 'submission-admitted',
          sessionId,
          conversationId: controller.state().conversationId,
          runId,
          source: 'client',
        });
        return {
          requestId: request.requestId,
          outcome: 'ok',
          sessionId,
          conversationId: controller.state().conversationId,
          runId,
        };
      }
      if (request.operation === 'interrupt') await controller.interrupt(request.runId);
      const activeRunId = controller
        .state()
        .snapshot.runs.find(
          ({ state }) => state === 'running' || state === 'interrupt_requested',
        )?.id;
      return {
        requestId: request.requestId,
        outcome: 'ok',
        sessionId,
        conversationId: controller.state().conversationId,
        ...(activeRunId && { runId: activeRunId }),
      };
    } catch {
      diagnostics.record({
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        type: 'request-failed',
        sessionId,
        operation: request.operation,
      });
      return {
        requestId: request.requestId,
        outcome: 'error',
        error: {
          code: 'REQUEST_FAILED',
          message: 'The terminal host could not complete the request',
        },
      };
    }
  };
  const host = await startAgentTuiSessionHost({
    rootDirectory: workspace,
    conversationId: initialConversationId,
    sessionId,
    handle,
  });
  let hostConversationId = initialConversationId;
  diagnostics.record({
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    type: 'host-started',
    sessionId,
    conversationId: initialConversationId,
    launchMode: config.initialConversationId === undefined ? 'fresh' : 'explicit',
  });
  const closeHost = async (): Promise<void> => {
    try {
      diagnostics.record({
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        type: 'host-closed',
        sessionId,
        conversationId: controller.state().conversationId,
      });
      await host.close();
      await controller.close();
    } finally {
      await diagnostics.close();
    }
  };
  const app = await runTerminalApp(
    ({ close }) => (
      <ThemedAgentTuiApp
        controller={controller}
        catalog={catalog}
        {...(bundle.conversations && { conversations: bundle.conversations })}
        {...(config.commands && { commands: config.commands })}
        workspace={workspace}
        {...(config.statusLine !== undefined && { statusLine: config.statusLine })}
        sessionId={host.sessionId}
        title={config.title ?? 'Stitchkit agent'}
        onConversationChange={async (conversationId, reason) => {
          const previousConversationId = hostConversationId;
          await host.setConversationId(conversationId);
          hostConversationId = conversationId;
          diagnostics.record({
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            type: 'conversation-changed',
            sessionId,
            previousConversationId,
            conversationId,
            reason,
          });
        }}
        onExit={close}
      />
    ),
    {
      themeMode: config.themeMode ?? 'auto',
      ...(config.theme && { palette: config.theme }),
      onClose: closeHost,
    },
  );
  return { sessionId: host.sessionId, close: app.close };
}
