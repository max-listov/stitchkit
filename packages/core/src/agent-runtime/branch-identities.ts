import { createHash } from 'node:crypto';
import type { AgentMessage, AgentRun } from './schemas';
import type { StoreOperation } from './store-reduce-shared';

type IdentityKind =
  | 'run'
  | 'message'
  | 'call'
  | 'approval'
  | 'operation'
  | 'spill'
  | 'event'
  | 'owner'
  | 'key'
  | 'schedule'
  | 'child';

/** Definitions are collected before references are resolved; foreign references never mint IDs. */
export class BranchIdentities {
  private readonly definitions = new Map<IdentityKind, Map<string, string>>();
  private readonly references = new Map<IdentityKind, Set<string>>();
  constructor(
    readonly conversationId: string,
    private readonly requestKey: string,
    readonly sourceConversationId: string,
  ) {}
  define(kind: IdentityKind, source: string): string {
    const values = this.definitions.get(kind) ?? new Map<string, string>();
    const target =
      values.get(source) ??
      createHash('sha256')
        .update(JSON.stringify([this.conversationId, this.requestKey, kind, source]))
        .digest('hex');
    values.set(source, target);
    this.definitions.set(kind, values);
    return target;
  }
  reference(kind: IdentityKind, source: string): string {
    const target = this.definitions.get(kind)?.get(source);
    if (!target) throw new TypeError(`Branch contains a foreign or missing ${kind} reference`);
    const referenced = this.references.get(kind) ?? new Set<string>();
    referenced.add(source);
    this.references.set(kind, referenced);
    return target;
  }
  referenced(kind: IdentityKind): ReadonlySet<string> {
    return this.references.get(kind) ?? new Set<string>();
  }
  collectMessage(message: AgentMessage): void {
    this.define('message', message.id);
    for (const part of message.parts) {
      if (part.type === 'tool-call') this.define('call', part.callId);
      if (part.type === 'tool-approval-request') this.define('approval', part.approvalId);
    }
  }
  collectRun(run: AgentRun): void {
    this.define('run', run.id);
    this.define('message', run.assistantMessageId);
    if (run.lastOperation) this.define('operation', run.lastOperation.operationId);
  }
  collectOperation(operation: StoreOperation): void {
    switch (operation.type) {
      case 'accept':
        this.collectRun(operation.input.run);
        this.collectMessage(operation.input.input);
        break;
      case 'checkpoint':
      case 'terminal':
        this.collectMessage(operation.input.assistant);
        break;
      case 'recover':
        if (operation.assistant) this.collectMessage(operation.assistant);
        break;
      case 'compact':
        this.collectMessage(operation.input.summary);
        break;
      case 'seed':
        for (const message of operation.input.inputs) this.collectMessage(message);
        break;
      case 'operation':
        this.define('operation', operation.input.operation.operationId);
        break;
    }
  }
}
