/**
 * An event declaration beside the operation contract.
 *
 * `defineContract` says what a caller may *ask*. This says what the server may
 * *announce*: a topic, the schema of its one payload, and how it is delivered
 * to listeners in this process. One declaration, so a topic cannot be published
 * in one shape and parsed in another — the failure `defineContract` exists to
 * make impossible for requests, made impossible for announcements too.
 *
 * **This is a declaration, not a transport.** The wire is the Socket.IO realtime
 * contract stitchkit already ships: {@link toRealtimeContract} projects this
 * declaration onto `RealtimeContract`, and `bindRealtimeServer` /
 * `bindRealtimeClient` carry it with the validation, rejection reporting and
 * room semantics they already have. There is no second socket, no second
 * validator and no second `on()`. That is deliberate and it is the whole point:
 * ADR 0009 records a hand-rolled event stack in this repository that reached
 * about 700 lines, was never adopted by a single consumer, and was deleted —
 * with the lesson written into ADR 0008 as *wrap the transport the consumers
 * already run on*. This declaration does not reopen that decision.
 *
 * → ADR 0150.
 */
import { z } from 'zod';
import type { UndecidedOutcome } from '../internal/decision';
import type { RealtimeContract, RealtimeEventRegistry } from '../realtime/contract';

/**
 * How a topic reaches the listeners registered for it **in this process**.
 *
 * Delivery to remote subscribers is always observation: a browser cannot delay
 * or veto a server's announcement, so the mode says nothing about the wire. It
 * says what the *server's own* listeners may do.
 *
 * - `emit` — announce and continue. Listeners run concurrently, a failing one
 *   is isolated from the others, and the caller does not wait.
 * - `serial` — listeners run one at a time, in registration order, and the
 *   caller waits for all of them. For work whose order is the point.
 * - `decision` — listeners vote. Each returns `allow`, `deny` with a reason, or
 *   `defer`; the first `deny` wins and the rest are not consulted.
 */
export type EventDeliveryMode = 'emit' | 'serial' | 'decision';

/**
 * One listener's vote on a `decision` topic — the framework's one decision
 * vocabulary, shared with the policy pipeline in `stitchkit/application`.
 *
 * `defer` is a real answer — "not my call" — and it is distinct from `allow` on
 * purpose: an event where every listener defers is one nobody claimed, and what
 * should happen then is a policy the topic has to state rather than a default
 * somebody guesses. See `whenAllDefer`. (A policy pipeline treats that ending
 * as a defect instead, because an operation nothing decided cannot be answered
 * either way; same words, different mechanisms, and each says which it is.)
 */
export type { PolicyDecision, UndecidedOutcome } from '../internal/decision';

export interface EventTopicDeclaration<TSchema extends z.ZodType = z.ZodType> {
  /** The payload schema. One payload per topic — a topic is not a function call. */
  readonly schema: TSchema;
  readonly mode: EventDeliveryMode;
  /**
   * Required on a `decision` topic, refused on any other.
   *
   * There is no default, and that is the point: whichever value were chosen as
   * the default would be a standing `allow` or a standing `deny` applied to
   * every topic whose author never thought about it. Both are decisions; a
   * default makes them silently.
   */
  readonly whenAllDefer?: UndecidedOutcome;
  /**
   * How long one listener may take on a `serial` or `decision` topic before the
   * dispatcher stops waiting for it, in milliseconds.
   *
   * Required on those two modes, refused on `emit` (which never waits). A
   * listener that never settles would otherwise hang the caller forever, and a
   * caller hanging forever is indistinguishable from a caller doing work.
   * A `decision` listener that runs out of time votes `deny` — a vote that
   * never arrived cannot be read as consent.
   */
  readonly listenerTimeoutMs?: number;
}

export type EventTopicRegistry = Record<string, EventTopicDeclaration>;

export interface EventsConfig {
  /**
   * Prefixed onto every topic name, separated by a dot.
   *
   * The prefixed form is the **only** name the topic has: it is the key of the
   * declaration's `topics`, the event name on the wire, and the string passed to
   * `on`. The short key in the literal is where the full name is built, not a
   * second name for the same topic — a topic addressable two ways is a topic
   * that will be published one way and subscribed the other.
   */
  readonly prefix?: string;
}

/** The wire name of a topic: `prefix.name`, or just `name` when no prefix is declared. */
export type WireTopic<TPrefix, TName extends string> = TPrefix extends string
  ? `${TPrefix}.${TName}`
  : TName;

export interface EventsDeclaration<
  TPrefix extends string | undefined,
  TTopics extends EventTopicRegistry,
> {
  readonly prefix: TPrefix;
  /** Keyed by wire topic — see {@link EventsConfig.prefix}. */
  readonly topics: {
    readonly [TName in keyof TTopics & string as WireTopic<TPrefix, TName>]: TTopics[TName];
  };
}

/** The payload type of each topic, keyed by its wire name. */
export type EventPayloads<TDeclaration> =
  TDeclaration extends EventsDeclaration<infer _TPrefix, infer _TTopics>
    ? {
        [TTopic in keyof TDeclaration['topics']]: TDeclaration['topics'][TTopic] extends {
          schema: infer TSchema extends z.ZodType;
        }
          ? z.output<TSchema>
          : never;
      }
    : never;

