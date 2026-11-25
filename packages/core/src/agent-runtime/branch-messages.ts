import { z } from 'zod';
import { BRANCH_RUNTIME_REFERENCE_KEYS } from './branch-contract';
import type { BranchIdentities } from './branch-identities';
import { branchRuntimeToolRecord } from './branch-runtime-tools';
import type { AgentMessage, AgentMessagePart, AgentRun } from './schemas';

/** Source identities a `'retain'` key may carry as a record of the past. */
const RETAINABLE = new Set(['conversation', 'run', 'message']);

/**
 * Application JSON is data, never an undocumented runtime reference codec.
 *
 * A key named like a runtime reference refuses the branch unless the host
 * declares it in `applicationKeys`: the value cannot be rekeyed, and carried as
 * it is it could name the source. Under a `'refuse'` key a value that names
 * anything of the source still refuses. Under a `'retain'` key a value naming
 * the source conversation, a run or a message crosses unchanged as a record of
 * the past; one naming a spill, an application file or another runtime
 * identity refuses, because what it grants crosses by its own contract.
 * Refusals name the key's path inside the payload, never its value, and are
 * collected: the branch goes on reading and answers them all at once.
 */
export function branchOpaqueJson(
  ids: BranchIdentities,
  value: z.infer<ReturnType<typeof z.json>>,
  path = '',
): typeof value {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      branchOpaqueJson(ids, entry, `${path}[${index}]`);
    });
    return value;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of BRANCH_RUNTIME_REFERENCE_KEYS) {
      if (!(key in value)) continue;
      const at = path ? `${path}.${key}` : key;
      const mode = ids.applicationKey(key);
      if (mode === undefined) {
        ids.refuse({
          code: 'application-key-undeclared',
          message: `Branch cannot rekey an opaque payload containing ${key} at ${at}; declare it in applicationKeys if it is application data`,
          key,
          path: at,
        });
        continue;
      }
      const entry = value[key];
      if (typeof entry !== 'string') continue;
      for (const kind of ids.sourceIdentitiesOf(entry)) {
        if (mode === 'retain' && RETAINABLE.has(kind)) continue;
        ids.refuse({
          code: 'application-key-source-identity',
          message:
            mode === 'retain'
              ? `Branch cannot carry a source ${kind} under the application key ${key} at ${at}`
              : `Branch cannot carry a source identity under the application key ${key} at ${at}`,
          key,
          path: at,
        });
        break;
      }
    }
    for (const [key, entry] of Object.entries(value))
      branchOpaqueJson(ids, entry, path ? `${path}.${key}` : key);
  }
  return value;
}

export function branchToolJson(
  ids: BranchIdentities,
  name: string,
  value: z.infer<ReturnType<typeof z.json>>,
  output: boolean,
) {
  return branchRuntimeToolRecord(ids, name, value, output) ?? branchOpaqueJson(ids, value);
}

function branchPart(ids: BranchIdentities, part: AgentMessagePart): AgentMessagePart {
  return 'toolName' in part && typeof part.toolName === 'string'
    ? ids.within({ toolName: part.toolName }, () => branchPartAt(ids, part))
    : branchPartAt(ids, part);
}

function branchPartAt(ids: BranchIdentities, part: AgentMessagePart): AgentMessagePart {
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
  return ids.within({ messageId: message.id }, () => ({
    ...message,
    id: ids.reference('message', message.id),
    conversationId: ids.conversationId,
    ...(message.runId && { runId: ids.reference('run', message.runId) }),
    parts: message.parts.map((part) => branchPart(ids, part)),
    ...(message.metadata && {
      metadata: z.record(z.string(), z.json()).parse(branchOpaqueJson(ids, message.metadata)),
    }),
  }));
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
