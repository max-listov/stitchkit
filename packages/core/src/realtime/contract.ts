import type { z } from 'zod';
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

export type RealtimeRejectDirection =
  | 'client-inbound'
  | 'client-outbound'
  | 'server-inbound'
  | 'server-outbound';

export interface RealtimeRejectedEvent {
  event: string;
  direction: RealtimeRejectDirection;
  phase: 'arguments' | 'acknowledgement';
  reason:
    | 'unknown-event'
    | 'invalid-arguments'
    | 'invalid-acknowledgement-value'
    | 'missing-acknowledgement'
    /**
     * The PEER refused our frame against its own copy of the contract, and
     * said so. Reported on the sender, where a silent drop used to leave
     * nothing but an expiring deadline.
     */
    | 'rejected-by-peer';
  fault: 'peer' | 'local';
  error: AppError<'REALTIME_CONTRACT_VIOLATION'>;
}

export type RealtimeRejectedEventHook = (
  rejected: RealtimeRejectedEvent,
) => void | Promise<void>;
