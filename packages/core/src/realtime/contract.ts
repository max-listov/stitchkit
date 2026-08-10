import type { z } from 'zod';

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
  error: z.ZodError;
}

export type RealtimeRejectedEventHook = (
  rejected: RealtimeRejectedEvent,
) => void | Promise<void>;
