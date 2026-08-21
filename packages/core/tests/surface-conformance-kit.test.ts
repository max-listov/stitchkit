import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { bindRealtimeClient, type RealtimeClientTransport } from '../src/browser/socket-io';
import { AppError, defineContract } from '../src/contract';
import {
  defineRealtimeContract,
  RealtimeRequestDisconnectedError,
  RealtimeRequestTimeoutError,
} from '../src/realtime';
import { implement } from '../src/server/implement';
import { generateOpenApiDocument } from '../src/server/openapi';
import {
  assertSurfaceDiscovery,
  assertSurfaceManifestSnapshot,
  buildSurfaceManifest,
  createRealtimeProbeDriver,
  defineRealtimeProbe,
  runSurfaceProbes,
  type SurfaceAgentProjection,
  type SurfaceMcpPreparation,
  type SurfaceRuntimeToolDefinition,
  type SurfaceToolDefinition,
  serializeSurfaceValue,
  TransportObservationSchema,
} from '../src/testing';
import { defineCliCommand } from '../src/tools/cli-command';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

const ParamsSchema = z.object({ id: z.string() });
const InputSchema = z.object({ query: z.string() });
const OutputSchema = z.object({ value: z.string() });

const contract = defineContract(
  { prefix: 'items', scope: 'user' },
  {
    read: {
      method: 'GET',
      path: '/:id',
      desc: 'Read item',
      params: ParamsSchema,
      input: InputSchema,
      output: OutputSchema,
      expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
    },
  },
);

const service = implement(contract, {
  read: () => ({ value: 'ok' }),
});

const runtimeTool = defineRuntimeTool({
  name: 'jobs_status',
  description: 'Read job status',
  identity: { serviceName: 'jobs', action: 'status', method: 'GET', scope: 'user' },
  input: z.object({ id: z.string() }),
  output: z.object({ state: z.string() }),
  transports: ['MCP', 'AGENT', 'CLI'],
  handler: () => ({ state: 'done' }),
});

const cliOnly = defineCliCommand({
  name: 'doctor',
  description: 'Inspect local state',
  input: z.object({ verbose: z.boolean().optional() }),
  output: z.object({ ok: z.boolean() }),
  handler: () => ({ ok: true }),
});

