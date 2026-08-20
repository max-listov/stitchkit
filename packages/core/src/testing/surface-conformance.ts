import { z } from 'zod';
import type { OpenApiDocument } from '../server/openapi';
import {
  type SurfaceManifest,
  type SurfaceManifestOperation,
  serializeSurfaceValue,
} from './surface-manifest';

const ProbeOutcomeSchema = z.enum(['success', 'validation_error', 'domain_error', 'aborted']);

export const TransportObservationSchema = z.object({
  outcome: ProbeOutcomeSchema,
  code: z.string().optional(),
  data: z.unknown().optional(),
  diagnostic: z.string().optional(),
});

export type TransportObservation = z.infer<typeof TransportObservationSchema>;
export type ConformanceTransport = 'HTTP' | 'MCP' | 'AGENT' | 'CLI';

export interface SurfaceProbe<TFixture = unknown> {
  name: string;
  fixture: TFixture;
  transports: readonly ConformanceTransport[];
  expected: Partial<Record<ConformanceTransport, TransportObservation>>;
  setup?: () => void | Promise<void>;
  teardown?: () => void | Promise<void>;
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
  operations: readonly SurfaceManifestOperation[],
  transport: 'MCP' | 'AGENT' | 'CLI',
): string[] {
  return operations.flatMap((operation) => {
    const name = operation.tools[transport];
    return name ? [name] : [];
  });
}

export interface SurfaceDiscoveryObservation {
  openApi?: Pick<OpenApiDocument, 'paths'>;
  MCP?: readonly string[];
  AGENT?: readonly string[];
  CLI?: readonly string[];
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
    if (names)
      assertSameSet(
        `${transport} discovery`,
        expectedToolNames(manifest.operations, transport),
        names,
      );
  }
  if (observed.cliOnly) {
    assertSameSet(
      'CLI-only discovery',
      manifest.cliOnly.map((command) => command.name),
      observed.cliOnly,
    );
  }
  for (const transport of ['HTTP', 'MCP', 'AGENT', 'CLI'] satisfies ConformanceTransport[]) {
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

async function invokeBounded<TFixture>(
  driver: SurfaceProbeDriver<TFixture>,
  fixture: TFixture,
  signal: AbortSignal,
): Promise<TransportObservation> {
  signal.throwIfAborted();
  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<TransportObservation>((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([driver.invoke(fixture, signal), aborted]);
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Surface probe timeoutMs must be a finite positive number');
  }
  if (!Number.isInteger(maxDiagnosticBytes) || maxDiagnosticBytes <= 0) {
    throw new TypeError('Surface probe maxDiagnosticBytes must be a positive integer');
  }

  for (const probe of probes) {
    await probe.setup?.();
    try {
      for (const transport of probe.transports) {
        const driver = drivers[transport];
        if (!driver)
          throw new Error(`Surface probe "${probe.name}" has no ${transport} driver`);
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const invokeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const actual = boundedObservation(
          await invokeBounded(driver, probe.fixture, invokeSignal),
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
    } finally {
      await probe.teardown?.();
    }
  }
}
