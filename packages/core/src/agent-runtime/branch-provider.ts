import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { BranchIdentities } from './branch-identities';
import { branchOpaqueJson, branchToolJson } from './branch-messages';
import {
  ProviderJournalMessageSchema,
  ProviderJournalRequestSchema,
  ProviderJournalResponseSchema,
} from './provider-journal';
import { canonicalAgentJson } from './store-events';

function hash(value: unknown) {
  return createHash('sha256').update(canonicalAgentJson(value)).digest('hex');
}

function checkFileData(value: z.infer<ReturnType<typeof z.json>>) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  if (value.type === 'reference' && 'reference' in value) branchOpaqueJson(value.reference);
  else if (!('type' in value) && value.binary !== true) branchOpaqueJson(value);
}

/** Provider IDs stay provider IDs; runtime call references and their content digests are rekeyed. */
export class BranchProvider {
  private readonly digests = new Map<string, string>();
  constructor(private readonly ids: BranchIdentities) {}
  rekey(kind: string, raw: z.infer<ReturnType<typeof z.json>>) {
    if (kind === 'provider/message') {
      const value = ProviderJournalMessageSchema.parse(raw);
      if (hash(value.message) !== value.sha256)
        throw new TypeError('Branch provider message digest is inconsistent');
      if (value.message.providerOptions) branchOpaqueJson(value.message.providerOptions);
      const message = {
        ...value.message,
        content:
          typeof value.message.content === 'string'
            ? value.message.content
            : value.message.content.map((part) => {
                if ('providerOptions' in part && part.providerOptions)
                  branchOpaqueJson(part.providerOptions);
                if (part.type === 'file' || part.type === 'reasoning-file')
                  checkFileData(part.data);
                if (part.type === 'image') checkFileData(part.image);
                if (part.type === 'tool-call')
                  return {
                    ...part,
                    toolCallId: this.ids.reference('call', part.toolCallId),
                    input: branchToolJson(this.ids, part.toolName, part.input, false),
                  };
                if (part.type === 'tool-result') {
                  if ('providerOptions' in part.output && part.output.providerOptions)
                    branchOpaqueJson(part.output.providerOptions);
                  if (part.output.type === 'error-json') branchOpaqueJson(part.output.value);
                  if (part.output.type === 'content')
                    for (const item of part.output.value) {
                      if (item.providerOptions) branchOpaqueJson(item.providerOptions);
                      if (item.type === 'file') checkFileData(item.data);
                      if ('providerReference' in item)
                        branchOpaqueJson(item.providerReference);
                      if ('fileId' in item && typeof item.fileId !== 'string')
                        branchOpaqueJson(item.fileId);
                    }
                  return {
                    ...part,
                    toolCallId: this.ids.reference('call', part.toolCallId),
                    output:
                      part.output.type === 'json'
                        ? {
                            ...part.output,
                            value: branchToolJson(
                              this.ids,
                              part.toolName,
                              part.output.value,
                              true,
                            ),
                          }
                        : part.output,
                  };
                }
                if (part.type === 'tool-approval-request')
                  return {
                    type: part.type,
                    approvalId: this.ids.reference('approval', part.approvalId),
                    toolCallId: this.ids.reference('call', part.toolCallId),
                    ...(part.reason !== undefined && { reason: part.reason }),
                  };
                if (part.type === 'tool-approval-response')
                  return {
                    ...part,
                    approvalId: this.ids.reference('approval', part.approvalId),
                  };
                return part;
              }),
      };
      const sha256 = hash(message);
      this.digests.set(value.sha256, sha256);
      return { sha256, message };
    }
    if (kind === 'provider/request') {
      const value = ProviderJournalRequestSchema.parse(raw);
      const sourceHash = createHash('sha256')
        .update(value.instructionsSha256)
        .update(value.messageShas.join(','))
        .digest('hex');
      if (sourceHash !== value.bodySha256)
        throw new TypeError('Branch provider request digest is inconsistent');
      const messageShas = value.messageShas.map((sha) => {
        const target = this.digests.get(sha);
        if (!target)
          throw new TypeError('Branch provider request references a missing message');
        return target;
      });
      return {
        ...value,
        runId: this.ids.reference('run', value.runId),
        messageShas,
        bodySha256: createHash('sha256')
          .update(value.instructionsSha256)
          .update(messageShas.join(','))
          .digest('hex'),
      };
    }
    const value = ProviderJournalResponseSchema.parse(raw);
    return { ...value, runId: this.ids.reference('run', value.runId) };
  }
}
