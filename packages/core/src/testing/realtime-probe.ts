import type { RealtimeRejectedEvent, RealtimeRejectedEventHook } from '../realtime/contract';
import {
  RealtimeRequestDisconnectedError,
  RealtimeRequestInvalidAcknowledgementError,
  RealtimeRequestTimeoutError,
} from '../realtime/request';

import {
  type RealtimeRejectionObservation,
  RealtimeRejectionObservationSchema,
  type SurfaceProbe,
  type SurfaceProbeDriver,
  type TransportObservation,
  TransportObservationSchema,
} from './surface-conformance';

export type RealtimeProbeScenario =
  | 'event'
  | 'acknowledgement'
  | 'invalid_arguments'
  | 'invalid_acknowledgement'
  | 'peer_rejection'
  | 'disconnected'
  | 'in_flight_disconnect'
  | 'timeout';

export interface RealtimeProbeFixture<TFixture> {
  scenario: RealtimeProbeScenario;
  value: TFixture;
}

export interface DefineRealtimeProbeConfig<TFixture> {
  name: string;
  scenario: RealtimeProbeScenario;
  fixture: TFixture;
  expected: TransportObservation;
  setup?: (signal: AbortSignal) => void | Promise<void>;
  teardown?: (signal: AbortSignal) => void | Promise<void>;
}

