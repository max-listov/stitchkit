import type { z } from 'zod';
import type { StitchLogger } from '../logger';
import type {
  RealtimeEmitArguments,
  RealtimeEventDefinition,
  RealtimeEventHandler,
  RealtimeEventRegistry,
  RealtimeRejectDirection,
  RealtimeRejectedEvent,
  RealtimeRejectedEventHook,
} from './contract';
import { realtimeContractViolation } from './rejection';
import { RealtimeRequestInvalidAcknowledgementError } from './request';

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
  logger?: StitchLogger;
  subscribe?: (event: string, handler: (...args: unknown[]) => void) => () => void;
}

/** Runtime target forms supported by the realtime adapter and their required capabilities. */
export const REALTIME_TARGET_FORMS = [
  { name: 'Server', capabilities: ['on', 'off', 'emit'] },
  { name: 'Socket', capabilities: ['on', 'off', 'emit'] },
  { name: 'BroadcastOperator', capabilities: ['emit'] },
] satisfies ReadonlyArray<{
  name: 'Server' | 'Socket' | 'BroadcastOperator';
  capabilities: ReadonlyArray<'on' | 'off' | 'emit'>;
}>;

export interface ValidatedRealtimeSocket<
  TInbound extends RealtimeEventRegistry,
  TOutbound extends RealtimeEventRegistry,
> {
  on<TEvent extends keyof TInbound & string>(
    event: TEvent,
    handler: RealtimeEventHandler<TInbound[TEvent]>,
  ): () => void;
  /**
   * Emit a validated event. Three outcomes, in order: a local contract
   * violation **throws** (validation runs even while disconnected); an emit a
   * disconnected browser transport drops returns `false`; otherwise `true` —
   * accepted by the transport, which is not a delivery guarantee. Server
   * targets always return `true` (an empty room is not a drop).
   */
  emit<TEvent extends keyof TOutbound & string>(
    event: TEvent,
    ...args: RealtimeEmitArguments<TOutbound[TEvent]>
  ): boolean;
}

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
  direction: RealtimeRejectDirection,
): RealtimeEventDefinition {
  const definition = registry[event];
  if (!definition) {
    throw realtimeContractViolation({
      event,
      direction,
      phase: 'arguments',
      reason: 'unknown-event',
      fault: 'local',
    }).error;
  }
  return definition;
}

function reportRejected(
  rejected: RealtimeRejectedEvent,
  hook: RealtimeRejectedEventHook | undefined,
  logger: StitchLogger | undefined,
): void {
  if (!hook) {
    if (logger) {
      logger.warn(rejected.error.message, rejected.error.details);
      return;
    }
    console.warn(
      `[stitchkit] rejected realtime ${rejected.direction} event "${rejected.event}" (${rejected.phase})`,
      rejected.error,
    );
    return;
  }
  void Promise.resolve(hook(rejected)).catch((error) => {
    console.error('[stitchkit] realtime rejection hook failed', error);
  });
}

export function parseRealtimeRequestArguments(
  registry: RealtimeEventRegistry,
  event: string,
  direction: RealtimeRejectDirection,
  args: unknown[],
): unknown[] {
  const definition = eventDefinition(registry, event, direction);
  const parsed = definition.args.safeParse(args);
  if (!parsed.success) {
    throw realtimeContractViolation({
      event,
      direction,
      phase: 'arguments',
      reason: 'invalid-arguments',
      fault: 'local',
      cause: parsed.error,
    }).error;
  }
  if (!definition.ack) {
    throw realtimeContractViolation({
      event,
      direction,
      phase: 'acknowledgement',
      reason: 'missing-acknowledgement',
      fault: 'local',
    }).error;
  }
  return parsed.data;
}