describe('transport conformance kit', () => {
  test('manifests contract, runtime and CLI-only surfaces with actual topology', () => {
    const manifest = buildSurfaceManifest({
      groups: [{ pathPrefix: '/api/v1', services: [service] }],
      runtimeTools: [runtimeTool],
      cliCommands: [cliOnly],
      extensions: [{ name: '/health', transport: 'HTTP' }],
    });

    expect(manifest.operations).toHaveLength(2);
    expect(manifest.operations[0]?.http).toEqual([
      { method: 'GET', path: '/api/v1/items/:id' },
    ]);
    expect(manifest.operations[0]?.schemas.params).not.toBeNull();
    expect(manifest.operations[1]?.kind).toBe('runtime');
    expect(
      manifest.toolSurfaces
        .find((projection) => projection.transport === 'MCP' && projection.surface === null)
        ?.tools.map((tool) => tool.name),
    ).toEqual(['jobs_status']);
    expect(
      manifest.toolSurfaces
        .find((projection) => projection.transport === 'CLI' && projection.surface === null)
        ?.tools.map((tool) => tool.name),
    ).toEqual(['jobs_status']);
    expect(manifest.cliOnly.map((command) => command.name)).toEqual(['doctor']);
    expect(manifest.extensions).toEqual([{ name: '/health', transport: 'HTTP' }]);
  });

  test('canonical schema digests ignore object key insertion order', () => {
    const firstTool = defineRuntimeTool({
      name: 'first',
      description: 'First',
      identity: { serviceName: 'digest', action: 'read', method: 'GET' },
      input: z.object({ alpha: z.string(), beta: z.number() }),
      output: OutputSchema,
      handler: () => ({ value: 'ok' }),
    });
    const secondTool = defineRuntimeTool({
      name: 'first',
      description: 'First',
      identity: { serviceName: 'digest', action: 'read', method: 'GET' },
      input: z.object({ beta: z.number(), alpha: z.string() }),
      output: OutputSchema,
      handler: () => ({ value: 'ok' }),
    });

    const first = buildSurfaceManifest({ runtimeTools: [firstTool] });
    const second = buildSurfaceManifest({ runtimeTools: [secondTool] });

    expect(first.operations[0]?.schemas.input).toBe(second.operations[0]?.schemas.input);
    expect(serializeSurfaceValue(first)).toBe(serializeSurfaceValue(second));
  });

  test('snapshot and live discovery fail on real drift', () => {
    const manifest = buildSurfaceManifest({
      groups: [{ pathPrefix: '/api/v1', services: [service] }],
      runtimeTools: [runtimeTool],
      cliCommands: [cliOnly],
    });
    const openApi = generateOpenApiDocument({
      info: { title: 'test', version: '1' },
      groups: [{ pathPrefix: '/api/v1', services: [service] }],
    });
    const names = (transport: 'MCP' | 'AGENT' | 'CLI') =>
      manifest.toolSurfaces
        .find(
          (projection) => projection.transport === transport && projection.surface === null,
        )
        ?.tools.map((tool) => tool.name) ?? [];

    assertSurfaceManifestSnapshot(manifest, manifest);
    assertSurfaceDiscovery(manifest, {
      openApi,
      MCP: names('MCP'),
      AGENT: names('AGENT'),
      CLI: names('CLI'),
      cliOnly: ['doctor'],
    });

    expect(() => assertSurfaceDiscovery(manifest, { MCP: ['missing'] })).toThrow(
      'MCP discovery mismatch',
    );
  });

  test('projects named MCP selections through one reachable global preparation policy', () => {
    const manifest = buildSurfaceManifest({
      groups: [{ pathPrefix: '/api/v1', services: [service] }],
      runtimeTools: [runtimeTool],
      mcpPreparation: {
        extend: {
          schema: { tenant: z.string() },
          resolve: ({ tenant }) => ({ tenant }),
          filter: (_service, method) => method.key === 'read',
        },
      },
      mcpSurfaces: {
        member: { services: [], runtimeTools: [runtimeTool] },
        admin: {
          services: [service],
          runtimeTools: [runtimeTool],
        },
      },
      toolSurfaces: {
        AGENT: { services: [], runtimeTools: [runtimeTool] },
        CLI: { services: [], runtimeTools: [] },
      },
    });

    expect(manifest.operations.find((operation) => operation.action === 'read')?.http).toEqual(
      [{ method: 'GET', path: '/api/v1/items/:id' }],
    );
    const member = manifest.toolSurfaces.find((surface) => surface.surface === 'member');
    const admin = manifest.toolSurfaces.find((surface) => surface.surface === 'admin');
    expect(member?.tools.map((tool) => tool.name)).toEqual(['jobs_status']);
    expect(admin?.tools.map((tool) => tool.name)).toEqual(['jobs_status', 'read_item']);
    const baseline = buildSurfaceManifest({
      toolSurfaces: {
        MCP: { services: [service] },
        AGENT: { services: [] },
        CLI: { services: [] },
      },
    });
    expect(admin?.tools.find((tool) => tool.name === 'read_item')?.input).not.toBe(
      baseline.toolSurfaces
        .find((surface) => surface.transport === 'MCP')
        ?.tools.find((tool) => tool.name === 'read_item')?.input,
    );
    expect(admin?.tools.find((tool) => tool.name === 'jobs_status')?.input).toBe(
      member?.tools.find((tool) => tool.name === 'jobs_status')?.input,
    );

    assertSurfaceDiscovery(manifest, {
      toolSurfaces: [
        { transport: 'MCP', surface: 'member', names: ['jobs_status'] },
        { transport: 'MCP', surface: 'admin', names: ['read_item', 'jobs_status'] },
      ],
      AGENT: ['jobs_status'],
      CLI: [],
    });
  });

  test('accepts a canonical peer-free runtime descriptor without executable peers', () => {
    const descriptor = {
      name: 'jobs_snapshot',
      description: 'Snapshot job state',
      identity: { serviceName: 'jobs', action: 'snapshot', method: 'GET' },
      input: z.object({ id: z.string() }),
      output: z.object({ state: z.string() }),
      transports: ['MCP', 'AGENT'],
    } satisfies SurfaceRuntimeToolDefinition;

    const manifest = buildSurfaceManifest({ runtimeTools: [descriptor] });
    expect(manifest.toolSurfaces.find((entry) => entry.transport === 'MCP')?.tools).toEqual([
      expect.objectContaining({ name: 'jobs_snapshot', kind: 'runtime' }),
    ]);
  });

  test('requires every projected tool extension to be executable by a real mount', () => {
    // @ts-expect-error — a projection cannot advertise extension fields without their resolver.
    const incomplete: SurfaceMcpPreparation = { extend: { schema: { tenant: z.string() } } };
    expect(incomplete.extend?.schema.tenant).toBeDefined();
  });

  test('keeps CLI selection plain while Agent owns presentation shaping', () => {
    type CliHasExtend = 'extend' extends keyof SurfaceToolDefinition ? true : false;
    type AgentHasExtend = 'extend' extends keyof SurfaceAgentProjection ? true : false;
    const cliHasExtend: CliHasExtend = false;
    const agentHasExtend: AgentHasExtend = true;

    expect({ cliHasExtend, agentHasExtend }).toEqual({
      cliHasExtend: false,
      agentHasExtend: true,
    });
  });

  test('prepares a valid multi-round MCP surface with the declared global capability', () => {
    const multiRoundContract = defineContract(
      { prefix: 'deployments', scope: 'admin' },
      {
        release: {
          method: 'POST',
          path: '/:id',
          desc: 'Release a deployment',
          expose: ['MCP'],
          params: z.object({ id: z.string() }),
          output: z.object({ summary: z.string() }),
          mcp: {
            inputRequired: [
              {
                key: 'confirmation',
                message: 'Release?',
                schema: z.object({ confirmed: z.boolean() }),
              },
            ],
          },
        },
      },
    );
    const multiRoundService = implement(multiRoundContract, {
      release: () => ({ summary: 'released' }),
    });

    expect(() =>
      buildSurfaceManifest({
        toolSurfaces: { MCP: { services: [multiRoundService] } },
      }),
    ).toThrow('no multiRound.state key is configured');

    const manifest = buildSurfaceManifest({
      toolSurfaces: { MCP: { services: [multiRoundService] } },
      mcpPreparation: { multiRound: { stateConfigured: true, maxRounds: 2 } },
    });
    expect(
      manifest.toolSurfaces
        .find((surface) => surface.transport === 'MCP')
        ?.tools.map((tool) => tool.name),
    ).toEqual(['release_deployment']);
  });

  test('uses the canonical flatten and schema-policy preparation for manifest inclusion', () => {
    const projectionContract = defineContract(
      { prefix: 'projection' },
      {
        choose: {
          method: 'POST',
          path: '/choose',
          desc: 'Choose a variant',
          expose: ['MCP'],
          input: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('text'), value: z.string() }),
            z.object({ kind: z.literal('count'), value: z.number() }),
          ]),
          output: z.object({ ok: z.boolean() }),
        },
        schedule: {
          method: 'POST',
          path: '/schedule',
          desc: 'Schedule a run',
          expose: ['MCP'],
          input: z.object({ at: z.date() }),
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    const projectionService = implement(projectionContract, {
      choose: () => ({ ok: true }),
      schedule: () => ({ ok: true }),
    });

    const manifest = buildSurfaceManifest({
      toolSurfaces: { MCP: { services: [projectionService] } },
      mcpPreparation: {
        flattenUnionInput: true,
        schemaValidation: { policy: 'skip' },
      },
    });
    expect(
      manifest.toolSurfaces
        .find((surface) => surface.transport === 'MCP')
        ?.tools.map((tool) => tool.name),
    ).toEqual(['choose_projection']);
  });

  test('rejects semantic identity drift while allowing one service at multiple HTTP mounts', () => {
    const multiMount = buildSurfaceManifest({
      groups: [
        { pathPrefix: '/v1', services: [service] },
        { pathPrefix: '/internal', services: [service] },
      ],
    });
    expect(multiMount.operations[0]?.http).toEqual([
      { method: 'GET', path: '/internal/items/:id' },
      { method: 'GET', path: '/v1/items/:id' },
    ]);

    const conflictingContract = defineContract(
      { prefix: 'items', scope: 'user' },
      {
        read: {
          method: 'GET',
          path: '/:id',
          desc: 'Read item',
          params: ParamsSchema,
          input: InputSchema,
          output: OutputSchema,
          expose: ['HTTP', 'MCP'],
          toolName: 'read_item_by_id',
        },
      },
    );
    const conflictingService = implement(conflictingContract, {
      read: () => ({ value: 'ok' }),
    });
    expect(() =>
      buildSurfaceManifest({
        groups: [
          { pathPrefix: '/v1', services: [service] },
          { pathPrefix: '/v2', services: [conflictingService] },
        ],
      }),
    ).toThrow('Conflicting contract operation identity items.read');

    const retryAwareContract = defineContract(
      { prefix: 'items', scope: 'user' },
      {
        read: {
          method: 'GET',
          path: '/:id',
          desc: 'Read item',
          params: ParamsSchema,
          input: InputSchema,
          output: OutputSchema,
          expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
          idempotent: true,
        },
      },
    );
    const retryAwareService = implement(retryAwareContract, {
      read: () => ({ value: 'ok' }),
    });
    expect(() =>
      buildSurfaceManifest({ groups: [{ services: [service, retryAwareService] }] }),
    ).toThrow('Conflicting contract operation identity items.read');

    const pdfContract = defineContract(
      { prefix: 'exports', scope: 'user' },
      {
        download: {
          method: 'GET',
          path: '/download',
          desc: 'Download export',
          rawResponse: true,
          contentType: 'application/pdf',
        },
      },
    );
    const textContract = defineContract(
      { prefix: 'exports', scope: 'user' },
      {
        download: {
          method: 'GET',
          path: '/download',
          desc: 'Download export',
          rawResponse: true,
          contentType: 'text/plain',
        },
      },
    );
    const pdfService = implement(pdfContract, { download: () => new Response('pdf') });
    const textService = implement(textContract, { download: () => new Response('text') });
    expect(() =>
      buildSurfaceManifest({ groups: [{ services: [pdfService, textService] }] }),
    ).toThrow('Conflicting contract operation identity exports.download');

    const annotatedRuntime = {
      ...runtimeTool,
      annotations: { readOnlyHint: true },
    } satisfies SurfaceRuntimeToolDefinition;
    expect(() =>
      buildSurfaceManifest({
        toolSurfaces: {
          MCP: { runtimeTools: [runtimeTool] },
          AGENT: { runtimeTools: [annotatedRuntime] },
        },
      }),
    ).toThrow('Conflicting runtime operation identity jobs.status');
  });

  test('retains an empty named realtime contract in the manifest topology', () => {
    const empty = defineRealtimeContract({ serverToClient: {}, clientToServer: {} });
    const manifest = buildSurfaceManifest({ realtime: { empty } });

    expect(manifest.realtimeContracts).toEqual(['empty']);
    expect(manifest.realtime).toEqual([]);
    assertSurfaceDiscovery(manifest, {
      realtime: { empty: { serverToClient: [], clientToServer: [] } },
    });
    expect(() =>
      assertSurfaceDiscovery(manifest, {
        realtime: { missing: { serverToClient: [], clientToServer: [] } },
      }),
    ).toThrow('REALTIME contract "missing" is not declared');
  });

  test('snapshots named realtime directions and acknowledgement schemas', () => {
    const realtime = defineRealtimeContract({
      serverToClient: {
        ready: { args: z.tuple([]) },
      },
      clientToServer: {
        sum: { args: z.tuple([z.number(), z.number()]), ack: z.number() },
      },
    });
    const manifest = buildSurfaceManifest({ realtime: { primary: realtime } });

    expect(manifest.realtime).toHaveLength(2);
    expect(manifest.realtime.find((event) => event.event === 'sum')).toMatchObject({
      contract: 'primary',
      direction: 'clientToServer',
      acknowledgement: { input: expect.any(String), output: expect.any(String) },
    });
    assertSurfaceDiscovery(manifest, {
      realtime: {
        primary: { serverToClient: ['ready'], clientToServer: ['sum'] },
      },
    });
  });

  test('realtime schema snapshots are ordered and drift on representable ack changes', () => {
    const first = defineRealtimeContract({
      serverToClient: {
        zeta: { args: z.tuple([z.string()]) },
        alpha: { args: z.tuple([]) },
      },
      clientToServer: {
        calculate: { args: z.tuple([z.number()]), ack: z.object({ value: z.number() }) },
      },
    });
    const reordered = defineRealtimeContract({
      serverToClient: {
        alpha: { args: z.tuple([]) },
        zeta: { args: z.tuple([z.string()]) },
      },
      clientToServer: {
        calculate: { args: z.tuple([z.number()]), ack: z.object({ value: z.number() }) },
      },
    });
    const changed = defineRealtimeContract({
      serverToClient: reordered.serverToClient,
      clientToServer: {
        calculate: { args: z.tuple([z.number()]), ack: z.object({ value: z.string() }) },
      },
    });

    const baseline = buildSurfaceManifest({ realtime: { primary: first } });
    expect(serializeSurfaceValue(baseline)).toBe(
      serializeSurfaceValue(buildSurfaceManifest({ realtime: { primary: reordered } })),
    );
    expect(serializeSurfaceValue(baseline)).not.toBe(
      serializeSurfaceValue(buildSurfaceManifest({ realtime: { primary: changed } })),
    );
  });

  test('normalizes a real bound transport across event, ack, rejection and disconnect scenarios', async () => {
    const realtime = defineRealtimeContract({
      serverToClient: {
        notice: { args: z.tuple([z.object({ n: z.number() })]) },
      },
      clientToServer: {
        publish: { args: z.tuple([z.object({ n: z.number() })]) },
        sum: { args: z.tuple([z.number(), z.number()]), ack: z.number() },
        invalidAck: { args: z.tuple([]), ack: z.number() },
        disconnected: { args: z.tuple([]), ack: z.boolean() },
        inFlightDisconnect: { args: z.tuple([]), ack: z.boolean() },
        slow: { args: z.tuple([]), ack: z.boolean() },
      },
    });
    const subscriptions = new Map<string, Set<(...args: unknown[]) => void>>();
    let connected = true;
    const transport = {
      get connected() {
        return connected;
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        const handlers = subscriptions.get(event) ?? new Set();
        handlers.add(handler);
        subscriptions.set(event, handlers);
        return () => handlers.delete(handler);
      },
      emit: (_event: string, ..._args: unknown[]) => true,
      async emitWithAck(event: string, args: unknown[], options: { timeoutMs: number }) {
        if (event === 'sum') return Number(args[0]) + Number(args[1]);
        if (event === 'invalidAck') return 'not-a-number';
        if (event === 'disconnected') {
          throw new RealtimeRequestDisconnectedError(event);
        }
        if (event === 'inFlightDisconnect') {
          await Promise.resolve();
          connected = false;
          throw new RealtimeRequestDisconnectedError(event);
        }
        if (event === 'slow') {
          throw new RealtimeRequestTimeoutError(event, options.timeoutMs);
        }
        return undefined;
      },
      onConnectionChange: (_listener: (connected: boolean, reason?: string) => void) => () =>
        undefined,
      push(event: string, ...args: unknown[]) {
        for (const handler of subscriptions.get(event) ?? []) handler(...args);
      },
    } satisfies RealtimeClientTransport & { push(event: string, ...args: unknown[]): void };
    let handlerCalls = 0;
    const driver = createRealtimeProbeDriver<string>({
      bind: (onRejected, fixture) => {
        connected = fixture.scenario !== 'disconnected';
        const client = bindRealtimeClient(realtime, transport, { onRejected });
        const unsubscribe = client.on('notice', () => {
          handlerCalls += 1;
        });
        return {
          connected: () => client.connected,
          invoke: ({ scenario }) => {
            if (scenario === 'event') return client.emit('publish', { n: 1 });
            if (scenario === 'acknowledgement') {
              return client.request('sum', 1, 2, { timeoutMs: 50 });
            }
            if (scenario === 'invalid_arguments') {
              transport.push('notice', { n: 'wrong' });
              return undefined;
            }
            if (scenario === 'invalid_acknowledgement') {
              return client.request('invalidAck', { timeoutMs: 50 });
            }
            if (scenario === 'disconnected') {
              return client.request('disconnected', { timeoutMs: 50 });
            }
            if (scenario === 'in_flight_disconnect') {
              return client.request('inFlightDisconnect', { timeoutMs: 50 });
            }
            return client.request('slow', { timeoutMs: 5 });
          },
          dispose: unsubscribe,
        };
      },
      handlerCalls: () => handlerCalls,
    });
    const cases = [
      { scenario: 'event', outcome: 'success', data: true, handlerCalls: 0 },
      { scenario: 'acknowledgement', outcome: 'success', data: 3, handlerCalls: 0 },
      {
        scenario: 'invalid_arguments',
        outcome: 'realtime_rejected',
        code: 'REALTIME_CONTRACT_VIOLATION',
        rejection: {
          direction: 'client-inbound',
          phase: 'arguments',
          reason: 'invalid-arguments',
          fault: 'peer',
        },
        handlerCalls: 0,
      },
      {
        scenario: 'invalid_acknowledgement',
        outcome: 'realtime_rejected',
        code: 'REALTIME_REQUEST_INVALID_ACKNOWLEDGEMENT',
        rejection: {
          direction: 'client-inbound',
          phase: 'acknowledgement',
          reason: 'invalid-acknowledgement-value',
          fault: 'peer',
        },
        handlerCalls: 0,
      },
      {
        scenario: 'disconnected',
        outcome: 'disconnected',
        code: 'REALTIME_REQUEST_DISCONNECTED',
        disconnect: { phase: 'before-invoke' },
        handlerCalls: 0,
      },
      {
        scenario: 'in_flight_disconnect',
        outcome: 'disconnected',
        code: 'REALTIME_REQUEST_DISCONNECTED',
        disconnect: { phase: 'in-flight' },
        handlerCalls: 0,
      },
      {
        scenario: 'timeout',
        outcome: 'timeout',
        code: 'REALTIME_REQUEST_TIMEOUT',
        handlerCalls: 0,
      },
    ] as const;
    const probes = cases.map(({ scenario, ...expected }) =>
      defineRealtimeProbe({ name: scenario, scenario, fixture: scenario, expected }),
    );

    await runSurfaceProbes({
      probes,
      drivers: { REALTIME: driver },
    });
    expect(handlerCalls).toBe(0);
  });

  test('rejects a realtime scenario whose expected outcome is incompatible', () => {
    expect(() =>
      defineRealtimeProbe({
        name: 'wrong timeout',
        scenario: 'timeout',
        fixture: undefined,
        expected: { outcome: 'success' },
      }),
    ).toThrow('requires outcome "timeout"');
    expect(() => TransportObservationSchema.parse({ outcome: 'realtime_rejected' })).toThrow();
    expect(() =>
      defineRealtimeProbe({
        name: 'unproven invalid inbound',
        scenario: 'invalid_arguments',
        fixture: undefined,
        expected: {
          outcome: 'realtime_rejected',
          rejection: {
            direction: 'client-inbound',
            phase: 'arguments',
            reason: 'invalid-arguments',
            fault: 'peer',
          },
        },
      }),
    ).toThrow('requires handlerCalls: 0');
  });

  test('isolates a late rejection from the next realtime probe invocation', async () => {
    const driver = createRealtimeProbeDriver<string>({
      bind: (onRejected, fixture) => ({
        connected: () => true,
        invoke: async () => {
          if (fixture.scenario === 'timeout') {
            setTimeout(() => {
              const error = new AppError(
                'REALTIME_CONTRACT_VIOLATION',
                'late acknowledgement rejection',
                500,
                {
                  event: 'late',
                  direction: 'client-inbound',
                  phase: 'acknowledgement',
                  reason: 'invalid-acknowledgement-value',
                  fault: 'peer',
                },
              );
              void onRejected({
                event: 'late',
                direction: 'client-inbound',
                phase: 'acknowledgement',
                reason: 'invalid-acknowledgement-value',
                fault: 'peer',
                error,
              });
            }, 5);
            throw new RealtimeRequestTimeoutError('late', 1);
          }
          await Bun.sleep(10);
          return 'ok';
        },
      }),
    });
    const probes = [
      defineRealtimeProbe({
        name: 'times out first',
        scenario: 'timeout',
        fixture: 'first',
        expected: { outcome: 'timeout', code: 'REALTIME_REQUEST_TIMEOUT' },
      }),
      defineRealtimeProbe({
        name: 'succeeds after late rejection',
        scenario: 'event',
        fixture: 'second',
        expected: { outcome: 'success', data: 'ok' },
      }),
    ];

    await runSurfaceProbes({ probes, drivers: { REALTIME: driver } });
  });

  test('behavioral probes are explicit, bounded and always tear down', async () => {
    const phases: string[] = [];
    await runSurfaceProbes({
      probes: [
        {
          name: 'read',
          fixture: { id: '1' },
          transports: ['HTTP', 'MCP'],
          expected: {
            HTTP: { outcome: 'success', data: { value: 'ok' } },
            MCP: { outcome: 'domain_error', code: 'DENIED' },
          },
          setup: () => void phases.push('setup'),
          teardown: () => void phases.push('teardown'),
        },
      ],
      drivers: {
        HTTP: {
          invoke: async (_fixture, signal) => {
            expect(signal.aborted).toBe(false);
            phases.push('http');
            return { outcome: 'success', data: { value: 'ok' } };
          },
        },
        MCP: {
          invoke: async () => {
            phases.push('mcp');
            return { outcome: 'domain_error', code: 'DENIED' };
          },
        },
      },
    });

    expect(phases).toEqual(['setup', 'http', 'mcp', 'teardown']);
  });

  test('a non-cooperative driver cannot hold the runner past its timeout', async () => {
    await expect(
      runSurfaceProbes({
        probes: [
          {
            name: 'hung',
            fixture: undefined,
            transports: ['HTTP'],
            expected: { HTTP: { outcome: 'success' } },
          },
        ],
        drivers: { HTTP: { invoke: () => new Promise(() => undefined) } },
        timeoutMs: 5,
      }),
    ).rejects.toBeDefined();
  });

  test('rejects a fractional scenario timeout before invoking a driver', async () => {
    let invoked = false;
    await expect(
      runSurfaceProbes({
        probes: [
          {
            name: 'fractional timeout',
            fixture: undefined,
            transports: ['HTTP'],
            expected: { HTTP: { outcome: 'success' } },
          },
        ],
        drivers: {
          HTTP: {
            invoke: async () => {
              invoked = true;
              return { outcome: 'success' };
            },
          },
        },
        timeoutMs: 1.5,
      }),
    ).rejects.toThrow('Surface probe timeoutMs must be a positive integer');
    expect(invoked).toBe(false);
  });

  test('setup, invoke and teardown share one bounded scenario deadline', async () => {
    const phases: string[] = [];
    const started = performance.now();
    await expect(
      runSurfaceProbes({
        probes: [
          {
            name: 'hung setup',
            fixture: undefined,
            transports: ['REALTIME'],
            expected: { REALTIME: { outcome: 'success' } },
            setup: () => new Promise(() => undefined),
            teardown: () => void phases.push('teardown'),
          },
        ],
        drivers: { REALTIME: { invoke: async () => ({ outcome: 'success' }) } },
        timeoutMs: 10,
      }),
    ).rejects.toBeDefined();
    expect(performance.now() - started).toBeLessThan(200);
    await Promise.resolve();
    expect(phases).toEqual(['teardown']);
  });
});
