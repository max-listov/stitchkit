import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BranchIdentities } from './branch-identities';
import { branchOpaqueJson, branchToolJson } from './branch-messages';
import {
  ProviderJournalMessageSchema,
  ProviderJournalRequestSchema,
  ProviderJournalResponseSchema,
} from './provider-journal';
import { canonicalAgentJson } from './store-events';

type JsonValue = z.infer<ReturnType<typeof z.json>>;
type JournalPart = Extract<
  z.infer<typeof ProviderJournalMessageSchema>['message']['content'],
  unknown[]
>[number];
type ToolResultOutput = Extract<JournalPart, { type: 'tool-result' }>['output'];
type FilePartData = Extract<JournalPart, { type: 'file' }>['data'];
type ReasoningFileData = Extract<JournalPart, { type: 'reasoning-file' }>['data'];
type ImagePartData = Extract<JournalPart, { type: 'image' }>['image'];
type ContentFileItemData = Extract<
  Extract<ToolResultOutput, { type: 'content' }>['value'][number],
  { type: 'file' }
>['data'];

const ProviderOptionsRecordSchema = z.record(z.string(), z.record(z.string(), z.json()));
const ReferenceRecordSchema = z
  .record(z.string(), z.string())
  .refine(
    (value) => !('type' in value),
    'Provider reference cannot contain a file discriminator',
  );

function hash(value: unknown) {
  return createHash('sha256').update(canonicalAgentJson(value)).digest('hex');
}

function rekeyProviderOptions(
  ids: BranchIdentities,
  options: Record<string, Record<string, JsonValue>>,
): Record<string, Record<string, JsonValue>> {
  return ProviderOptionsRecordSchema.parse(branchOpaqueJson(ids, options));
}

function rekeyReference(ids: BranchIdentities, value: Record<string, string>) {
  return ReferenceRecordSchema.parse(branchOpaqueJson(ids, value));
}

function rekeyContentFileData(
  ids: BranchIdentities,
  value: ContentFileItemData,
): ContentFileItemData {
  if (value.type === 'reference') {
    return { ...value, reference: rekeyReference(ids, value.reference) };
  }
  return value;
}

function isBinaryMarker(
  value: object,
): value is { binary: true; sha256: string; bytes: number } {
  return 'binary' in value && value.binary === true;
}

function rekeyFilePartData(ids: BranchIdentities, value: FilePartData): FilePartData {
  if (typeof value === 'string') return value;
  if (isBinaryMarker(value)) return value;
  if ('type' in value) {
    if (
      value.type === 'reference' &&
      'reference' in value &&
      typeof value.reference === 'object' &&
      value.reference !== null
    ) {
      return { type: 'reference', reference: rekeyReference(ids, value.reference) };
    }
    return value;
  }
  return rekeyReference(ids, value);
}

function rekeyImagePartData(ids: BranchIdentities, value: ImagePartData): ImagePartData {
  if (typeof value === 'string') return value;
  if (isBinaryMarker(value)) return value;
  return rekeyReference(ids, value);
}

function rekeyReasoningFileData(
  _ids: BranchIdentities,
  value: ReasoningFileData,
): ReasoningFileData {
  return value;
}

/** Provider IDs stay provider IDs; runtime call references and their content digests are rekeyed. */
export class BranchProvider {
  private readonly digests = new Map<string, string>();
  constructor(private readonly ids: BranchIdentities) {}
  rekey(kind: string, raw: JsonValue) {
    if (kind === 'provider/message') {
      const value = ProviderJournalMessageSchema.parse(raw);
      if (hash(value.message) !== value.sha256)
        throw new TypeError('Branch provider message digest is inconsistent');
      const rekeyedMessageOptions = value.message.providerOptions
        ? rekeyProviderOptions(this.ids, value.message.providerOptions)
        : undefined;
      const message = {
        ...value.message,
        ...(rekeyedMessageOptions !== undefined && { providerOptions: rekeyedMessageOptions }),
        content:
          typeof value.message.content === 'string'
            ? value.message.content
            : value.message.content.map((part) => this.rekeyPart(part)),
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

  private rekeyPart(part: JournalPart): JournalPart {
    const providerOptions =
      'providerOptions' in part && part.providerOptions !== undefined
        ? rekeyProviderOptions(this.ids, part.providerOptions)
        : undefined;
    const base = providerOptions !== undefined ? { ...part, providerOptions } : part;
    if (base.type === 'file') {
      return { ...base, data: rekeyFilePartData(this.ids, base.data) };
    }
    if (base.type === 'reasoning-file') {
      return { ...base, data: rekeyReasoningFileData(this.ids, base.data) };
    }
    if (base.type === 'image') {
      return { ...base, image: rekeyImagePartData(this.ids, base.image) };
    }
    if (base.type === 'tool-call') {
      return {
        ...base,
        toolCallId: this.ids.reference('call', base.toolCallId),
        input: branchToolJson(this.ids, base.toolName, base.input, false),
      };
    }
    if (base.type === 'tool-result') {
      return {
        ...base,
        toolCallId: this.ids.reference('call', base.toolCallId),
        output: this.rekeyToolResultOutput(base.toolName, base.output),
      };
    }
    if (base.type === 'tool-approval-request') {
      return {
        type: base.type,
        approvalId: this.ids.reference('approval', base.approvalId),
        toolCallId: this.ids.reference('call', base.toolCallId),
        ...(base.reason !== undefined && { reason: base.reason }),
      };
    }
    if (base.type === 'tool-approval-response') {
      return {
        ...base,
        approvalId: this.ids.reference('approval', base.approvalId),
      };
    }
    return base;
  }

  private rekeyToolResultOutput(toolName: string, output: ToolResultOutput): ToolResultOutput {
    const providerOptions =
      'providerOptions' in output && output.providerOptions !== undefined
        ? rekeyProviderOptions(this.ids, output.providerOptions)
        : undefined;
    if (output.type === 'json') {
      return {
        ...output,
        ...(providerOptions !== undefined && { providerOptions }),
        value: branchToolJson(this.ids, toolName, output.value, true),
      };
    }
    if (output.type === 'error-json') {
      return {
        ...output,
        ...(providerOptions !== undefined && { providerOptions }),
        value: branchOpaqueJson(this.ids, output.value),
      };
    }
    if (output.type === 'content') {
      return {
        ...output,
        value: output.value.map((item) => {
          const itemOptions =
            item.providerOptions !== undefined
              ? rekeyProviderOptions(this.ids, item.providerOptions)
              : undefined;
          const next =
            itemOptions !== undefined ? { ...item, providerOptions: itemOptions } : item;
          if (next.type === 'file') {
            return { ...next, data: rekeyContentFileData(this.ids, next.data) };
          }
          if (next.type === 'file-reference' || next.type === 'image-file-reference') {
            return {
              ...next,
              providerReference: rekeyReference(this.ids, next.providerReference),
            };
          }
          if (
            (next.type === 'file-id' || next.type === 'image-file-id') &&
            typeof next.fileId !== 'string'
          ) {
            return { ...next, fileId: rekeyReference(this.ids, next.fileId) };
          }
          return next;
        }),
      };
    }
    return providerOptions !== undefined ? { ...output, providerOptions } : output;
  }
}
