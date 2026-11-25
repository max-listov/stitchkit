import { createHash } from 'node:crypto';
import {
  type AgentBranchRefusal,
  AgentConversationBranchRefusedError,
  MAX_BRANCH_REFUSALS,
} from './branch-refusal';
import type { AgentMessage, AgentRun } from './schemas';
import type { StoreOperation } from './store-reduce-shared';

export type IdentityKind =
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

/** Where in the source the branch is reading. */
type BranchAddress = Pick<AgentBranchRefusal, 'seq' | 'eventKind' | 'messageId' | 'toolName'>;

/** The address a thrown error was raised at, read by the event loop that reports it. */
const raisedAt = new WeakMap<object, BranchAddress>();

export type BranchApplicationKeyMode = 'refuse' | 'retain' | 'rekey-spill';

/** Definitions are collected before references are resolved; foreign references never mint IDs. */
export class BranchIdentities {
  private readonly definitions = new Map<IdentityKind, Map<string, string>>();
  private readonly found: AgentBranchRefusal[] = [];
  private omitted = 0;
  private address: BranchAddress = {};
  private readonly files = new Set<string>();
  private readonly references = new Map<IdentityKind, Set<string>>();
  private readonly applicationFiles = new Map<string, string>();
  private readonly applicationKeys = new Map<string, BranchApplicationKeyMode>();
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
  /** Register a spill that legitimately expired via `spill/deleted` in the source log. */
  defineExpiredSpill(source: string): string {
    return this.define('spill', source);
  }
  /** Run `work` with `address` added to where the branch is reading. */
  within<T>(address: BranchAddress, work: () => T): T {
    const outer = this.address;
    this.address = { ...outer, ...address };
    try {
      return work();
    } catch (error) {
      if (typeof error === 'object' && error !== null && !raisedAt.has(error))
        raisedAt.set(error, this.address);
      throw error;
    } finally {
      this.address = outer;
    }
  }
  /**
   * Record a refusal a declaration lifts, at the current address, and go on
   * reading: the host learns every one in one answer.
   */
  refuse(refusal: Omit<AgentBranchRefusal, keyof BranchAddress>): void {
    if (this.found.length >= MAX_BRANCH_REFUSALS) {
      this.omitted += 1;
      return;
    }
    this.found.push({ ...this.address, ...refusal });
  }
  /** Everything refused so far; `undefined` when nothing was. */
  refusedError(): AgentConversationBranchRefusedError | undefined {
    return this.found.length > 0
      ? new AgentConversationBranchRefusedError(this.found, this.omitted)
      : undefined;
  }
  /**
   * A source the branch cannot read stops it at once: the error becomes one
   * more refusal, at the address it was raised at, after what was collected.
   */
  integrityError(error: unknown): unknown {
    if (error instanceof AgentConversationBranchRefusedError) return error;
    if (!(error instanceof Error)) return error;
    if (error.name !== 'TypeError' && error.name !== 'ZodError') return error;
    const at = raisedAt.get(error) ?? this.address;
    return new AgentConversationBranchRefusedError(
      [...this.found, { ...at, code: 'integrity', message: error.message }],
      this.omitted,
    );
  }
  /** Attachment references the source's messages hold that are not spills. */
  applicationFileReferences(): readonly string[] {
    return [...this.files].sort();
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
  /** Keys the host declares as its own data inside application JSON, with what a source identity under them does. */
  declareApplicationKeys(
    keys: readonly { key: string; sourceIdentity: BranchApplicationKeyMode }[],
  ): void {
    for (const { key, sourceIdentity } of keys) this.applicationKeys.set(key, sourceIdentity);
  }
  applicationKey(key: string): BranchApplicationKeyMode | undefined {
    return this.applicationKeys.get(key);
  }
  /**
   * Everything of the source conversation that `value` names: the conversation
   * itself, any identity it defines, a declared application file. One string
   * can be several at once, and the caller judges every one.
   */
  sourceIdentitiesOf(value: string): ReadonlySet<IdentityKind | 'conversation' | 'file'> {
    const kinds = new Set<IdentityKind | 'conversation' | 'file'>();
    if (value === this.sourceConversationId) kinds.add('conversation');
    for (const [kind, values] of this.definitions) if (values.has(value)) kinds.add(kind);
    if (this.applicationFiles.has(value)) kinds.add('file');
    return kinds;
  }
  /** A file part's reference in the destination: its spill's, or the declared application one. */
  fileReference(source: string): string {
    if (this.definitions.get('spill')?.has(source)) return this.reference('spill', source);
    this.files.add(source);
    const target = this.applicationFiles.get(source);
    if (target === undefined) {
      this.refuse({
        code: 'application-file-undeclared',
        message:
          'Branch contains a foreign or missing file reference; declare it in applicationFiles if the application owns it',
        reference: source,
      });
      return source;
    }
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
    if (run.ownerId) this.define('owner', run.ownerId);
    this.define('message', run.assistantMessageId);
    if (run.lastOperation) this.define('operation', run.lastOperation.operationId);
  }
  /**
   * Every identity a transition defines, keys and owners included, before any
   * value is judged: a value naming one refuses wherever in the log it sits.
   */
  collectOperation(operation: StoreOperation): void {
    const input = operation.input;
    if ('ownerId' in input && typeof input.ownerId === 'string')
      this.define('owner', input.ownerId);
    switch (operation.type) {
      case 'accept':
        this.define('key', operation.input.idempotencyKey);
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
        this.define('key', operation.input.seedKey);
        for (const message of operation.input.inputs) this.collectMessage(message);
        break;
      case 'operation':
        this.define('operation', operation.input.operation.operationId);
        break;
    }
  }
}
