import { z } from 'zod';
import type { AppError } from '../contract/errors';

export interface RealtimeEventDefinition<
  TArgs extends z.ZodType<unknown[]> = z.ZodType<unknown[]>,
  TAck extends z.ZodType | undefined = z.ZodType | undefined,
> {
  args: TArgs;
  ack?: TAck;
}

export type RealtimeEventRegistry = Record<string, RealtimeEventDefinition>;

export interface RealtimeContract<
  TServerToClient extends RealtimeEventRegistry,
  TClientToServer extends RealtimeEventRegistry,
> {
  serverToClient: TServerToClient;
  clientToServer: TClientToServer;
}

export function defineRealtimeContract<
  const TServerToClient extends RealtimeEventRegistry,
  const TClientToServer extends RealtimeEventRegistry,
>(contract: RealtimeContract<TServerToClient, TClientToServer>) {
  return contract;
}

export type RealtimeEventArguments<TDefinition extends RealtimeEventDefinition> = [
  ...z.output<TDefinition['args']>,
  ...(TDefinition extends { ack: infer TAck extends z.ZodType }
    ? [(value: z.input<TAck>) => void]
    : []),
];

export type RealtimeEmitArguments<TDefinition extends RealtimeEventDefinition> = [
  ...(z.input<TDefinition['args']> extends unknown[] ? z.input<TDefinition['args']> : never),
  ...(TDefinition extends { ack: infer TAck extends z.ZodType }
    ? [(value: z.output<TAck>) => void]
    : []),
];

export type RealtimeEventHandler<TDefinition extends RealtimeEventDefinition> = (
  ...args: RealtimeEventArguments<TDefinition>
) => void;

export type RealtimeAcknowledgedEvent<TRegistry extends RealtimeEventRegistry> = {
  [TEvent in keyof TRegistry]: TRegistry[TEvent] extends { ack: z.ZodType } ? TEvent : never;
}[keyof TRegistry] &
  string;

export type RealtimeRequestArguments<TDefinition extends RealtimeEventDefinition> =
  z.input<TDefinition['args']> extends unknown[] ? z.input<TDefinition['args']> : never;

export type RealtimeAcknowledgement<TDefinition extends RealtimeEventDefinition> =
  TDefinition extends { ack: infer TAck extends z.ZodType } ? z.output<TAck> : never;

export type InferRealtimeEventMap<TRegistry extends RealtimeEventRegistry> = {
  [TEvent in keyof TRegistry]: RealtimeEventHandler<TRegistry[TEvent]>;
};

export const RealtimeRejectDirectionSchema = z.enum([
  'client-inbound',
  'client-outbound',
  'server-inbound',
  'server-outbound',
]);
export const RealtimeRejectPhaseSchema = z.enum(['arguments', 'acknowledgement']);
export const RealtimeRejectReasonSchema = z.enum([
  'unknown-event',
  'invalid-arguments',
  'invalid-acknowledgement-value',
  'missing-acknowledgement',
  'rejected-by-peer',
]);
export const RealtimeRejectFaultSchema = z.enum(['peer', 'local']);

export type RealtimeRejectDirection = z.infer<typeof RealtimeRejectDirectionSchema>;
export type RealtimeRejectPhase = z.infer<typeof RealtimeRejectPhaseSchema>;
export type RealtimeRejectReason = z.infer<typeof RealtimeRejectReasonSchema>;
export type RealtimeRejectFault = z.infer<typeof RealtimeRejectFaultSchema>;

export interface RealtimeRejectedEvent {
  event: string;
  direction: RealtimeRejectDirection;
  phase: RealtimeRejectPhase;
  /** Includes `rejected-by-peer` when the peer refused our frame against its contract. */
  reason: RealtimeRejectReason;
  fault: RealtimeRejectFault;
  error: AppError<'REALTIME_CONTRACT_VIOLATION'>;
}

export type RealtimeRejectedEventHook = (
  rejected: RealtimeRejectedEvent,
) => void | Promise<void>;
