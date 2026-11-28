import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { resolveOpenRouterWirePolicy } from '../src/agent-runtime/openrouter-options';
import {
  completeText,
  createMemoryAgentRuntimeStore,
  createModelInvocationLedger,
  defineModelRegistry,
  type ModelInvocationConfig,
  modelInvocationSpendAttribution,
} from '../src/entrypoints/agent-runtime';
import {
  createMemoryOpenRouterRouteStore,
  createOpenRouterRouteResolver,
  createOpenRouterSpendReconciler,
  evaluateOpenRouterModelAdmission,
  fetchOpenRouterModelEndpoints,
  loadOpenRouterCatalogSnapshot,
  type OpenRouterCatalogSnapshot,
  OpenRouterModelAdmissionSchema,
  OpenRouterRequestPolicySchema,
  openRouterModelCatalog,
  openRouterProvider,
  openRouterSpendProvider,
} from '../src/entrypoints/agent-runtime/openrouter';
import { createSpendGateway, runWithSpendAttribution } from '../src/entrypoints/spend';
import { defineAgentTool } from '../src/entrypoints/tools';
import { memorySpendLedger } from './support/spend-ledger';

const completion = (extra: Record<string, unknown> = {}) =>
  Response.json({
    id: 'gen-1',
    model: 'author/model',
    provider: 'upstream-a',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5, cost: 0.0003 },
    ...extra,
  });

function capturing() {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const text = input instanceof Request ? await input.text() : String(init?.body);
      bodies.push(z.record(z.string(), z.unknown()).parse(JSON.parse(text)));
      return completion();
    },
    { preconnect: () => undefined },
  );
  return { bodies, fetcher };
}

describe('the request policy', () => {
  test('becomes OpenRouter chat settings: routing, price ceiling, reasoning, session, usage', async () => {
    expect(
      resolveOpenRouterWirePolicy({
        provider: {
          order: ['a'],
          allowFallbacks: false,
          requireParameters: true,
          dataCollection: 'deny',
          zdr: true,
        },
        maxPrice: { promptUsdPerMillion: 2, completionUsdPerMillion: 8, requestUsd: 0.01 },
        reasoning: { effort: 'high', exclude: true },
        looseTools: true,
      }),
    ).toEqual({
      provider: {
        order: ['a'],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: 'deny',
        zdr: true,
        max_price: { prompt: 2, completion: 8, request: 0.01 },
      },
      reasoning: { effort: 'high', exclude: true },
      looseTools: true,
    });
    expect(
      resolveOpenRouterWirePolicy({ sessionId: 's-1', reasoning: { effort: 'max' } }),
    ).toEqual({
      reasoning: { effort: 'max' },
      sessionId: 's-1',
      looseTools: false,
    });
    const { bodies, fetcher } = capturing();
    const provider = openRouterProvider(
      { apiKey: 'k', fetch: fetcher },
      { defaultPolicy: { sessionId: 's-1', reasoning: { effort: 'max' } } },
    );
    await completeText({ driver: provider.create('author/model'), prompt: 'hi' });
    expect(bodies[0]).toMatchObject({
      usage: { include: true },
      reasoning: { effort: 'max' },
      session_id: 's-1',
    });
  });

  test('names its route once: sessionId or provider.order, and an empty order is refused', () => {
    expect(
      OpenRouterRequestPolicySchema.safeParse({ sessionId: 's', provider: { order: ['a'] } })
        .success,
    ).toBe(false);
    expect(OpenRouterRequestPolicySchema.safeParse({ provider: { order: [] } }).success).toBe(
      false,
    );
  });

  test('on the wire: tools go out with strict false, with the session and the routing', async () => {
    const { bodies, fetcher } = capturing();
    const provider = openRouterProvider(
      { apiKey: 'k', fetch: fetcher },
      {
        resolvePolicy: (id) =>
          id === 'author/model' ? { sessionId: 'thread-1', looseTools: true } : undefined,
      },
    );
    await completeText({
      driver: provider.create('author/model'),
      prompt: 'hi',
      tools: {
        lookup: defineAgentTool({
          input: z.object({ q: z.string() }),
          execute: async () => 'x',
        }),
      },
    });
    expect(bodies[0]).toMatchObject({
      session_id: 'thread-1',
      usage: { include: true },
      tools: [{ type: 'function', function: { name: 'lookup', strict: false } }],
    });
  });

  test('the loose-tools fetch rewrites a Request body as well as an init body, and leaves other bodies alone', async () => {
    const { bodies, fetcher } = capturing();
    const loose = openRouterProvider(
      { apiKey: 'k', fetch: fetcher },
      { defaultPolicy: { looseTools: true } },
    );
    await completeText({
      driver: loose.create('author/model'),
      prompt: 'hi',
      tools: {
        looseTool: defineAgentTool({ input: z.object({}), execute: async () => 'x' }),
        strictTool: defineAgentTool({
          input: z.object({}),
          strict: true,
          execute: async () => 'x',
        }),
      },
    });
    const plain = openRouterProvider({ apiKey: 'k', fetch: fetcher });
    await completeText({
      driver: plain.create('author/model'),
      prompt: 'hi',
      tools: {
        defaultTool: defineAgentTool({ input: z.object({}), execute: async () => 'x' }),
      },
    });
    expect(bodies[0]).toMatchObject({
      tools: [
        { type: 'function', function: { name: 'looseTool', strict: false } },
        { type: 'function', function: { name: 'strictTool', strict: true } },
      ],
    });
    const plainTools = z
      .array(
        z.object({ function: z.object({ name: z.string(), strict: z.boolean().optional() }) }),
      )
      .parse(bodies[1]?.tools);
    expect(plainTools[0]?.function.strict).toBeUndefined();
  });
});

