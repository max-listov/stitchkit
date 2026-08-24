import type { ApplicationHealth } from './schemas';

export interface ManagedResourceContext {
  readonly applicationId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt?: number;
  readonly forceDeadlineAt?: number;
  now(): number;
  reportHealth(health: Exclude<ApplicationHealth, 'unknown'>): void;
}

export interface ManagedResourceStartResult {
  /** Resolves when the resource is ready for dependants. */
  readonly ready?: Promise<void>;
  /** Long-lived completion; settling before shutdown marks the resource unhealthy. */
  readonly completion?: Promise<void>;
}

export interface ManagedResource {
  readonly id: string;
  readonly dependsOn?: readonly string[];
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

export function defineManagedResource<const TResource extends ManagedResource>(
  resource: TResource,
): TResource {
  return resource;
}
