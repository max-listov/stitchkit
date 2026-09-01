import { type ZodType, z } from 'zod';
import type { ContractDef, EndpointDef } from '../contract';
import {
  createDomainEventSchema,
  type DomainEventActor,
  type DomainEventSubject,
} from './event';

export interface AuditRecordPolicy<TChange extends ZodType = ZodType> {
  readonly mode: 'record';
  readonly change: TChange;
}

export interface AuditOmitPolicy {
  readonly mode: 'omit';
  readonly reason: string;
}

export type AuditPolicy = AuditRecordPolicy | AuditOmitPolicy;

export const AuditChangeSchema = z.object({
  operation: z.string().min(1),
  change: z.unknown(),
});
export const AuditRecordSchema = createDomainEventSchema(AuditChangeSchema);
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export const audit = Object.freeze({
  record<TChange extends ZodType>(change: TChange): AuditRecordPolicy<TChange> {
    return Object.freeze({ mode: 'record', change });
  },
  omit(reason: string): AuditOmitPolicy {
    if (reason.trim() === '') throw new Error('[stitchkit] audit omission requires a reason');
    return Object.freeze({ mode: 'omit', reason });
  },
});

function isZodType(value: unknown): value is ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    'safeParse' in value &&
    typeof value.safeParse === 'function'
  );
}

function endpointAuditPolicy(endpoint: EndpointDef): AuditPolicy | undefined {
  const policy: unknown = endpoint.meta?.audit;
  if (!policy || typeof policy !== 'object' || !('mode' in policy)) return undefined;
  if (policy.mode === 'omit' && 'reason' in policy && typeof policy.reason === 'string') {
    return audit.omit(policy.reason);
  }
  if (policy.mode === 'record' && 'change' in policy && isZodType(policy.change)) {
    return { mode: 'record', change: policy.change };
  }
  return undefined;
}

/** Refuse a contract whose operation author did not make an explicit audit decision. */
export function assertAuditDeclared(contract: ContractDef): void {
  for (const [operation, endpoint] of Object.entries(contract.endpoints)) {
    if (!endpointAuditPolicy(endpoint)) {
      throw new Error(
        `[stitchkit] contract "${contract.meta.prefix}" operation "${operation}" must declare meta.audit`,
      );
    }
  }
}

export interface CreateAuditRecordInput<TChange> {
  readonly id: string;
  readonly occurredAt: string;
  readonly operation: string;
  readonly actor: DomainEventActor;
  readonly subject: DomainEventSubject;
  readonly policy: AuditRecordPolicy<ZodType<TChange>>;
  readonly change: TChange;
}

/** Validate the declared change and return the same event value journals and delivery consume. */
export function createAuditRecord<TChange>(
  input: CreateAuditRecordInput<TChange>,
): AuditRecord {
  const change = input.policy.change.parse(input.change);
  return AuditRecordSchema.parse({
    id: input.id,
    type: 'audit.recorded',
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: input.subject,
    payload: { operation: input.operation, change },
  });
}