/** Topics of one declaration whose declared mode is `TMode`. */
export type EventTopicsOfMode<TDeclaration, TMode extends EventDeliveryMode> =
  TDeclaration extends EventsDeclaration<infer _TPrefix, infer _TTopics>
    ? {
        [TTopic in keyof TDeclaration['topics']]: TDeclaration['topics'][TTopic] extends {
          mode: TMode;
        }
          ? TTopic
          : never;
      }[keyof TDeclaration['topics']] &
        string
    : never;

/** A topic name may not be empty and may not carry whitespace or a wire separator of its own. */
function assertName(kind: 'prefix' | 'topic', value: string): void {
  if (value.length === 0) {
    throw new Error(`[stitchkit] defineEvents: ${kind} name cannot be empty.`);
  }
  if (/\s/.test(value)) {
    throw new Error(
      `[stitchkit] defineEvents: ${kind} name "${value}" cannot contain whitespace.`,
    );
  }
}

/**
 * Declare a set of topics.
 *
 * ```ts
 * const events = defineEvents(
 *   { prefix: 'notes' },
 *   {
 *     'changed': { schema: z.object({ folder: z.string() }), mode: 'emit' },
 *     'archiving': {
 *       schema: z.object({ folder: z.string() }),
 *       mode: 'decision',
 *       whenAllDefer: 'allow',
 *       listenerTimeoutMs: 2_000,
 *     },
 *   },
 * );
 * // events.topics has the keys 'notes.changed' and 'notes.archiving'
 * ```
 */
export function defineEvents<
  const TConfig extends EventsConfig,
  const TTopics extends EventTopicRegistry,
>(
  config: TConfig,
  topics: TTopics,
): EventsDeclaration<
  TConfig extends { prefix: infer TPrefix extends string } ? TPrefix : undefined,
  TTopics
> {
  const prefix = config.prefix;
  if (prefix !== undefined) assertName('prefix', prefix);

  const declared: Record<string, EventTopicDeclaration> = {};
  for (const [name, topic] of Object.entries(topics)) {
    assertName('topic', name);
    // A mode that waits has to say how long. `emit` never waits, so a timeout on
    // it would be a number nothing reads — the kind of declared-but-inert option
    // that reads as configuration and is not.
    if (topic.mode === 'emit') {
      if (topic.whenAllDefer !== undefined) {
        throw new Error(
          `[stitchkit] defineEvents: topic "${name}" declares whenAllDefer, which only a 'decision' topic has. Its mode is 'emit'.`,
        );
      }
      if (topic.listenerTimeoutMs !== undefined) {
        throw new Error(
          `[stitchkit] defineEvents: topic "${name}" declares listenerTimeoutMs, but mode 'emit' never waits for a listener.`,
        );
      }
    } else {
      if (topic.listenerTimeoutMs === undefined) {
        throw new Error(
          `[stitchkit] defineEvents: topic "${name}" has mode '${topic.mode}', which waits for listeners, so it must declare listenerTimeoutMs.`,
        );
      }
      if (!Number.isFinite(topic.listenerTimeoutMs) || topic.listenerTimeoutMs <= 0) {
        throw new Error(
          `[stitchkit] defineEvents: topic "${name}" declares listenerTimeoutMs ${String(topic.listenerTimeoutMs)}; it must be finite and greater than zero.`,
        );
      }
      if (topic.mode === 'decision' && topic.whenAllDefer === undefined) {
        throw new Error(
          `[stitchkit] defineEvents: topic "${name}" has mode 'decision', so it must declare whenAllDefer: 'allow' or 'deny' — the outcome when every listener defers. There is no default, because a default would decide it silently.`,
        );
      }
      if (topic.mode === 'serial' && topic.whenAllDefer !== undefined) {
        throw new Error(
          `[stitchkit] defineEvents: topic "${name}" declares whenAllDefer, which only a 'decision' topic has. Its mode is 'serial'.`,
        );
      }
    }
    declared[prefix === undefined ? name : `${prefix}.${name}`] = topic;
  }

  return { prefix, topics: declared } as EventsDeclaration<
    TConfig extends { prefix: infer TPrefix extends string } ? TPrefix : undefined,
    TTopics
  >;
}

/**
 * Project a declaration onto the realtime contract, so the existing validated
 * socket carries it.
 *
 * A realtime event's `args` is the **tuple of wire arguments**, not a payload,
 * so a one-payload topic becomes a one-element tuple. That single mapping is the
 * only place the two shapes meet, and it is why a test that binds one
 * declaration to both ends proves less than it looks: both ends would project
 * identically, so a wrong projection stays invisible. The test that measures it
 * injects a raw frame past the validating wrapper.
 *
 * Announcements travel server → client. `clientToServer` is empty by
 * construction: a client that could publish a server's topic would make the
 * declared publisher a suggestion.
 */
export function toRealtimeContract<
  TPrefix extends string | undefined,
  TTopics extends EventTopicRegistry,
>(
  declaration: EventsDeclaration<TPrefix, TTopics>,
): RealtimeContract<RealtimeEventRegistry, Record<string, never>> {
  const serverToClient: RealtimeEventRegistry = {};
  for (const [topic, definition] of Object.entries(declaration.topics)) {
    const schema = (definition as EventTopicDeclaration).schema;
    // A realtime event carries a tuple of wire arguments; one payload is a
    // one-element tuple.
    serverToClient[topic] = { args: z.tuple([schema]) as unknown as z.ZodType<unknown[]> };
  }
  return { serverToClient, clientToServer: {} };
}