describe('route pinning', () => {
  test('session-sticky keeps a thread on its session and drops a provider order', async () => {
    const resolver = createOpenRouterRouteResolver({
      store: createMemoryOpenRouterRouteStore(),
      strategy: 'session-sticky',
    });
    expect(
      await resolver.policyFor('thread-1', { provider: { order: ['x'], zdr: true } }),
    ).toEqual({
      provider: { zdr: true },
      sessionId: 'thread-1',
    });
  });

  test('provider-order pins the upstream that answered first, and later answers change nothing', async () => {
    const resolver = createOpenRouterRouteResolver({
      store: createMemoryOpenRouterRouteStore(),
      strategy: 'provider-order',
    });
    expect(await resolver.policyFor('t', { sessionId: 'old' })).toEqual({ sessionId: 'old' });
    await resolver.record('t', 'upstream-a');
    await resolver.record('t', 'upstream-b');
    expect(
      await resolver.policyFor('t', { sessionId: 'old', reasoning: { effort: 'low' } }),
    ).toEqual({
      reasoning: { effort: 'low' },
      provider: { allowFallbacks: false, order: ['upstream-a'] },
    });
  });

  test('the memory store is bounded by count and by age', async () => {
    let clock = 0;
    const store = createMemoryOpenRouterRouteStore({
      maxEntries: 2,
      ttlMs: 100,
      now: () => clock,
    });
    await store.set('a', { kind: 'session-sticky', sessionId: 'a' });
    await store.set('b', { kind: 'session-sticky', sessionId: 'b' });
    await store.set('c', { kind: 'session-sticky', sessionId: 'c' });
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('c')).toEqual({ kind: 'session-sticky', sessionId: 'c' });
    clock = 200;
    expect(await store.get('c')).toBeUndefined();
  });
});

const models = {
  data: [
    {
      id: 'author/model',
      name: 'Model',
      context_length: 128_000,
      architecture: { input_modalities: ['text'] },
      pricing: { prompt: '0.000002', completion: '0.000008' },
      supported_parameters: ['tools', 'reasoning'],
    },
    {
      id: 'author/unpriced',
      name: 'Unpriced',
      context_length: 32_000,
      architecture: { input_modalities: ['text'] },
      pricing: { prompt: '-1', completion: '-1' },
      supported_parameters: ['tools'],
    },
  ],
};