export interface RealtimeProbeAdapter<TFixture> {
  /** Observe the bound transport immediately before invocation. */
  connected: () => boolean;
  invoke: (
    fixture: RealtimeProbeFixture<TFixture>,
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
  /** Remove probe-owned subscriptions; never disconnects the foreign transport. */
  dispose?: () => void | Promise<void>;
}

export interface CreateRealtimeProbeDriverConfig<TFixture> {
  /** Bind the caller-owned transport and route its canonical rejection hook here. */
  bind: (
    onRejected: RealtimeRejectedEventHook,
    fixture: RealtimeProbeFixture<TFixture>,
  ) => RealtimeProbeAdapter<TFixture>;
  /** Optional application-handler counter used to prove rejected packets were not admitted. */
  handlerCalls?: () => number;
}

function scenarioOutcome(scenario: RealtimeProbeScenario): TransportObservation['outcome'] {
  if (scenario === 'event' || scenario === 'acknowledgement') return 'success';
  if (
    scenario === 'invalid_arguments' ||
    scenario === 'invalid_acknowledgement' ||
    scenario === 'peer_rejection'
  ) {
    return 'realtime_rejected';
  }
  if (scenario === 'disconnected' || scenario === 'in_flight_disconnect') {
    return 'disconnected';
  }
  return 'timeout';
}

function assertScenarioExpectation(
  scenario: RealtimeProbeScenario,
  expected: TransportObservation,
): void {
  const outcome = scenarioOutcome(scenario);
  if (expected.outcome !== outcome) {
    throw new TypeError(`Realtime probe scenario "${scenario}" requires outcome "${outcome}"`);
  }
  if (
    expected.outcome === 'realtime_rejected' &&
    ((scenario === 'invalid_arguments' && expected.rejection.phase !== 'arguments') ||
      (scenario === 'invalid_acknowledgement' &&
        expected.rejection.phase !== 'acknowledgement'))
  ) {
    throw new TypeError(
      `Realtime probe scenario "${scenario}" has incompatible rejection phase`,
    );
  }
  if (scenario === 'invalid_arguments' && expected.handlerCalls !== 0) {
    throw new TypeError(
      'Realtime probe scenario "invalid_arguments" requires handlerCalls: 0',
    );
  }
  if (
    scenario === 'peer_rejection' &&
    (expected.outcome !== 'realtime_rejected' ||
      expected.rejection.reason !== 'rejected-by-peer')
  ) {
    throw new TypeError(
      'Realtime probe scenario "peer_rejection" requires a rejected-by-peer outcome',
    );
  }
  if (expected.outcome === 'disconnected') {
    const phase = scenario === 'disconnected' ? 'before-invoke' : 'in-flight';
    if (expected.disconnect.phase !== phase) {
      throw new TypeError(
        `Realtime probe scenario "${scenario}" requires disconnect phase "${phase}"`,
      );
    }
  }
}

/** Declare one explicit realtime scenario for the caller's real transport driver. */
export function defineRealtimeProbe<TFixture>(
  config: DefineRealtimeProbeConfig<TFixture>,
): SurfaceProbe<RealtimeProbeFixture<TFixture>> {
  const expected = TransportObservationSchema.parse(config.expected);
  assertScenarioExpectation(config.scenario, expected);
  return {
    name: config.name,
    fixture: { scenario: config.scenario, value: config.fixture },
    transports: ['REALTIME'],
    expected: { REALTIME: expected },
    setup: config.setup,
    teardown: config.teardown,
  };
}

function rejectionObservation(rejected: RealtimeRejectedEvent): RealtimeRejectionObservation {
  return RealtimeRejectionObservationSchema.parse(rejected);
}

/** Normalize real bound-transport behavior without owning its connection lifecycle. */
export function createRealtimeProbeDriver<TFixture>({
  bind,
  handlerCalls,
}: CreateRealtimeProbeDriverConfig<TFixture>): SurfaceProbeDriver<
  RealtimeProbeFixture<TFixture>
> {
  return {
    async invoke(fixture, signal) {
      let rejected: RealtimeRejectedEvent | undefined;
      const currentRejection = (): RealtimeRejectedEvent | undefined => rejected;
      const adapter = bind((event) => {
        rejected = event;
      }, fixture);
      const connectedBefore = adapter.connected();
      const callsBefore = handlerCalls?.();
      const withCalls = (observation: TransportObservation): TransportObservation => {
        if (callsBefore === undefined || !handlerCalls) return observation;
        return { ...observation, handlerCalls: handlerCalls() - callsBefore };
      };
      try {
        signal.throwIfAborted();
        const data = await adapter.invoke(fixture, signal);
        const observedRejection = currentRejection();
        if (observedRejection) {
          return withCalls({
            outcome: 'realtime_rejected',
            code: observedRejection.error.code,
            rejection: rejectionObservation(observedRejection),
          });
        }
        return withCalls({
          outcome: 'success',
          ...(data !== undefined && { data }),
        });
      } catch (error) {
        const observedRejection = currentRejection();
        if (observedRejection) {
          return withCalls({
            outcome: 'realtime_rejected',
            code:
              error instanceof RealtimeRequestInvalidAcknowledgementError
                ? error.code
                : observedRejection.error.code,
            rejection: rejectionObservation(observedRejection),
          });
        }
        if (error instanceof RealtimeRequestInvalidAcknowledgementError) {
          return withCalls({
            outcome: 'realtime_rejected',
            code: error.code,
            rejection: {
              direction: 'client-inbound',
              phase: 'acknowledgement',
              reason: 'invalid-acknowledgement-value',
              fault: 'peer',
            },
          });
        }
        if (error instanceof RealtimeRequestDisconnectedError) {
          return withCalls({
            outcome: 'disconnected',
            code: error.code,
            disconnect: {
              phase: connectedBefore ? 'in-flight' : 'before-invoke',
            },
          });
        }
        if (error instanceof RealtimeRequestTimeoutError) {
          return withCalls({ outcome: 'timeout', code: error.code });
        }
        if (signal.aborted && error === signal.reason) {
          return withCalls({ outcome: 'aborted' });
        }
        const parsedRejection = RealtimeRejectionObservationSchema.safeParse(
          typeof error === 'object' && error !== null && 'details' in error
            ? error.details
            : undefined,
        );
        if (parsedRejection.success) {
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'REALTIME_CONTRACT_VIOLATION';
          return withCalls({
            outcome: 'realtime_rejected',
            code,
            rejection: parsedRejection.data,
          });
        }
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined;
        return withCalls({
          outcome: 'domain_error',
          ...(code !== undefined && { code }),
          diagnostic: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await adapter.dispose?.();
      }
    },
  };
}
