import { z } from 'zod';

/**
 * Why a branch refused one thing, and where.
 *
 * The first four codes are lifted by the host: a declaration in
 * `applicationKeys` or `applicationFiles`, an artifact authorization, or a
 * runtime that knows the event kind. They are collected and answered together.
 * `integrity` is a source the branch cannot read as what it claims to be; it
 * stops the branch at once, after what was collected before it.
 */
export const AgentBranchRefusalCodeSchema = z.enum([
  'application-key-undeclared',
  'application-key-source-identity',
  'application-file-undeclared',
  'artifact-authorization-missing',
  'event-kind-unknown',
  'integrity',
]);
/** Branch refusal reason code inferred from `AgentBranchRefusalCodeSchema`. */
export type AgentBranchRefusalCode = z.infer<typeof AgentBranchRefusalCodeSchema>;

/**
 * One refusal with its address in the source. It names the event, the
 * message, the tool and the key's path inside the payload — never a value the
 * payload holds, so a host can locate it in an archive it must not disclose.
 * `reference` is the attachment reference the host owns and must declare.
 */
export const AgentBranchRefusalSchema = z
  .object({
    code: AgentBranchRefusalCodeSchema,
    message: z.string().min(1),
    seq: z.int().positive().optional(),
    eventKind: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    toolName: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    path: z.string().optional(),
    reference: z.string().min(1).optional(),
  })
  .strict();
/** Single structured branch refusal entry inferred from `AgentBranchRefusalSchema`. */
export type AgentBranchRefusal = z.infer<typeof AgentBranchRefusalSchema>;

/** How many refusals one answer carries; the rest are counted, not listed. */
export const MAX_BRANCH_REFUSALS = 100;

function addressOf(refusal: AgentBranchRefusal): string {
  const parts = [
    refusal.seq !== undefined &&
      `event ${refusal.seq}${refusal.eventKind ? ` ${refusal.eventKind}` : ''}`,
    refusal.messageId !== undefined && `message ${refusal.messageId}`,
    refusal.toolName !== undefined && `tool ${refusal.toolName}`,
  ].filter((part): part is string => typeof part === 'string');
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * A branch refused, with every refusal it found. A `TypeError`, as a branch
 * refusal always was, whose message is the first refusal with its address and
 * a count of the others.
 */
export class AgentConversationBranchRefusedError extends TypeError {
  readonly refusals: readonly AgentBranchRefusal[];
  /** Refusals found past `MAX_BRANCH_REFUSALS`, counted but not listed. */
  readonly omittedRefusals: number;
  constructor(refusals: readonly AgentBranchRefusal[], omittedRefusals = 0) {
    const [first] = refusals;
    if (!first) throw new TypeError('A branch refusal names at least one refusal');
    const more = refusals.length - 1 + omittedRefusals;
    super(
      `${first.message}${addressOf(first)}${more > 0 ? `; and ${more} more refusal${more === 1 ? '' : 's'}` : ''}`,
    );
    this.name = 'AgentConversationBranchRefusedError';
    this.refusals = refusals;
    this.omittedRefusals = omittedRefusals;
  }
}
