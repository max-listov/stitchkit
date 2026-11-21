import { z } from 'zod';
import type { BranchIdentities } from './branch-identities';
import { ShellOutputSchema } from './coding-tool-contract';
import { AGENT_CODING_TOOL_NAMES } from './coding-tools';
import type { AgentMessage, AgentMessagePart, AgentRun } from './schemas';

/**
 * Application JSON is data, never an undocumented runtime reference codec.
 *
 * A key named like a runtime reference refuses the branch: the value cannot be
 * rekeyed, and carried as it is it would name the source. A host that uses such
 * a name for data of its own declares the key in `applicationKeys`; even then a
 * value that names an identity of the source conversation refuses.
 */
export function branchOpaqueJson(
  ids: BranchIdentities,
  value: z.infer<ReturnType<typeof z.json>>,
): typeof value {
  if (Array.isArray(value)) return value.map((entry) => branchOpaqueJson(ids, entry));
  if (value !== null && typeof value === 'object') {
    for (const key of [
      'reference',
      'conversationId',
      'runId',
      'messageId',
      'callId',
      'toolCallId',
      'approvalId',
      'operationId',
      'artifactId',
    ]) {
      if (!(key in value)) continue;
      const entry = value[key];
      if (!ids.isApplicationKey(key))
        throw new TypeError(
          `Branch cannot rekey an opaque payload containing ${key}; declare it in applicationKeys if it is application data`,
        );
      if (typeof entry === 'string' && ids.isSourceIdentity(entry))
        throw new TypeError(
          `Branch cannot carry a source identity under the application key ${key}`,
        );
    }
    for (const entry of Object.values(value)) branchOpaqueJson(ids, entry);
  }
  return value;
}

const ArtifactReadSchema = z
  .object({
    reference: z.string(),
    offset: z.int().nonnegative(),
    maxBytes: z.int().positive().optional(),
  })
  .strict();
const ArtifactSearchSchema = z
  .object({
    reference: z.string(),
    query: z.string(),
    maxMatches: z.int().positive().optional(),
  })
  .strict();
const ArtifactReadResultSchema = z
  .object({
    reference: z.string(),
    offset: z.int().nonnegative(),
    text: z.string(),
    bytes: z.int().nonnegative(),
    totalBytes: z.int().nonnegative().optional(),
  })
  .strict();
const ArtifactSearchResultSchema = z
  .object({
    reference: z.string(),
    matches: z.array(z.object({ line: z.int().positive(), text: z.string() }).strict()),
  })
  .strict();

export function branchToolJson(
  ids: BranchIdentities,
  name: string,
  value: z.infer<ReturnType<typeof z.json>>,
  output: boolean,
) {
  if (
    name === AGENT_CODING_TOOL_NAMES.readOutput ||
    name === AGENT_CODING_TOOL_NAMES.searchOutput
  ) {
    const parsed = output
      ? name === AGENT_CODING_TOOL_NAMES.readOutput
        ? ArtifactReadResultSchema.parse(value)
        : ArtifactSearchResultSchema.parse(value)
      : name === AGENT_CODING_TOOL_NAMES.readOutput
        ? ArtifactReadSchema.parse(value)
        : ArtifactSearchSchema.parse(value);
    return { ...parsed, reference: ids.reference('spill', parsed.reference) };
  }
  if (output && name === AGENT_CODING_TOOL_NAMES.runCommand) {
    const parsed = ShellOutputSchema.parse(value);
    return {
      ...parsed,
      ...(parsed.artifact && {
        artifact: {
          ...parsed.artifact,
          reference: ids.reference('spill', parsed.artifact.reference),
        },
      }),
    };
  }
  return branchOpaqueJson(ids, value);
}

function branchPart(ids: BranchIdentities, part: AgentMessagePart): AgentMessagePart {
  switch (part.type) {
    case 'file':
      return { ...part, reference: ids.fileReference(part.reference) };
    case 'tool-call': {
      if (part.provider) branchOpaqueJson(ids, part.provider.data);
      return {
        ...part,
        callId: ids.reference('call', part.callId),
        input: branchToolJson(ids, part.toolName, part.input, false),
      };
    }
    case 'tool-result':
      return {
        ...part,
        callId: ids.reference('call', part.callId),
        ...(part.output !== undefined && {
          output:
            part.outcome === 'success'
              ? branchToolJson(ids, part.toolName, part.output, true)
              : branchOpaqueJson(ids, part.output),
        }),
      };
    case 'tool-approval-request':
      return {
        type: part.type,
        approvalId: ids.reference('approval', part.approvalId),
        callId: ids.reference('call', part.callId),
      };
    case 'tool-approval-response':
      return { ...part, approvalId: ids.reference('approval', part.approvalId) };
    case 'provider':
      throw new TypeError('Branch cannot rekey an opaque provider part');
    case 'reasoning':
      if (part.provider) branchOpaqueJson(ids, part.provider.data);
      return part;
    default:
      return part;
  }
}

export function branchMessage(
  ids: BranchIdentities,
  sourceConversationId: string,
  message: AgentMessage,
): AgentMessage {
  if (message.conversationId !== sourceConversationId)
    throw new TypeError('Branch message belongs to another conversation');
  return {
    ...message,
    id: ids.reference('message', message.id),
    conversationId: ids.conversationId,
    ...(message.runId && { runId: ids.reference('run', message.runId) }),
    parts: message.parts.map((part) => branchPart(ids, part)),
    ...(message.metadata && {
      metadata: z.record(z.string(), z.json()).parse(branchOpaqueJson(ids, message.metadata)),
    }),
  };
}

export function branchRun(
  ids: BranchIdentities,
  sourceConversationId: string,
  run: AgentRun,
  settled: boolean,
): AgentRun {
  if (run.conversationId !== sourceConversationId)
    throw new TypeError('Branch run belongs to another conversation');
  const { ownerId, fencingToken, ...record } = run;
  return {
    ...record,
    id: ids.reference('run', run.id),
    conversationId: ids.conversationId,
    inputMessageIds: run.inputMessageIds.map((id) => ids.reference('message', id)),
    assistantMessageId: ids.reference('message', run.assistantMessageId),
    ...(run.absorbedIntoRunId && {
      absorbedIntoRunId: ids.reference('run', run.absorbedIntoRunId),
    }),
    ...(run.lastOperation && {
      lastOperation: {
        ...run.lastOperation,
        operationId: ids.reference('operation', run.lastOperation.operationId),
      },
    }),
    ...(!settled && ownerId && { ownerId: ids.define('owner', ownerId) }),
    ...(!settled && fencingToken !== undefined && { fencingToken }),
  };
}