describe('the catalog snapshot', () => {
  test('reads prices per million, never turns an unknown price into zero, and fetches endpoints', async () => {
    const calls: { url: string; redirect?: RequestRedirect }[] = [];
    const fetcher = async (url: URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), ...(init?.redirect && { redirect: init.redirect }) });
      if (url.pathname.endsWith('/endpoints'))
        return Response.json({
          data: {
            endpoints: [{ provider_name: 'up', pricing: { prompt: '0.000001' }, status: 0 }],
          },
        });
      return Response.json(models);
    };
    const snapshot = await loadOpenRouterCatalogSnapshot({
      apiKey: 'k',
      fetcher,
      endpointsFor: ['author/model'],
      now: () => new Date('2026-11-24T00:00:00.000Z'),
    });
    expect(snapshot.models[0]).toMatchObject({
      id: 'author/model',
      promptUsdPerMillion: 2,
      completionUsdPerMillion: 8,
      endpoints: [
        { provider: 'up', promptUsdPerMillion: 1, status: 0, supportedParameters: [] },
      ],
    });
    expect(snapshot.models[1]?.promptUsdPerMillion).toBeUndefined();
    expect(calls.every((call) => call.redirect === 'error')).toBe(true);
    expect(calls[1]?.url).toBe('https://openrouter.ai/api/v1/models/author/model/endpoints');
  });

  test('refuses a model id that could leave its path segment, before the network', async () => {
    let called = 0;
    const fetcher = async () => {
      called += 1;
      return Response.json({});
    };
    for (const id of ['author/../x', 'author/model?x=1', 'nope', 'a/b#c'])
      await expect(
        fetchOpenRouterModelEndpoints(id, { apiKey: 'k', fetcher }),
      ).rejects.toThrow(TypeError);
    expect(called).toBe(0);
  });

  test('bounds the response body and the concurrency', async () => {
    const fetcher = async () => Response.json({ data: [], padding: 'x'.repeat(4096) });
    await expect(
      loadOpenRouterCatalogSnapshot({ apiKey: 'k', fetcher, maxResponseBytes: 1024 }),
    ).rejects.toThrow(RangeError);
    await expect(
      loadOpenRouterCatalogSnapshot({ apiKey: 'k', fetcher, concurrency: 17 }),
    ).rejects.toThrow('concurrency must be an integer from 1 to 16');
  });
});

describe('admission', () => {
  const snapshot: OpenRouterCatalogSnapshot = {
    schemaVersion: 1,
    observedAt: '2026-11-24T00:00:00.000Z',
    models: [
      {
        id: 'a/ok',
        inputModalities: ['text'],
        contextLength: 100_000,
        promptUsdPerMillion: 1,
        completionUsdPerMillion: 4,
        supportedParameters: ['tools'],
        endpoints: [{ provider: 'p', supportedParameters: [], status: 0 }],
      },
      {
        id: 'a/down',
        inputModalities: ['text'],
        contextLength: 100_000,
        promptUsdPerMillion: 1,
        supportedParameters: ['tools'],
        endpoints: [{ provider: 'p', supportedParameters: [], status: 2 }],
      },
      {
        id: 'a/unpriced',
        inputModalities: ['text'],
        contextLength: 100_000,
        supportedParameters: ['tools'],
      },
      {
        id: 'a/dear-output',
        inputModalities: ['text'],
        contextLength: 100_000,
        completionUsdPerMillion: 40,
        supportedParameters: ['tools'],
      },
      {
        id: 'a/alias',
        inputModalities: ['text'],
        contextLength: 100_000,
        supportedParameters: ['tools'],
        aliasOf: 'a/ok',
      },
    ],
  };
  const decide = (
    modelId: string,
    policy: Record<string, unknown> = {},
    at = '2026-11-24T00:10:00.000Z',
  ) =>
    evaluateOpenRouterModelAdmission({
      snapshot,
      modelId,
      policy: { maxSnapshotAgeMs: 3_600_000, ...policy },
      now: () => new Date(at),
    });

  test('floating aliases are refused whatever the snapshot says', () => {
    for (const id of [
      '~anthropic/claude',
      'a/model-latest',
      'a/model:batch',
      'stealth/x',
      'a/alias',
    ])
      expect(decide(id)).toMatchObject({ state: 'rejected', reason: 'floating-alias' });
  });

  test('a stale snapshot verifies nothing, and an unknown model is refused', () => {
    expect(decide('a/ok', {}, '2026-11-24T02:00:00.000Z')).toMatchObject({
      state: 'unverified',
      reason: 'stale-snapshot',
    });
    expect(decide('a/missing')).toMatchObject({ state: 'rejected', reason: 'unknown-model' });
  });

  test('parameters, context, price and endpoints decide; what the snapshot cannot show is unverified', () => {
    expect(decide('a/ok', { requiredParameters: ['reasoning'] })).toMatchObject({
      reason: 'missing-parameter',
    });
    expect(decide('a/ok', { minContextLength: 200_000 })).toMatchObject({
      reason: 'context-too-small',
    });
    expect(decide('a/ok', { maxCompletionUsdPerMillion: 3 })).toMatchObject({
      state: 'rejected',
      reason: 'over-price',
    });
    expect(decide('a/unpriced', { maxPromptUsdPerMillion: 3 })).toMatchObject({
      state: 'unverified',
      reason: 'price-unknown',
    });
    // A price the snapshot states and refuses outranks one it does not state.
    expect(
      decide('a/dear-output', { maxPromptUsdPerMillion: 3, maxCompletionUsdPerMillion: 10 }),
    ).toMatchObject({ state: 'rejected', reason: 'over-price' });
    expect(decide('a/unpriced', { requireLiveEndpoint: true })).toMatchObject({
      state: 'unverified',
      reason: 'endpoints-unknown',
    });
    expect(decide('a/down', { requireLiveEndpoint: true })).toMatchObject({
      state: 'rejected',
      reason: 'no-live-endpoint',
    });
    expect(
      decide('a/ok', {
        requiredParameters: ['tools'],
        maxPromptUsdPerMillion: 1,
        requireLiveEndpoint: true,
      }),
    ).toEqual({
      state: 'admitted',
    });
  });
});

