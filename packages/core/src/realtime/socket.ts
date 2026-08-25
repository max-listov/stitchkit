import type { z } from 'zod';
import { zodIssues } from '../internal/errors';
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
import {
  asRealtimeRejection,
  MAX_REJECTION_ISSUES,
  type RealtimeRejectionReport,
  realtimeRejectionEnvelope,
} from './rejected-frame';
import { realtimeContractViolation } from './rejection';
import {
  RealtimeRequestInvalidAcknowledgementError,
  RealtimeRequestRejectedError,
} from './request';

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

/**
 * The payload, the acknowledgement, and the back-channel — which are not the
 * same thing.
 *
 * `acknowledgement` is the contract's: it exists only when THIS side's
 * definition declares an `ack`, and only it is handed to the application.
 *
 * `replyTo` is the callback that is physically on the wire, whether or not this
 * side's contract knows about it. The two diverge in a version skew that is
 * completely ordinary: a sender on a newer contract, where the event has gained
 * an acknowledgement, talking to a receiver whose copy has not. Reading the
 * callback only through `definition.ack` meant the frame was refused — the
 * callback lands in `values`, so the tuple fails on arity — and then the refusal
 * had nowhere to go, so the sender waited out its deadline and reported a
 * timeout. That is the exact failure this whole mechanism exists to remove,
 * arriving through the exact door it was built for.
 *
 * `values` is deliberately left alone when this side has no `ack`: the frame is
 * a contract violation either way, and quietly re-interpreting an argument list
 * would change what handlers receive for the sake of a case that is already
 * being refused.
 */
function splitWireArguments(
  definition: RealtimeEventDefinition,
  args: unknown[],
): {
  values: unknown[];
  acknowledgement?: (...args: unknown[]) => unknown;
  replyTo?: (...args: unknown[]) => unknown;
} {
  const trailing = args.at(-1);
  const replyTo =
    typeof trailing === 'function'
      ? (...callbackArgs: unknown[]) => Reflect.apply(trailing, undefined, callbackArgs)
      : undefined;
  if (!definition.ack || !replyTo) return { values: args, ...(replyTo && { replyTo }) };
  return { values: args.slice(0, -1), acknowledgement: replyTo, replyTo };
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

/**
 * Send a refusal back, when there is somewhere to send it.
 *
 * Deliberately best-effort: the callback belongs to the peer's transport and a
 * throw from it must not turn a rejected frame into a broken subscription.
 */
function answerWithRejection(
  acknowledgement: ((...args: unknown[]) => unknown) | undefined,
  report: RealtimeRejectionReport,
  logger: StitchLogger | undefined,
): void {
  if (!acknowledgement) return;
  try {
    acknowledgement(realtimeRejectionEnvelope(report));
  } catch (error) {
    // The configured logger, like every other diagnostic on this path. Going
    // straight to `console` loses it for a consumer with structured logging.
    const message = '[stitchkit] could not answer a rejected realtime frame';
    if (logger) logger.warn(message, { error });
    else console.warn(message, error);
  }
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
  // Before the schema, not after: a refusal is delivered ON the acknowledgement
  // channel, and parsing it against the application's ack schema would report
  // "the peer answered with something invalid" — which is true of the bytes and
  // false about what happened.
  const refusal = asRealtimeRejection(value);
  if (refusal) {
    reportRejected(
      realtimeContractViolation({
        event,
        direction,
        phase: 'arguments',
        reason: 'rejected-by-peer',
        fault: 'local',
      }),
      hook,
      logger,
    );
    throw new RealtimeRequestRejectedError(
      event,
      refusal.reason,
      refusal.message,
      refusal.issues,
    );
  }
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
        const { values, acknowledgement, replyTo } = splitWireArguments(definition, wireArgs);
        const parsed = definition.args.safeParse(values);
        if (!parsed.success) {
          const rejected = realtimeContractViolation({
            event,
            direction: inboundDirection,
            phase: 'arguments',
            reason: 'invalid-arguments',
            fault: 'peer',
            cause: parsed.error,
          });
          reportRejected(rejected, onRejected, logger);
          // Answered, not dropped. The acknowledgement callback is the one
          // back-channel that already exists, and using it is what turns a
          // version skew from "healthy machines, unexplained timeouts" into a
          // refusal the sender can read. A fire-and-forget event has no such
          // channel and is still only reported locally.
          // `replyTo`, not `acknowledgement`: the back-channel is whatever is on
          // the wire, and in a sender-first rollout this side's contract does
          // not know the event has one.
          answerWithRejection(
            replyTo,
            {
              event,
              reason: 'invalid-arguments',
              message: rejected.error.message,
              // Straight from the Zod error rather than dug back out of the
              // AppError's details: the same flattening every other Stitchkit
              // surface uses, typed on the way out.
              // Capped where the envelope is BUILT, not only where it is read.
              // The reader's cap protected this side from a large refusal; it did
              // nothing about sending one, and the size of what we send is chosen
              // by whoever sent us the bad frame — fifty malformed array entries
              // produced fifty issues on the wire.
              issues: zodIssues(parsed.error).slice(0, MAX_REJECTION_ISSUES),
            },
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
          // A refusal arrives on this channel too — `emit(..., callback)` is the
          // same wire as `request()`. Reporting it as "invalid acknowledgement
          // value" would be accurate about the bytes and wrong about the event.
          const refusal = asRealtimeRejection(value);
          if (refusal) {
            reportRejected(
              realtimeContractViolation({
                event,
                direction: outboundDirection,
                phase: 'arguments',
                reason: 'rejected-by-peer',
                fault: 'local',
              }),
              onRejected,
              logger,
            );
            return;
          }
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
