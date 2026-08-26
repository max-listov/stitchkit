import type { ApplicationHealth } from './schemas';

/**
 * What a resource declares it must start after.
 *
 * A string names the dependency; the resource object *is* the dependency, and
 * that is the form `use()` can type. Both are accepted because ordering and
 * value-passing are separate needs: a resource that only has to start later
 * still says so with a string, and nothing forces a graph to be rewritten.
 */
export type ManagedResourceDependency = string | ManagedResource;

/**
 * What `use()` returns for a resource whose `start` publishes no value.
 *
 * Deliberately a branded interface rather than `never`. `never` is assignable
 * to every type, so reading a value off a resource that never published one
 * would compile everywhere and fail only at runtime — the exact silent shape
 * this whole mechanism exists to remove. The property name is the message: it
 * is what the compiler prints when the assignment is refused.
 */
export interface ManagedResourcePublishesNoValue {
  readonly 'this managed resource publishes no value from start()': never;
}

/**
 * The value a resource's `start` publishes, recovered from its own literal type.
 *
 * Recovered by a conditional type on purpose. The obvious alternative —
 * `use<TValue>(resource: ManagedResource<TValue>): TValue` — is unsound: with
 * no inference site in the argument, TypeScript happily infers `TValue` from
 * the *assignment context*, so `const port: string = context.use(database)`
 * compiles and the annotation becomes self-fulfilling. Reading the type out of
 * `start`'s return leaves the argument as the only source.
 *
 * A resource whose `start` is annotated with the wide
 * `ManagedResourceStartResult` publishes nothing as far as this type is
 * concerned — `value` is optional there, and an optional property cannot be
 * distinguished from an absent one. That is why `managedServerResource` and
 * anything else meant to publish declares a precise return type.
 */
export type ManagedResourcePublished<TResource> = TResource extends {
  start(...args: never): infer TStart;
}
  ? [Extract<Awaited<TStart>, { value: unknown }>] extends [never]
    ? ManagedResourcePublishesNoValue
    : Extract<Awaited<TStart>, { value: unknown }> extends { value: infer TValue }
      ? TValue
      : ManagedResourcePublishesNoValue
  : ManagedResourcePublishesNoValue;

export interface ManagedResourceContext {
  readonly applicationId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt?: number;
  readonly forceDeadlineAt?: number;
  now(): number;
  reportHealth(health: Exclude<ApplicationHealth, 'unknown'>): void;
  /**
   * The value a declared dependency published from its `start`.
   *
   * `dependsOn` carries ordering; this carries the object. Without it every
   * dependency that is a real thing — a connection, a socket server, a client —
   * travels through a module-local `let handle: T | null` whose null guard the
   * graph makes unreachable: the type is lost, the guard is noise, and half the
   * invariant lives in the order of assignments rather than in the graph.
   *
   * Refuses a resource this one did not declare a dependency on, and refuses a
   * resource that published nothing. Both are ordering bugs the graph can see
   * and a mutable module-local cannot.
   */
  use<TResource extends ManagedResource>(
    resource: TResource,
  ): ManagedResourcePublished<TResource>;
}

export interface ManagedResourceStartResult {
  /** Resolves when the resource is ready for dependants. */
  readonly ready?: Promise<void>;
  /** Long-lived completion; settling before shutdown marks the resource unhealthy. */
  readonly completion?: Promise<void>;
  /**
   * What this resource hands to the resources that depend on it.
   *
   * Read with `context.use(thisResource)`. Published once, when `start`
   * resolves, and readable for the rest of the application's life — including
   * from `activate` and the shutdown phases, where a dependant may still need
   * the handle it was given.
   */
  readonly value?: unknown;
}

export interface ManagedResource {
  readonly id: string;
  readonly dependsOn?: readonly ManagedResourceDependency[];
  readonly required?: boolean;
  start(
    context: ManagedResourceContext,
  ):
    | void
    | ManagedResourceStartResult
    | Promise<void>
    | Promise<ManagedResourceStartResult | undefined>;
  /** Runs only after the whole required graph reached readiness. */
  activate?(context: ManagedResourceContext): void | Promise<void>;
  stopAdmission?(context: ManagedResourceContext): void | Promise<void>;
  drain?(context: ManagedResourceContext): void | Promise<void>;
  /** Must be safe after any invoked start, including a rejected partial start. */
  close?(context: ManagedResourceContext): void | Promise<void>;
  force?(context: ManagedResourceContext): void | Promise<void>;
}

/** The id of a dependency declared either way. */
export function managedResourceDependencyId(dependency: ManagedResourceDependency): string {
  return typeof dependency === 'string' ? dependency : dependency.id;
}

export function defineManagedResource<const TResource extends ManagedResource>(
  resource: TResource,
): TResource {
  return resource;
}
