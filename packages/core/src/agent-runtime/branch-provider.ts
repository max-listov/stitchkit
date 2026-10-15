import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BranchIdentities } from './branch-identities';
import { branchOpaqueJson, branchToolJson } from './branch-messages';
import { canonicalAgentJson } from './store-events';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.object({ type: z.enum(['text', 'reasoning']), text: z.string() }).strict();
const Call = z
  .object({
    type: z.literal('tool-call'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.json(),
  })
  .strict();
const Result = z
  .object({
    type: z.literal('tool-result'),
    toolCallId: z.string(),
    toolName: z.string(),
    output: z.discriminatedUnion('type', [
      z.object({ type: z.enum(['text', 'error-text']), value: z.string() }).strict(),
      z.object({ type: z.enum(['json', 'error-json']), value: z.json() }).strict(),
    ]),
  })
  .strict();
const Message = z
  .object({
    role: z.enum(['user', 'assistant', 'tool']),
    content: z.union([
      z.string(),
      z.array(
        z.union([
          Text,
          Call,
          Result,
          z
            .object({
              type: z.literal('tool-approval-request'),
              approvalId: z.string(),
              toolCallId: z.string(),
              signature: z.string().optional(),
              isAutomatic: z.boolean().optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal('tool-approval-response'),
              approvalId: z.string(),
              approved: z.boolean(),
              reason: z.string().optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal('file'),
              data: z.union([
                z.string(),
                z
                  .object({
                    binary: z.literal(true),
                    sha256: Hash,
                    bytes: z.int().nonnegative(),
                  })
                  .strict(),
              ]),
              mediaType: z.string(),
              filename: z.string().optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal('image'),
              image: z.union([
                z.string(),
                z
                  .object({
                    binary: z.literal(true),
                    sha256: Hash,
                    bytes: z.int().nonnegative(),
                  })
                  .strict(),
              ]),
              mediaType: z.string().optional(),
            })
            .strict(),
        ]),
      ),
    ]),
  })
  .strict();
const ProviderMessage = z.object({ sha256: Hash, message: Message }).strict();
const ProviderRequest = z
  .object({
    runId: z.string(),
    attempt: z.int().nonnegative(),
    stepNumber: z.int().nonnegative(),
    modelId: z.string(),
    instructionsSha256: Hash,
    messageShas: z.array(Hash),
    bodySha256: Hash,
  })
  .strict();
const ProviderResponse = z
  .object({
    runId: z.string(),
    attempt: z.int().nonnegative(),
    stepNumber: z.int().nonnegative(),
    response: z.object({ id: z.string(), provider: z.string().optional() }).strict(),
  })
  .strict();

function hash(value: unknown) {
  return createHash('sha256').update(canonicalAgentJson(value)).digest('hex');
}

/** Provider IDs stay provider IDs; runtime call references and their content digests are rekeyed. */
export class BranchProvider {
  private readonly digests = new Map<string, string>();
  constructor(private readonly ids: BranchIdentities) {}
  rekey(kind: string, raw: z.infer<ReturnType<typeof z.json>>) {
    if (kind === 'provider/message') {
      const value = ProviderMessage.parse(raw);
      if (hash(value.message) !== value.sha256)
        throw new TypeError('Branch provider message digest is inconsistent');
      const message = {
        ...value.message,
        content:
          typeof value.message.content === 'string'
            ? value.message.content
            : value.message.content.map((part) => {
                if (part.type === 'tool-call')
                  return {
                    ...part,
                    toolCallId: this.ids.reference('call', part.toolCallId),
                    input: branchToolJson(this.ids, part.toolName, part.input, false),
                  };
                if (part.type === 'tool-result') {
                  if (part.output.type === 'error-json') branchOpaqueJson(part.output.value);
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
      const value = ProviderRequest.parse(raw);
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
    const value = ProviderResponse.parse(raw);
    return { ...value, runId: this.ids.reference('run', value.runId) };
  }
}
