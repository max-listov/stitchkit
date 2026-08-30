import { z } from 'zod';
import {
  RealtimeRejectDirectionSchema,
  type RealtimeRejectedEvent,
  type RealtimeRejectedEventHook,
  RealtimeRejectFaultSchema,
  RealtimeRejectPhaseSchema,
  RealtimeRejectReasonSchema,
} from '../realtime/contract';
import {
  RealtimeRequestDisconnectedError,
  RealtimeRequestInvalidAcknowledgementError,
  RealtimeRequestTimeoutError,
} from '../realtime/request';
import type { OpenApiDocument } from '../server/openapi';
import { type SurfaceManifest, serializeSurfaceValue } from './surface-manifest';

export const RealtimeRejectionObservationSchema = z.object({
  direction: RealtimeRejectDirectionSchema,
  phase: RealtimeRejectPhaseSchema,
  reason: RealtimeRejectReasonSchema,
  fault: RealtimeRejectFaultSchema,
});

const ObservationFields = {
  code: z.string().optional(),
  data: z.unknown().optional(),
  diagnostic: z.string().optional(),
  handlerCalls: z.number().int().nonnegative().optional(),
};

export const RealtimeDisconnectObservationSchema = z.object({
  phase: z.enum(['before-invoke', 'in-flight']),
});

export const TransportObservationSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('success'), ...ObservationFields }),
  z.object({ outcome: z.literal('validation_error'), ...ObservationFields }),
  z.object({ outcome: z.literal('domain_error'), ...ObservationFields }),
  z.object({ outcome: z.literal('aborted'), ...ObservationFields }),
  z.object({
    outcome: z.literal('realtime_rejected'),
    ...ObservationFields,
    rejection: RealtimeRejectionObservationSchema,
  }),
  z.object({
    outcome: z.literal('disconnected'),
    ...ObservationFields,
    disconnect: RealtimeDisconnectObservationSchema,
  }),
  z.object({ outcome: z.literal('timeout'), ...ObservationFields }),
]);

export type RealtimeRejectionObservation = z.infer<typeof RealtimeRejectionObservationSchema>;
export type RealtimeDisconnectObservation = z.infer<
  typeof RealtimeDisconnectObservationSchema
>;
export type TransportObservation = z.infer<typeof TransportObservationSchema>;
export type ConformanceTransport = 'HTTP' | 'MCP' | 'AGENT' | 'CLI' | 'REALTIME';

export interface SurfaceProbe<TFixture = unknown> {
  name: string;
  fixture: TFixture;
  transports: readonly ConformanceTransport[];
  expected: Partial<Record<ConformanceTransport, TransportObservation>>;
  setup?: (signal: AbortSignal) => void | Promise<void>;
  teardown?: (signal: AbortSignal) => void | Promise<void>;
}

export interface SurfaceProbeDriver<TFixture = unknown> {
  invoke: (fixture: TFixture, signal: AbortSignal) => Promise<TransportObservation>;
}

export interface RunSurfaceProbesConfig<TFixture = unknown> {
  probes: readonly SurfaceProbe<TFixture>[];
  drivers: Partial<Record<ConformanceTransport, SurfaceProbeDriver<TFixture>>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxDiagnosticBytes?: number;
}

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

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function assertSameSet(
  label: string,
  expectedValues: Iterable<string>,
  actualValues: Iterable<string>,
): void {
  const expected = sorted(expectedValues);
  const actual = sorted(actualValues);
  if (serializeSurfaceValue(expected) === serializeSurfaceValue(actual)) return;
  throw new Error(
    `${label} mismatch\nexpected: ${expected.join(', ') || '(empty)'}\nactual: ${actual.join(', ') || '(empty)'}`,
  );
}

function openApiOperations(document: Pick<OpenApiDocument, 'paths'>): string[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => ['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method))
      .map((method) => `${method.toUpperCase()}:${path}`),
  );
}

function expectedToolNames(
  manifest: SurfaceManifest,
  transport: 'MCP' | 'AGENT' | 'CLI',
  surface: string | null,
): string[] {
  const projection = manifest.toolSurfaces.find(
    (candidate) => candidate.transport === transport && candidate.surface === surface,
  );
  if (!projection) {
    throw new Error(
      `${transport} surface "${surface ?? '(default)'}" is not declared in the manifest`,
    );
  }
  return projection.tools.map((tool) => tool.name);
}

export interface SurfaceToolDiscoveryObservation {
  transport: 'MCP' | 'AGENT' | 'CLI';
  surface?: string;
  names: readonly string[];
}

export interface SurfaceRealtimeDiscoveryObservation {
  serverToClient: readonly string[];
  clientToServer: readonly string[];
}

export interface SurfaceDiscoveryObservation {
  openApi?: Pick<OpenApiDocument, 'paths'>;
  /** Default unnamed projections; use toolSurfaces for a named MCP surface. */
  MCP?: readonly string[];
  AGENT?: readonly string[];
  CLI?: readonly string[];
  toolSurfaces?: readonly SurfaceToolDiscoveryObservation[];
  realtime?: Readonly<Record<string, SurfaceRealtimeDiscoveryObservation>>;
  cliOnly?: readonly string[];
  extensions?: Partial<Record<ConformanceTransport, readonly string[]>>;
}