describe('spend', () => {
  test('the reconciler prices by generation id; 404 is not yet, no id is never', async () => {
    const answers = new Map<string, Response>([
      [
        'gen-priced',
        Response.json({
          data: { total_cost: 0.004, provider_name: 'up', native_tokens_prompt: 9 },
        }),
      ],
      ['gen-later', new Response('{}', { status: 404 })],
    ]);
    const reconcile = createOpenRouterSpendReconciler({
      apiKey: 'k',
      fetcher: async (url) =>
        answers.get(url.searchParams.get('id') ?? '') ?? new Response('{}', { status: 500 }),
    });
    const record = (providerRequestId?: string) => ({
      attempt: {
        attemptId: 'a',
        gateway: 'openrouter',
        startedAt: '2026-11-24T00:00:00.000Z',
        attribution: { purpose: 'p' },
        request: { method: 'POST', origin: 'https://openrouter.ai', path: '/' },
      },
      receipt: {
        attemptId: 'a',
        rank: 1 as const,
        at: '2026-11-24T00:00:01.000Z',
        outcome: 'succeeded' as const,
        facts: {
          costStatus: 'pending' as const,
          ...(providerRequestId && { providerRequestId }),
        },
      },
    });
    expect(await reconcile(record('gen-priced'))).toEqual({
      costStatus: 'reported',
      costUsd: 0.004,
      provider: 'up',
      inputTokens: 9,
    });
    expect(await reconcile(record('gen-later'))).toBeUndefined();
    expect(await reconcile(record())).toEqual({
      costStatus: 'unknown',
      failureCode: 'no-generation-id',
    });
    await expect(reconcile(record('gen-broken'))).rejects.toThrow('HTTP 500');
  });

  test('end to end: an agent-runtime model call through the spend gateway is recorded with its invocation', async () => {
    const ledger = memorySpendLedger();
    const wire: Record<string, unknown>[] = [];
    const gateway = createSpendGateway({
      store: ledger.store,
      providers: [openRouterSpendProvider({ apiKey: () => 'provider-key' })],
      context: modelInvocationSpendAttribution,
      newAttemptId: () => 'attempt-1',
      fetch: async (request) => {
        expect(request.headers.get('authorization')).toBe('Bearer provider-key');
        wire.push(z.record(z.string(), z.unknown()).parse(await request.json()));
        return completion();
      },
    });
    const registry = defineModelRegistry({
      models: {
        first: {
          provider: 'openrouter',
          modelId: 'author/model',
          contextWindow: 8_000,
          capabilities: [],
        },
      },
      providers: {
        openrouter: openRouterProvider(
          { apiKey: 'unused', fetch: gateway.fetchFor('openrouter') },
          { sessionPerConversation: true },
        ),
      },
    });
    const authorize: ModelInvocationConfig['authorize'] = () => ({ subject: 'caller' });
    const invocations = createModelInvocationLedger({
      store: createMemoryAgentRuntimeStore(),
      models: registry,
      payloadKey: randomBytes(32),
      authorize,
    });
    const result = await runWithSpendAttribution(
      { purpose: 'summarize', scope: 'space-1' },
      () =>
        invocations.complete(
          {
            conversationId: 'conversation-1',
            idempotencyKey: 'key-1',
            trace: { operationId: 'op-1', purpose: 'summarize', project: 'p' },
            prompt: 'hello',
            models: ['first'],
            timeoutMs: 1_000,
          },
          'trusted',
        ),
    );
    expect(result.outcome).toBe('succeeded');
    expect(ledger.attempts.get('attempt-1')?.attribution).toMatchObject({
      purpose: 'summarize',
      scope: 'space-1',
      conversationId: 'conversation-1',
      invocationId: result.invocationId,
      invocationAttemptId: expect.any(String),
      step: 0,
    });
    expect(wire[0]?.session_id).toBe('conversation-1');
    expect(await ledger.settled('attempt-1')).toMatchObject({
      outcome: 'succeeded',
      facts: {
        costStatus: 'reported',
        costUsd: 0.0003,
        providerRequestId: 'gen-1',
        provider: 'upstream-a',
      },
    });
  });
});

