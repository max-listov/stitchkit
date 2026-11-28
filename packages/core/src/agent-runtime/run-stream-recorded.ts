import {
  type AgentGeneratedFile,
  type AgentGeneratedFileData,
  createAgentGeneratedFile,
} from '../agent-parts/model';
import type { AgentProviderEnvelope } from '../agent-parts/parts';
import type { AgentToolSet } from '../tools/agent-tools';
import { envelopeToProviderOptions } from './provider-media';
import type { RunExecution } from './run-execution-state';
import type { AgentLoopEvent } from './run-loop-events';
import { jsonValue } from './runtime-internals';
import { AgentMessagePartSchema } from './schemas';

function generatedFileFromPart(
  mediaType: string,
  data: AgentGeneratedFileData,
  provider: AgentProviderEnvelope | undefined,
  filename: string | undefined,
): AgentGeneratedFile {
  return createAgentGeneratedFile(
    mediaType,
    data,
    envelopeToProviderOptions(provider),
    filename,
  );
}

/** Parts that only add to the durable message: nothing is published for them. */
export async function applyRecordedPart<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  part: Extract<
    AgentLoopEvent,
    {
      type:
        | 'source'
        | 'file'
        | 'reasoning-file'
        | 'tool-approval-request'
        | 'tool-approval-response'
        | 'custom'
        | 'raw';
    }
  >,
): Promise<void> {
  const { config } = execution.dependencies;
  const { parts } = execution.state;
  if (part.type === 'source') {
    parts.push(AgentMessagePartSchema.parse(part.source));
  } else if (
    (part.type === 'file' || part.type === 'reasoning-file') &&
    config.persistGeneratedFile
  ) {
    const partFilename = part.type === 'file' ? part.filename : undefined;
    const file = generatedFileFromPart(part.mediaType, part.data, part.provider, partFilename);
    const persisted = await config.persistGeneratedFile(file);
    const filename = persisted.filename ?? partFilename;
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'file',
        mediaType: part.mediaType,
        reference: persisted.reference,
        ...(filename && { filename }),
      }),
    );
  } else if (part.type === 'file' || part.type === 'reasoning-file') {
    throw new Error(
      part.type === 'file'
        ? 'persistGeneratedFile is required for generated file output'
        : 'persistGeneratedFile is required for generated reasoning files',
    );
  } else if (part.type === 'tool-approval-request') {
    // Only interactive user approvals pause the step and suppress held pre-tool text;
    // automatic approvals proceed immediately to tool execution in the same step.
    if (part.isAutomatic !== true) {
      execution.state.stepGuard.toolFailed = true;
    }
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        callId: part.toolCall.toolCallId,
        ...(part.isAutomatic !== undefined && { isAutomatic: part.isAutomatic }),
        ...(part.signature && { signature: part.signature }),
      }),
    );
  } else if (part.type === 'tool-approval-response') {
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'tool-approval-response',
        approvalId: part.approvalId,
        approved: part.approved,
        ...(part.reason && { reason: part.reason }),
      }),
    );
  } else if (part.type === 'custom') {
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'provider',
        envelope: {
          schemaVersion: 1,
          provider: part.provider?.provider ?? 'custom',
          data: { kind: part.kind, ...(part.provider && { provider: part.provider.data }) },
        },
      }),
    );
  } else if (part.type === 'raw') {
    parts.push(
      AgentMessagePartSchema.parse({
        type: 'provider',
        envelope: {
          schemaVersion: 1,
          provider: 'raw',
          data: { value: jsonValue(part.rawValue) },
        },
      }),
    );
  }
}