export function parseRealtimeRequestAcknowledgement<TAck extends z.ZodType>(
  schema: TAck,
  event: string,
  direction: RealtimeRejectDirection,
  value: unknown,
  hook: RealtimeRejectedEventHook | undefined,
  logger: StitchLogger | undefined,
): z.output<TAck> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const rejected = realtimeContractViolation({
    event,
    direction,
    phase: 'acknowledgement',
    reason: 'invalid-acknowledgement-value',
    fault: 'peer',
    cause: parsed.error,
  });
  reportRejected(rejected, hook, logger);
  throw new RealtimeRequestInvalidAcknowledgementError(event, rejected.error);
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
  logger,
  subscribe,
}: ValidatedRealtimeSocketOptions<TInbound, TOutbound>): ValidatedRealtimeSocket<
  TInbound,
  TOutbound
> {
  const emitTarget = method(target, 'emit');

  return {
    on: (event, handler) => {
      const definition = eventDefinition(inbound, event, inboundDirection);
      const wrapped = (...wireArgs: unknown[]) => {
        const { values, acknowledgement } = splitWireArguments(definition, wireArgs);
        const parsed = definition.args.safeParse(values);
        if (!parsed.success) {
          reportRejected(
            realtimeContractViolation({
              event,
              direction: inboundDirection,
              phase: 'arguments',
              reason: 'invalid-arguments',
              fault: 'peer',
              cause: parsed.error,
            }),
            onRejected,
            logger,
          );
          return;
        }
        if (definition.ack && !acknowledgement) {
          reportRejected(
            realtimeContractViolation({
              event,
              direction: inboundDirection,
              phase: 'acknowledgement',
              reason: 'missing-acknowledgement',
              fault: 'peer',
            }),
            onRejected,
            logger,
          );
          return;
        }
        const applicationArgs: unknown[] = [...parsed.data];
        if (definition.ack) {
          applicationArgs.push((value: unknown) => {
            const ack = definition.ack?.safeParse(value);
            if (!ack?.success) {
              if (ack) {
                reportRejected(
                  realtimeContractViolation({
                    event,
                    direction: outboundDirection,
                    phase: 'acknowledgement',
                    reason: 'invalid-acknowledgement-value',
                    fault: 'local',
                    cause: ack.error,
                  }),
                  onRejected,
                  logger,
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
      const onTarget = method(target, 'on');
      const offTarget = method(target, 'off');
      onTarget(event, wrapped);
      return () => {
        offTarget(event, wrapped);
      };
    },
    emit: (event, ...args) => {
      const definition = eventDefinition(outbound, event, outboundDirection);
      const { values, acknowledgement } = splitWireArguments(definition, args);
      const parsed = definition.args.safeParse(values);
      if (!parsed.success) {
        throw realtimeContractViolation({
          event,
          direction: outboundDirection,
          phase: 'arguments',
          reason: 'invalid-arguments',
          fault: 'local',
          cause: parsed.error,
        }).error;
      }
      if (definition.ack && !acknowledgement) {
        throw realtimeContractViolation({
          event,
          direction: outboundDirection,
          phase: 'acknowledgement',
          reason: 'missing-acknowledgement',
          fault: 'local',
        }).error;
      }
      const wireArgs: unknown[] = [...parsed.data];
      if (definition.ack && acknowledgement) {
        wireArgs.push((value: unknown) => {
          const ack = definition.ack?.safeParse(value);
          if (!ack?.success) {
            if (ack) {
              reportRejected(
                realtimeContractViolation({
                  event,
                  direction: inboundDirection,
                  phase: 'acknowledgement',
                  reason: 'invalid-acknowledgement-value',
                  fault: 'peer',
                  cause: ack.error,
                }),
                onRejected,
                logger,
              );
            }
            return;
          }
          acknowledgement(ack.data);
        });
      }
      // "Accepted by the transport", not "delivered": socket.io server
      // targets return `true` (an empty room is not a drop), duck-typed test
      // targets return `undefined` → `true`; only the stitchkit browser
      // transport reports an explicit `false` for an emit dropped while
      // disconnected.
      return emitTarget(event, ...wireArgs) !== false;
    },
  };
}