describe('options of the provider and the snapshot', () => {
  test('strict false for tools has one public path: looseTools in the request policy', async () => {
    const entrypoint: Record<string, unknown> = await import(
      '../src/entrypoints/agent-runtime/openrouter'
    );
    for (const name of [
      'wrapOpenRouterLooseToolsFetch',
      'withOpenRouterLooseTools',
      'buildOpenRouterChatSettings',
    ]) {
      expect(name in entrypoint).toBe(false);
    }
    // @ts-expect-error -- one name: `looseTools` is the request policy's, not the provider's.
    openRouterProvider({ apiKey: 'k' }, { looseTools: true });
    const policy = capturing();
    await completeText({
      driver: openRouterProvider(
        { apiKey: 'k', fetch: policy.fetcher },
        { defaultPolicy: { looseTools: true } },
      ).create('author/model'),
      prompt: 'hi',
      tools: { lookup: defineAgentTool({ input: z.object({}), execute: async () => 'x' }) },
    });
    expect(policy.bodies[0]).toMatchObject({ tools: [{ function: { strict: false } }] });
  });

  test('defaultPolicy shapes a model resolvePolicy says nothing about', async () => {
    const { bodies, fetcher } = capturing();
    const provider = openRouterProvider(
      { apiKey: 'k', fetch: fetcher },
      { defaultPolicy: { provider: { zdr: true } }, resolvePolicy: () => undefined },
    );
    await completeText({ driver: provider.create('author/model'), prompt: 'hi' });
    expect(bodies[0]).toMatchObject({ provider: { zdr: true } });
  });

  test('the snapshot sends the key, stamps its time, runs endpoint requests at most concurrency at once', async () => {
    const auth: (string | null)[] = [];
    let inFlight = 0;
    let peak = 0;
    const fetcher = async (url: URL, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get('authorization'));
      if (!url.pathname.endsWith('/endpoints')) return Response.json(models);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(10);
      inFlight -= 1;
      return Response.json({ data: { endpoints: [] } });
    };
    const snapshot = await loadOpenRouterCatalogSnapshot({
      apiKey: 'secret-key',
      fetcher,
      endpointsFor: ['a/one', 'a/two', 'a/three', 'a/four', 'a/five'],
      concurrency: 2,
      now: () => new Date('2026-11-24T03:00:00.000Z'),
    });
    expect(snapshot.observedAt).toBe('2026-11-24T03:00:00.000Z');
    expect(peak).toBe(2);
    expect(new Set(auth)).toEqual(new Set(['Bearer secret-key']));
  });

  test('a signal or a timeout stops the snapshot', async () => {
    const hanging = (_url: URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason));
      });
    const controller = new AbortController();
    controller.abort(new Error('shutting down'));
    await expect(
      loadOpenRouterCatalogSnapshot({
        apiKey: 'k',
        fetcher: hanging,
        signal: controller.signal,
      }),
    ).rejects.toThrow('shutting down');
    await expect(
      loadOpenRouterCatalogSnapshot({ apiKey: 'k', fetcher: hanging, timeoutMs: 20 }),
    ).rejects.toThrow();
  });
});