/** Compare only discoveries the caller actually observed. */
export function assertSurfaceDiscovery(
  manifest: SurfaceManifest,
  observed: SurfaceDiscoveryObservation,
): void {
  if (observed.openApi) {
    assertSameSet(
      'HTTP/OpenAPI',
      manifest.operations.flatMap((operation) =>
        operation.http.map(
          (entry) => `${entry.method}:${entry.path.replace(/:([^/]+)/g, '{$1}')}`,
        ),
      ),
      openApiOperations(observed.openApi),
    );
  }
  for (const transport of ['MCP', 'AGENT', 'CLI'] satisfies Array<'MCP' | 'AGENT' | 'CLI'>) {
    const names = observed[transport];
    if (names) {
      assertSameSet(
        `${transport} discovery`,
        expectedToolNames(manifest, transport, null),
        names,
      );
    }
  }
  for (const projection of observed.toolSurfaces ?? []) {
    assertSameSet(
      `${projection.transport} surface "${projection.surface ?? '(default)'}" discovery`,
      expectedToolNames(manifest, projection.transport, projection.surface ?? null),
      projection.names,
    );
  }
  for (const [contract, topology] of Object.entries(observed.realtime ?? {})) {
    if (!manifest.realtimeContracts.includes(contract)) {
      throw new Error(`REALTIME contract "${contract}" is not declared in the manifest`);
    }
    for (const direction of ['serverToClient', 'clientToServer'] satisfies Array<
      'serverToClient' | 'clientToServer'
    >) {
      assertSameSet(
        `REALTIME ${contract}.${direction} discovery`,
        manifest.realtime
          .filter((entry) => entry.contract === contract && entry.direction === direction)
          .map((entry) => entry.event),
        topology[direction],
      );
    }
  }
  if (observed.cliOnly) {
    assertSameSet(
      'CLI-only discovery',
      manifest.cliOnly.map((command) => command.name),
      observed.cliOnly,
    );
  }
  for (const transport of [
    'HTTP',
    'MCP',
    'AGENT',
    'CLI',
    'REALTIME',
  ] satisfies ConformanceTransport[]) {
    const names = observed.extensions?.[transport];
    if (!names) continue;
    assertSameSet(
      `${transport} extension discovery`,
      manifest.extensions
        .filter((extension) => extension.transport === transport)
        .map((extension) => extension.name),
      names,
    );
  }
}

function boundedObservation(
  observation: TransportObservation,
  maxDiagnosticBytes: number,
): TransportObservation {
  const parsed = TransportObservationSchema.parse(observation);
  if (!parsed.diagnostic) return parsed;
  const bytes = new TextEncoder().encode(parsed.diagnostic);
  if (bytes.byteLength <= maxDiagnosticBytes) return parsed;
  return {
    ...parsed,
    diagnostic: new TextDecoder().decode(bytes.slice(0, maxDiagnosticBytes)),
  };
}

async function runBounded<T>(run: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve()
      .then(run)
      .catch(() => undefined);
    throw signal.reason;
  }
  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<T>((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), aborted]);
  } finally {
    removeAbortListener();
  }
}

/** Run explicit behavioral probes; no unrequested transport claim is inferred. */
export async function runSurfaceProbes<TFixture>({
  probes,
  drivers,
  signal,
  timeoutMs = 10_000,
  maxDiagnosticBytes = 4096,
}: RunSurfaceProbesConfig<TFixture>): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Surface probe timeoutMs must be a positive integer');
  }
  if (!Number.isInteger(maxDiagnosticBytes) || maxDiagnosticBytes <= 0) {
    throw new TypeError('Surface probe maxDiagnosticBytes must be a positive integer');
  }

  for (const probe of probes) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const probeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let failed = false;
    let failure: unknown;
    try {
      probeSignal.throwIfAborted();
      if (probe.setup) await runBounded(() => probe.setup?.(probeSignal), probeSignal);
      for (const transport of probe.transports) {
        probeSignal.throwIfAborted();
        const driver = drivers[transport];
        if (!driver) {
          throw new Error(`Surface probe "${probe.name}" has no ${transport} driver`);
        }
        const actual = boundedObservation(
          await runBounded(() => driver.invoke(probe.fixture, probeSignal), probeSignal),
          maxDiagnosticBytes,
        );
        const expected = probe.expected[transport];
        if (!expected) {
          throw new Error(`Surface probe "${probe.name}" has no ${transport} expectation`);
        }
        if (serializeSurfaceValue(actual) !== serializeSurfaceValue(expected)) {
          throw new Error(
            `Surface probe "${probe.name}" ${transport} mismatch\nexpected: ${serializeSurfaceValue(expected)}\nactual: ${serializeSurfaceValue(actual)}`,
          );
        }
      }
    } catch (error) {
      failed = true;
      failure = error;
    }

    if (probe.teardown) {
      try {
        await runBounded(() => probe.teardown?.(probeSignal), probeSignal);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure;
  }
}
