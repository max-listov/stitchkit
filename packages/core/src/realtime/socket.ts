import { z } from 'zod';
import type {
  RealtimeEmitArguments,
  RealtimeEventDefinition,
  RealtimeEventHandler,
  RealtimeEventRegistry,
  RealtimeRejectDirection,
  RealtimeRejectedEvent,
  RealtimeRejectedEventHook,
} from './contract';

interface ValidatedRealtimeSocketOptions<
  TInbound extends RealtimeEventRegistry,
  TOutbound extends RealtimeEventRegistry,
> {
  target: object;
  inbound: TInbound;
  outbound: TOutbound;
  inboundDirection: RealtimeRejectDirection;
  outboundDirection: RealtimeRejectDirection;
  onRejected?: RealtimeRejectedEventHook;
  subscribe?: (event: string, handler: (...args: unknown[]) => void) => () => void;
}

export interface ValidatedRealtimeSocket<
  TInbound extends RealtimeEventRegistry,
  TOutbound extends RealtimeEventRegistry,
> {
  on<TEvent extends keyof TInbound & string>(
    event: TEvent,
    handler: RealtimeEventHandler<TInbound[TEvent]>,
  ): () => void;
  emit<TEvent extends keyof TOutbound & string>(
    event: TEvent,
    ...args: RealtimeEmitArguments<TOutbound[TEvent]>
  ): void;
}

const AcknowledgementCallbackSchema = z.function();

function method(target: object, name: 'on' | 'off' | 'emit'): (...args: unknown[]) => unknown {
  const value = Reflect.get(target, name);
  if (typeof value !== 'function') {
    throw new Error(`Realtime target does not implement ${name}()`);
  }
  return (...args) => Reflect.apply(value, target, args);
}

function splitWireArguments(
  definition: RealtimeEventDefinition,
  args: unknown[],
): { values: unknown[]; acknowledgement?: (...args: unknown[]) => unknown } {
  if (!definition.ack) return { values: args };
  const acknowledgement = args.at(-1);
  if (typeof acknowledgement !== 'function') return { values: args };
  return {
    values: args.slice(0, -1),
    acknowledgement: (...callbackArgs) =>
      Reflect.apply(acknowledgement, undefined, callbackArgs),
  };
}

function eventDefinition(
  registry: RealtimeEventRegistry,
  event: string,
): RealtimeEventDefinition {
  const definition = registry[event];
  if (!definition) throw new Error(`Unknown realtime event "${event}"`);
  return definition;
}

function reportRejected(
  rejected: RealtimeRejectedEvent,
  hook: RealtimeRejectedEventHook | undefined,
): void {
  if (!hook) {
    console.error(
      `[stitchkit] rejected realtime ${rejected.direction} event "${rejected.event}" (${rejected.phase})`,
      rejected.error,
    );
    return;
  }
  void Promise.resolve(hook(rejected)).catch((error) => {
    console.error('[stitchkit] realtime rejection hook failed', error);
  });
}

export function createValidatedRealtimeSocket<
  const TInbound extends RealtimeEventRegistry,
  const TOutbound extends RealtimeEventRegistry,
>({
  target,
  inbound,
  outbound,
  inboundDirection,
  outboundDirection,
  onRejected,
  subscribe,
}: ValidatedRealtimeSocketOptions<TInbound, TOutbound>): ValidatedRealtimeSocket<
  TInbound,
  TOutbound
> {
  const onTarget = method(target, 'on');
  const offTarget = subscribe ? undefined : method(target, 'off');
  const emitTarget = method(target, 'emit');

  return {
    on: (event, handler) => {
      const definition = eventDefinition(inbound, event);
      const wrapped = (...wireArgs: unknown[]) => {
        const { values, acknowledgement } = splitWireArguments(definition, wireArgs);
        const parsed = definition.args.safeParse(values);
        if (!parsed.success) {
          reportRejected(
            {
              event,
              direction: inboundDirection,
              phase: 'arguments',
              error: parsed.error,
            },
            onRejected,
          );
          return;
        }
        if (definition.ack && !acknowledgement) {
          const callback = AcknowledgementCallbackSchema.safeParse(undefined);
          if (!callback.success) {
            reportRejected(
              {
                event,
                direction: inboundDirection,
                phase: 'acknowledgement',
                error: callback.error,
              },
              onRejected,
            );
          }
          return;
        }
        const applicationArgs: unknown[] = [...parsed.data];
        if (definition.ack) {
          applicationArgs.push((value: unknown) => {
            const ack = definition.ack?.safeParse(value);
            if (!ack?.success) {
              if (ack) {
                reportRejected(
                  {
                    event,
                    direction: outboundDirection,
                    phase: 'acknowledgement',
                    error: ack.error,
                  },
                  onRejected,
                );
              }
              return;
            }
            acknowledgement?.(ack.data);
          });
        }
        Reflect.apply(handler, undefined, applicationArgs);
      };
      if (subscribe) return subscribe(event, wrapped);
      onTarget(event, wrapped);
      return () => {
        offTarget?.(event, wrapped);
      };
    },
    emit: (event, ...args) => {
      const definition = eventDefinition(outbound, event);
      const { values, acknowledgement } = splitWireArguments(definition, args);
      const parsed = definition.args.parse(values);
      if (definition.ack && !acknowledgement) {
        AcknowledgementCallbackSchema.parse(undefined);
      }
      const wireArgs: unknown[] = [...parsed];
      if (definition.ack && acknowledgement) {
        wireArgs.push((value: unknown) => {
          const ack = definition.ack?.safeParse(value);
          if (!ack?.success) {
            if (ack) {
              reportRejected(
                {
                  event,
                  direction: inboundDirection,
                  phase: 'acknowledgement',
                  error: ack.error,
                },
                onRejected,
              );
            }
            return;
          }
          acknowledgement(ack.data);
        });
      }
      emitTarget(event, ...wireArgs);
    },
  };
}