describe('review findings', () => {
  test('every routing field reaches the settings, and max effort keeps exclude', () => {
    expect(
      resolveOpenRouterWirePolicy({
        provider: { only: ['a'], ignore: ['b'], sort: 'latency', quantizations: ['fp8'] },
        maxPrice: { imageUsd: 0.1 },
        reasoning: { effort: 'max', exclude: true },
      }),
    ).toEqual({
      provider: {
        only: ['a'],
        ignore: ['b'],
        sort: 'latency',
        quantizations: ['fp8'],
        max_price: { image: 0.1 },
      },
      reasoning: { effort: 'max', exclude: true },
      looseTools: false,
    });
  });

  test('a provider-level extraBody that would overwrite the policy is refused', () => {
    expect(() =>
      openRouterProvider({ apiKey: 'k', extraBody: { provider: { order: ['x'] } } }, {}),
    ).toThrow('extraBody sets provider');
  });

  test("a model's own policy puts strict false on the wire, without the provider-wide switch", async () => {
    const { bodies, fetcher } = capturing();
    const provider = openRouterProvider(
      { apiKey: 'k', fetch: fetcher },
      { resolvePolicy: (id) => (id === 'author/model' ? { looseTools: true } : undefined) },
    );
    await completeText({
      driver: provider.create('author/model'),
      prompt: 'hi',
      tools: { lookup: defineAgentTool({ input: z.object({}), execute: async () => 'x' }) },
    });
    expect(bodies[0]).toMatchObject({ tools: [{ function: { strict: false } }] });
  });

  test('the route store is least-recently-used, and a long key becomes a valid session id', async () => {
    const store = createMemoryOpenRouterRouteStore({ maxEntries: 2 });
    await store.set('a', { kind: 'session-sticky', sessionId: 'a' });
    await store.set('b', { kind: 'session-sticky', sessionId: 'b' });
    await store.get('a');
    await store.set('c', { kind: 'session-sticky', sessionId: 'c' });
    expect(await store.get('b')).toBeUndefined();
    expect(await store.get('a')).toBeDefined();
    const resolver = createOpenRouterRouteResolver({
      store: createMemoryOpenRouterRouteStore(),
      strategy: 'session-sticky',
    });
    const policy = await resolver.policyFor('k'.repeat(300));
    expect(policy.sessionId).toHaveLength(64);
  });

  test('prices: an empty string, a negative or a hex value is no price; endpoint context and request price are kept', async () => {
    const fetcher = async (url: URL) =>
      url.pathname.endsWith('/endpoints')
        ? Response.json({
            data: { endpoints: [{ provider_name: 'up', context_length: 64_000 }] },
          })
        : Response.json({
            data: [
              {
                id: 'a/empty',
                name: 'E',
                context_length: 1,
                architecture: { input_modalities: ['text', 'image'] },
                pricing: { prompt: '', completion: '0x10', request: '-1' },
              },
              {
                id: 'a/request',
                name: 'R',
                context_length: 1,
                architecture: { input_modalities: [] },
                pricing: { request: '0.002' },
              },
            ],
          });
    const snapshot = await loadOpenRouterCatalogSnapshot({
      apiKey: 'k',
      fetcher,
      endpointsFor: ['a/request'],
    });
    expect(snapshot.models[0]).toMatchObject({
      id: 'a/empty',
      name: 'E',
      inputModalities: ['text', 'image'],
    });
    expect(snapshot.models[0]?.promptUsdPerMillion).toBeUndefined();
    expect(snapshot.models[0]?.completionUsdPerMillion).toBeUndefined();
    expect(snapshot.models[0]?.requestUsd).toBeUndefined();
    expect(snapshot.models[1]).toMatchObject({
      requestUsd: 0.002,
      endpoints: [{ provider: 'up', contextLength: 64_000 }],
    });
  });

  test('the first failed endpoint request stops the others', async () => {
    let calls = 0;
    const fetcher = async (url: URL) => {
      if (!url.pathname.endsWith('/endpoints')) return Response.json(models);
      calls += 1;
      if (calls === 2) return new Response('{}', { status: 500 });
      await Bun.sleep(5);
      return Response.json({ data: { endpoints: [] } });
    };
    await expect(
      loadOpenRouterCatalogSnapshot({
        apiKey: 'k',
        fetcher,
        concurrency: 3,
        endpointsFor: Array.from({ length: 10 }, (_, i) => `a/m${i}`),
      }),
    ).rejects.toThrow('HTTP 500');
    // Three in flight when the second fails; none started after it, even later.
    await Bun.sleep(80);
    expect(calls).toBe(3);
  });

  test('admission refuses openrouter/auto, a missing modality, and a snapshot from the future', () => {
    const snapshot: OpenRouterCatalogSnapshot = {
      schemaVersion: 1,
      observedAt: '2026-11-24T00:00:00.000Z',
      models: [
        {
          id: 'a/text',
          inputModalities: ['text'],
          contextLength: 1_000,
          supportedParameters: [],
        },
      ],
    };
    const decide = (modelId: string, policy: Record<string, unknown>, now: string) =>
      evaluateOpenRouterModelAdmission({
        snapshot,
        modelId,
        policy: { maxSnapshotAgeMs: 60_000, ...policy },
        now: () => new Date(now),
      });
    expect(decide('openrouter/auto', {}, '2026-11-24T00:00:01.000Z')).toMatchObject({
      reason: 'floating-alias',
    });
    expect(
      decide('a/text', { requiredInputModalities: ['image'] }, '2026-11-24T00:00:01.000Z'),
    ).toMatchObject({
      state: 'rejected',
      reason: 'missing-modality',
    });
    expect(decide('a/text', {}, '2026-11-23T23:00:00.000Z')).toMatchObject({
      state: 'unverified',
      reason: 'stale-snapshot',
    });
    expect(
      OpenRouterModelAdmissionSchema.parse(decide('a/text', {}, '2026-11-24T00:00:01.000Z')),
    ).toEqual({ state: 'admitted' });
  });

  test('the reconciler reads the key per record, keeps reasoning tokens, and honours its timeout', async () => {
    const keys: (string | null)[] = [];
    const reconcile = createOpenRouterSpendReconciler({
      apiKey: (record) => `key-of-${record.attempt.attribution.scope}`,
      fetcher: async (_url, init) => {
        keys.push(new Headers(init?.headers).get('authorization'));
        return Response.json({ data: { total_cost: 0.1, native_tokens_reasoning: 7 } });
      },
    });
    const record = {
      attempt: {
        attemptId: 'a',
        gateway: 'openrouter',
        startedAt: '2026-11-24T00:00:00.000Z',
        attribution: { purpose: 'p', scope: 'space-9' },
        request: { method: 'POST', origin: 'https://openrouter.ai', path: '/' },
      },
      receipt: {
        attemptId: 'a',
        rank: 1 as const,
        at: '2026-11-24T00:00:01.000Z',
        outcome: 'succeeded' as const,
        facts: { costStatus: 'pending' as const, providerRequestId: 'g' },
      },
    };
    expect(await reconcile(record)).toMatchObject({ reasoningTokens: 7, costUsd: 0.1 });
    expect(keys).toEqual(['Bearer key-of-space-9']);
    const slow = createOpenRouterSpendReconciler({
      apiKey: 'k',
      timeoutMs: 20,
      fetcher: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    });
    await expect(slow(record)).rejects.toThrow();
  });

  test('a catalog row with an unknown price no longer fails the whole model catalog', async () => {
    const fetcher = async (url: URL) =>
      url.pathname.endsWith('/models')
        ? Response.json(models)
        : Response.json({ data: [], meta: { as_of: '2026-11-24T00:00:00.000Z' } });
    const catalog = await openRouterModelCatalog({ apiKey: 'k', fetcher }).load();
    expect(
      catalog.models.find((model) => model.id === 'author/unpriced')?.price,
    ).toBeUndefined();
  });

  test('session-sticky hashes conversationIds over 256 characters to stay within OpenRouter limit', async () => {
    const resolver = createOpenRouterRouteResolver({
      store: createMemoryOpenRouterRouteStore(),
      strategy: 'session-sticky',
    });
    const longId = 'c'.repeat(300);
    const policy = await resolver.policyFor(longId);
    expect(policy.sessionId).toBeDefined();
    expect((policy.sessionId ?? '').length).toBeLessThanOrEqual(256);
    expect(policy.sessionId).not.toBe(longId);
  });
});
