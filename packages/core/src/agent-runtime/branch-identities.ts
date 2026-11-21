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
  private readonly applicationFiles = new Map<string, string>();
  private readonly applicationKeys = new Set<string>();
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
  /**
   * Declare file part references the application owns, after the archive's
   * spills: one reference has one owner, so a declared reference that is also a
   * spill refuses rather than choosing between them.
   */
  declareApplicationFiles(
    files: readonly { reference: string; destinationReference: string }[],
  ): void {
    for (const file of files) {
      if (this.definitions.get('spill')?.has(file.reference))
        throw new TypeError('Branch application file reference is also a spill reference');
      this.applicationFiles.set(file.reference, file.destinationReference);
    }
  }
  /** Keys the host declares as its own data inside application JSON. */
  declareApplicationKeys(keys: readonly string[]): void {
    for (const key of keys) this.applicationKeys.add(key);
  }
  isApplicationKey(key: string): boolean {
    return this.applicationKeys.has(key);
  }
  /** Whether `value` names something of the source conversation: itself or any identity it defines. */
  isSourceIdentity(value: string): boolean {
    if (value === this.sourceConversationId) return true;
    for (const values of this.definitions.values()) if (values.has(value)) return true;
    return false;
  }
  /** A file part's reference in the destination: its spill's, or the declared application one. */
  fileReference(source: string): string {
    if (this.definitions.get('spill')?.has(source)) return this.reference('spill', source);
    const target = this.applicationFiles.get(source);
    if (target === undefined)
      throw new TypeError('Branch contains a foreign or missing file reference');
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
