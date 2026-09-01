import { type ZodType, z } from 'zod';

export const DomainEventActorSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
});
export type DomainEventActor = z.infer<typeof DomainEventActorSchema>;

export const DomainEventSubjectSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});
export type DomainEventSubject = z.infer<typeof DomainEventSubjectSchema>;

/** Build one application-owned event envelope around a typed payload. */
export function createDomainEventSchema<TPayload extends ZodType>(payload: TPayload) {
  return z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
    actor: DomainEventActorSchema.optional(),
    subject: DomainEventSubjectSchema,
    payload,
  });
}

export const DomainEventSchema = createDomainEventSchema(z.unknown());
export type DomainEvent = z.infer<typeof DomainEventSchema>;
