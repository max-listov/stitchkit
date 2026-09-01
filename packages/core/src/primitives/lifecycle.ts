import { type ZodType, z } from 'zod';
import type { DomainEventActor, DomainEventSubject } from './event';

const lifecycleStateBrand: unique symbol = Symbol('stitchkit.lifecycle.state');

export interface LifecycleState<TState extends string> {
  readonly value: TState;
  readonly [lifecycleStateBrand]: true;
}

export interface LifecycleTransitionDefinition<
  TState extends string = string,
  TRole extends string = string,
  TPayload extends ZodType = ZodType,
> {
  readonly from: TState | readonly TState[];
  readonly to: TState;
  readonly by: readonly TRole[];
  readonly payload?: TPayload;
}

export interface LifecycleDefinition<
  TState extends string,
  TRole extends string,
  TTransitions extends Record<string, LifecycleTransitionDefinition<TState, TRole, ZodType>>,
> {
  readonly states: readonly TState[];
  readonly roles: readonly TRole[];
  readonly transitions: TTransitions;
}

export const LifecycleTransitionEventSchema = z.object({
  id: z.string().min(1),
  type: z.literal('lifecycle.transitioned'),
  occurredAt: z.iso.datetime({ offset: true }),
  actor: z.object({ id: z.string().min(1), role: z.string().min(1) }),
  subject: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  payload: z.object({
    lifecycle: z.string().min(1),
    transition: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    data: z.unknown(),
  }),
});
export type LifecycleTransitionEvent = z.infer<typeof LifecycleTransitionEventSchema>;

export type LifecycleTransitionFailure =
  | {
      readonly outcome: 'transition_not_allowed';
      readonly transition: string;
      readonly state: string;
    }
  | {
      readonly outcome: 'role_not_allowed';
      readonly transition: string;
      readonly role: string;
    }
  | {
      readonly outcome: 'invalid_payload';
      readonly transition: string;
      readonly issues: readonly string[];
    };

export type LifecycleTransitionSuccess<TState extends string> = {
  readonly outcome: 'transitioned';
  readonly state: LifecycleState<TState>;
  readonly event: LifecycleTransitionEvent;
};

export type LifecycleTransitionResult<TState extends string> =
  | LifecycleTransitionSuccess<TState>
  | LifecycleTransitionFailure;

export type LifecycleTransitionInput<
  TState extends string,
  TRole extends string,
  TTransition extends string,
  TDefinition extends LifecycleTransitionDefinition<
    TState,
    TRole,
    ZodType
  > = LifecycleTransitionDefinition<TState, TRole, ZodType>,
> = {
  readonly state: LifecycleState<TState>;
  readonly transition: TTransition;
  readonly role: TRole;
  readonly actorId: string;
  readonly subject: DomainEventSubject;
  readonly eventId: string;
  readonly occurredAt: string;
} & (TDefinition extends { readonly payload: infer TPayload extends ZodType }
  ? { readonly payload: z.input<TPayload> }
  : { readonly payload?: never });

function stateMatches<TState extends string>(
  expected: TState | readonly TState[],
  actual: TState,
): boolean {
  return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}

function lifecycleState<TState extends string>(value: TState): LifecycleState<TState> {
  const state: LifecycleState<TState> = { value, [lifecycleStateBrand]: true };
  return Object.freeze(state);
}

/**
 * Declare a finite, synchronous state machine. Persistence remains application-owned;
 * the returned event is the value to commit beside the application's state change.
 */
export function defineLifecycle<
  const TState extends string,
  const TRole extends string,
  const TTransitions extends Record<
    string,
    LifecycleTransitionDefinition<TState, TRole, ZodType>
  >,
>(config: {
  readonly name: string;
  readonly states: readonly TState[];
  readonly roles: readonly TRole[];
  readonly transitions: TTransitions;
}) {
  const definition: LifecycleDefinition<TState, TRole, TTransitions> = config;

  return Object.freeze({
    definition,
    state(value: TState): LifecycleState<TState> {
      if (!config.states.includes(value)) {
        throw new Error(`[stitchkit] lifecycle "${config.name}" received an unknown state`);
      }
      return lifecycleState(value);
    },
    availableTransitions(state: LifecycleState<TState>, role: TRole): readonly string[] {
      return Object.entries(config.transitions)
        .filter(
          ([, transition]) =>
            stateMatches(transition.from, state.value) && transition.by.includes(role),
        )
        .map(([name]) => name);
    },
    transition<TName extends keyof TTransitions & string>(
      input: LifecycleTransitionInput<TState, TRole, TName, TTransitions[TName]>,
    ): LifecycleTransitionResult<TState> {
      const transition = config.transitions[input.transition];
      if (!transition) {
        return {
          outcome: 'transition_not_allowed',
          transition: input.transition,
          state: input.state.value,
        };
      }
      if (!stateMatches(transition.from, input.state.value)) {
        return {
          outcome: 'transition_not_allowed',
          transition: input.transition,
          state: input.state.value,
        };
      }
      if (!transition.by.includes(input.role)) {
        return {
          outcome: 'role_not_allowed',
          transition: input.transition,
          role: input.role,
        };
      }
      const parsedPayload = transition.payload?.safeParse(input.payload);
      if (parsedPayload && !parsedPayload.success) {
        return {
          outcome: 'invalid_payload',
          transition: input.transition,
          issues: parsedPayload.error.issues.map((issue) => issue.message),
        };
      }
      const actor: DomainEventActor = { id: input.actorId, role: input.role };
      const event = LifecycleTransitionEventSchema.parse({
        id: input.eventId,
        type: 'lifecycle.transitioned',
        occurredAt: input.occurredAt,
        actor,
        subject: input.subject,
        payload: {
          lifecycle: config.name,
          transition: input.transition,
          from: input.state.value,
          to: transition.to,
          data: parsedPayload?.data ?? input.payload,
        },
      });
      return {
        outcome: 'transitioned',
        state: lifecycleState(transition.to),
        event,
      };
    },
  });
}
