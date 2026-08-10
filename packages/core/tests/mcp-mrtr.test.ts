import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract, type RuntimeContext } from '../src/contract';
import { createObservability } from '../src/observability';
import { getTraceId } from '../src/observability/context';
import { createImplement } from '../src/server/implement';
import { createMcpHandler } from '../src/tools/mcp-handler';
import { createRuntimeToolFactory } from '../src/tools/runtime-tool';

const MODERN = '2026-07-28';
const KEY = '0123456789abcdef0123456789abcdef';
const confirmationSchema = z.object({ confirmed: z.boolean() });
const reasonSchema = z.object({ reason: z.string().min(3) });

function envelope(capabilities: Record<string, unknown> = { elicitation: { form: {} } }) {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientInfo': { name: 'mrtr-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': capabilities,
  };
}

function modernCall(
  name: string,
  args: Record<string, unknown>,
  options: {
    identity?: string;
    inputResponses?: Record<string, unknown>;
    requestState?: string;
    capabilities?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  } = {},
): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: options.identity ?? 'alpha',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      'mcp-protocol-version': MODERN,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: { ...envelope(options.capabilities), ...options.meta },
        ...(options.inputResponses !== undefined && {
          inputResponses: options.inputResponses,
        }),
        ...(options.requestState !== undefined && { requestState: options.requestState }),
      },
    }),
  });
}

async function result(response: Response): Promise<Record<string, unknown>> {
  const body = z
    .object({ result: z.record(z.string(), z.unknown()) })
    .parse(await response.json());
  return body.result;
}

function required(resultValue: Record<string, unknown>): string {
  expect(resultValue.resultType).toBe('input_required');
  return z.string().parse(resultValue.requestState);
}

interface DeleteContext extends RuntimeContext {
  identity: string;
}

const deleteContract = defineContract(
  { prefix: 'projects', scope: 'admin' },
  {
    remove: {
      method: 'DELETE',
      path: '/:id',
      desc: 'Delete a project',
      expose: ['MCP', 'AGENT', 'CLI'],
      params: z.object({ id: z.string() }),
      output: z.object({ deleted: z.string(), confirmedBy: z.string() }),
      mcp: {
        inputRequired: [
          {
            key: 'confirmation',
            message: 'Delete this project?',
            schema: confirmationSchema,
          },
        ],
      },
    },
  },
);

describe('framework-owned MCP multi-round input', () => {
  test('uses the current request trace metadata for every round', async () => {
    const traceIds: string[] = [];
    const service = createImplement<DeleteContext>()(deleteContract, {
      remove: (context) => ({
        deleted: context.params.id,
        confirmedBy: String(context.mcpInput?.confirmation.confirmed),
      }),
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'mrtr-test', version: '1' },
      auth: () => ({ identity: 'alpha' }),
      context: (auth) => auth,
      services: [service],
      hooks: {
        afterToolCall: () => {
          const traceId = getTraceId();
          if (traceId) traceIds.push(traceId);
        },
      },
      multiRound: { state: { key: KEY, principal: (auth) => auth.identity } },
    });
    const firstTrace = '11111111111111111111111111111111';
    const retryTrace = '22222222222222222222222222222222';
    const state = required(
      await result(
        await handler.fetch(
          modernCall(
            'remove_project',
            { id: 'traced' },
            {
              meta: { traceparent: `00-${firstTrace}-1111111111111111-01` },
            },
          ),
        ),
      ),
    );
    await handler.fetch(
      modernCall(
        'remove_project',
        { id: 'traced' },
        {
          requestState: state,
          inputResponses: {
            confirmation: { action: 'accept', content: { confirmed: true } },
          },
          meta: { traceparent: `00-${retryTrace}-2222222222222222-01` },
        },
      ),
    );

    expect(traceIds).toEqual([firstTrace, retryTrace]);
    await handler.close();
  });

  test('audit rows mark every input round and the completion, distinguishable without context.mcp', async () => {
    const events: Array<{ toolPhase?: string; ok: boolean }> = [];
    const observability = createObservability({
      tools: {
        write: (event) => {
          events.push({ toolPhase: event.toolPhase, ok: event.ok });
        },
      },
    });
    const service = createImplement<DeleteContext>()(deleteContract, {
      remove: (context) => ({
        deleted: context.params.id,
        confirmedBy: String(context.mcpInput?.confirmation.confirmed),
      }),
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'mrtr-test', version: '1' },
      auth: () => ({ identity: 'alpha' }),
      context: (auth) => auth,
      services: [service],
      hooks: observability.toolCall,
      multiRound: { state: { key: KEY, principal: (auth) => auth.identity } },
    });
    const state = required(
      await result(await handler.fetch(modernCall('remove_project', { id: 'audited' }))),
    );
    const completed = await result(
      await handler.fetch(
        modernCall(
          'remove_project',
          { id: 'audited' },
          {
            requestState: state,
            inputResponses: {
              confirmation: { action: 'accept', content: { confirmed: true } },
            },
          },
        ),
      ),
    );
    expect(completed.resultType).toBe('complete');
    // The write sink is fire-and-forget — let the queued emits settle.
    await Bun.sleep(0);
    // One marked intermediate round, one completion — the audit STREAM tells
    // them apart via `toolPhase`, no `context.mcp` parsing required.
    expect(events.map((event) => event.toolPhase)).toEqual(['input-round', 'operation']);
    expect(events.every((event) => event.ok)).toBe(true);
    await handler.close();
  });

  test('runs ordered rounds and exposes one typed aggregate only to the final handler', async () => {
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
              { key: 'confirmation', message: 'Release?', schema: confirmationSchema },
              { key: 'reason', message: 'Why?', schema: reasonSchema },
            ],
          },
        },
      },
    );
    let executions = 0;
    const service = createImplement<DeleteContext>()(multiRoundContract, {
      release: (context) => {
        executions += 1;
        return {
          summary: `${String(context.mcpInput?.confirmation.confirmed)}:${context.mcpInput?.reason.reason}`,
        };
      },
    });
    const attempts: Array<{ outcome?: string; round?: number }> = [];
    const handler = createMcpHandler({
      serverInfo: { name: 'mrtr-test', version: '1' },
      auth: () => ({ identity: 'alpha' }),
      context: (auth) => auth,
      services: [service],
      hooks: {
        afterToolCall: ({ context }) => {
          attempts.push(context.mcp ?? {});
        },
      },
      multiRound: {
        state: { key: KEY, principal: (auth) => auth.identity },
        serving: { maxRounds: 2 },
      },
    });

    const firstState = required(
      await result(await handler.fetch(modernCall('release_deployment', { id: 'd1' }))),
    );
    const second = await result(
      await handler.fetch(
        modernCall(
          'release_deployment',
          { id: 'd1' },
          {
            requestState: firstState,
            inputResponses: {
              confirmation: { action: 'accept', content: { confirmed: true } },
            },
          },
        ),
      ),
    );
    const secondState = required(second);
    expect(executions).toBe(0);
    const completed = await result(
      await handler.fetch(
        modernCall(
          'release_deployment',
          { id: 'd1' },
          {
            requestState: secondState,
            inputResponses: { reason: { action: 'accept', content: { reason: 'approved' } } },
          },
        ),
      ),
    );
    expect(completed.structuredContent).toEqual({ summary: 'true:approved' });
    expect(executions).toBe(1);
    expect(attempts).toEqual([
      expect.objectContaining({ outcome: 'input_required', round: 0 }),
      expect.objectContaining({ outcome: 'input_required', round: 1 }),
      expect.objectContaining({ outcome: 'complete', round: 1 }),
    ]);
    await handler.close();
  });

  test('contract tool validates the guard round and executes only after accepted typed input', async () => {
    let sideEffects = 0;
    const attempts: Array<{ ok: boolean; mcp: unknown }> = [];
    const implement = createImplement<DeleteContext>();
    const service = implement(deleteContract, {
      remove: (context) => {
        sideEffects += 1;
        return {
          deleted: context.params.id,
          confirmedBy: String(context.mcpInput?.confirmation.confirmed),
        };
      },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'mrtr-test', version: '1' },
      auth: (request) => ({ identity: request.headers.get('authorization') ?? '' }),
      context: (auth) => auth,
      services: [service],
      lifecycle: {
        beforeHandle: (context) => {
          if (!context.identity) throw new Error('identity required');
        },
      },
      hooks: {
        afterToolCall: ({ result: toolResult, context }) => {
          attempts.push({ ok: toolResult.ok, mcp: context.mcp });
        },
      },
      multiRound: { state: { key: KEY, principal: (auth) => auth.identity } },
    });

    const initial = await result(
      await handler.fetch(modernCall('remove_project', { id: 'p1' })),
    );
    const requestState = required(initial);
    expect(sideEffects).toBe(0);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.mcp).toMatchObject({
      era: 'modern',
      method: 'tools/call',
      clientInfo: { name: 'mrtr-test', version: '1' },
    });

    const completed = await result(
      await handler.fetch(
        modernCall(
          'remove_project',
          { id: 'p1' },
          {
            requestState,
            inputResponses: {
              confirmation: { action: 'accept', content: { confirmed: true } },
            },
          },
        ),
      ),
    );
    expect(completed.resultType).toBe('complete');
    expect(completed.structuredContent).toEqual({ deleted: 'p1', confirmedBy: 'true' });
    expect(sideEffects).toBe(1);
    expect(attempts).toHaveLength(2);
    await handler.close();
  });

  test('decline, cancellation and malformed accepted content never execute the side effect', async () => {
    let sideEffects = 0;
    const implement = createImplement<DeleteContext>();
    const service = implement(deleteContract, {
      remove: (context) => {
        sideEffects += 1;
        return { deleted: context.params.id, confirmedBy: 'yes' };
      },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'mrtr-test', version: '1' },
      auth: () => ({ identity: 'alpha' }),
      context: (auth) => auth,
      services: [service],
      multiRound: { state: { key: KEY, principal: (auth) => auth.identity } },
    });

    for (const action of ['decline', 'cancel']) {
      const state = required(
        await result(await handler.fetch(modernCall('remove_project', { id: action }))),
      );
      const rejected = await result(
        await handler.fetch(
          modernCall(
            'remove_project',
            { id: action },
            {
              requestState: state,
              inputResponses: { confirmation: { action } },
            },
          ),
        ),
      );
      expect(JSON.stringify(rejected)).toContain(
        action === 'decline' ? 'INPUT_DECLINED' : 'INPUT_CANCELLED',
      );
    }

    const malformedState = required(
      await result(await handler.fetch(modernCall('remove_project', { id: 'malformed' }))),
    );
    const malformed = await result(
      await handler.fetch(
        modernCall(
          'remove_project',
          { id: 'malformed' },
          {
            requestState: malformedState,
            inputResponses: {
              confirmation: { action: 'accept', content: { confirmed: 'not-a-boolean' } },
            },
          },
        ),
      ),
    );
    expect(JSON.stringify(malformed)).toContain('INVALID_INPUT_RESPONSE');
    expect(sideEffects).toBe(0);
    await handler.close();
  });

  test('tampered, cross-principal and changed-argument continuations fail before the handler', async () => {
    let sideEffects = 0;
    const implement = createImplement<DeleteContext>();
    const service = implement(deleteContract, {
      remove: (context) => {
        sideEffects += 1;
        return { deleted: context.params.id, confirmedBy: 'yes' };
      },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'mrtr-test', version: '1' },
      auth: (request) => ({ identity: request.headers.get('authorization') ?? '' }),
      context: (auth) => auth,
      services: [service],
      multiRound: { state: { key: KEY, principal: (auth) => auth.identity } },
    });
    const state = required(
      await result(await handler.fetch(modernCall('remove_project', { id: 'p1' }))),
    );
    const inputResponses = {
      confirmation: { action: 'accept', content: { confirmed: true } },
    };

    const tampered = await handler.fetch(
      modernCall(
        'remove_project',
        { id: 'p1' },
        {
          requestState: `${state.slice(0, -1)}x`,
          inputResponses,
        },
      ),
    );
    expect(JSON.stringify(await tampered.json())).toContain('Invalid or expired requestState');

    const foreign = await handler.fetch(
      modernCall(
        'remove_project',
        { id: 'p1' },
        {
          identity: 'beta',
          requestState: state,
          inputResponses,
        },
      ),
    );
    expect(JSON.stringify(await foreign.json())).toContain('Invalid or expired requestState');

    const changed = await result(
      await handler.fetch(
        modernCall('remove_project', { id: 'p2' }, { requestState: state, inputResponses }),
      ),
    );
    expect(JSON.stringify(changed)).toContain('INVALID_REQUEST_STATE');
    expect(sideEffects).toBe(0);
    await handler.close();
  });

  test('expired continuation state fails before the handler', async () => {
    let sideEffects = 0;
    const service = createImplement<DeleteContext>()(deleteContract, {
      remove: (context) => {
        sideEffects += 1;
        return { deleted: context.params.id, confirmedBy: 'yes' };
      },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'mrtr-test', version: '1' },
      auth: () => ({ identity: 'alpha' }),
      context: (auth) => auth,
      services: [service],
      multiRound: {
        state: { key: KEY, principal: (auth) => auth.identity, ttlSeconds: 1 },
      },
    });
    const state = required(
      await result(await handler.fetch(modernCall('remove_project', { id: 'expired' }))),
    );
    // The SDK signs whole-second timestamps, so cross the full second plus its
    // boundary before presenting the continuation again.
    await Bun.sleep(2_100);
    const expired = await handler.fetch(
      modernCall(
        'remove_project',
        { id: 'expired' },
        {
          requestState: state,
          inputResponses: {
            confirmation: { action: 'accept', content: { confirmed: true } },
          },
        },
      ),
    );
    expect(JSON.stringify(await expired.json())).toContain('Invalid or expired requestState');
    expect(sideEffects).toBe(0);
    await handler.close();
  });

  test('replayed valid state relies on application idempotency instead of promising exactly-once', async () => {
    const completed = new Set<string>();
    let sideEffects = 0;
    const service = createImplement<DeleteContext>()(deleteContract, {
      remove: (context) => {
        if (!completed.has(context.params.id)) {
          completed.add(context.params.id);
          sideEffects += 1;
        }
        return { deleted: context.params.id, confirmedBy: 'yes' };
      },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'mrtr-test', version: '1' },
      auth: () => ({ identity: 'alpha' }),
      context: (auth) => auth,
      services: [service],
      multiRound: { state: { key: KEY, principal: (auth) => auth.identity } },
    });
    const state = required(
      await result(await handler.fetch(modernCall('remove_project', { id: 'once' }))),
    );
    const continuation = () =>
      handler.fetch(
        modernCall(
          'remove_project',
          { id: 'once' },
          {
            requestState: state,
            inputResponses: {
              confirmation: { action: 'accept', content: { confirmed: true } },
            },
          },
        ),
      );
    const [first, replay] = await Promise.all([continuation(), continuation()]);
    expect((await result(first)).resultType).toBe('complete');
    expect((await result(replay)).resultType).toBe('complete');
    expect(sideEffects).toBe(1);
    await handler.close();
  });

  test('binds continuation state to the full operation identity even when tool names match', async () => {
    const makeHandler = (serviceName: string, action: string) => {
      const tools = createRuntimeToolFactory({
        serviceName,
        scope: 'admin',
        context: z.object({ identity: z.string() }),
      });
      return createMcpHandler({
        serverInfo: { name: 'mrtr-test', version: '1' },
        auth: () => ({ identity: 'alpha' }),
        context: (auth) => auth,
        services: [],
        runtimeTools: [
          tools.define({
            name: 'shared_name',
            description: 'Identity binding fixture',
            action,
            method: 'POST',
            input: z.object({ id: z.string() }),
            output: z.object({ id: z.string() }),
            mcp: {
              inputRequired: [
                { key: 'confirmation', message: 'Continue?', schema: confirmationSchema },
              ],
            },
            handler: ({ input }) => input,
          }),
        ],
        multiRound: { state: { key: KEY, principal: (auth) => auth.identity } },
      });
    };
    const source = makeHandler('source', 'publish');
    const target = makeHandler('target', 'archive');
    const state = required(
      await result(await source.fetch(modernCall('shared_name', { id: 'same' }))),
    );
    const replayed = await result(
      await target.fetch(
        modernCall(
          'shared_name',
          { id: 'same' },
          {
            requestState: state,
            inputResponses: {
              confirmation: { action: 'accept', content: { confirmed: true } },
            },
          },
        ),
      ),
    );
    expect(JSON.stringify(replayed)).toContain('INVALID_REQUEST_STATE');
    await Promise.all([source.close(), target.close()]);
  });

  test('fails first on duplicate round keys and max-round overflow', async () => {
    const makePolicy = (keys: string[], maxRounds: number) => {
      const runtimeTools = createRuntimeToolFactory({
        serviceName: 'policy',
        context: z.object({ identity: z.string() }),
      });
      const tool = runtimeTools.define({
        name: `policy_${keys.join('_')}`,
        description: 'Policy validation fixture',
        action: 'validate',
        method: 'POST',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        mcp: {
          inputRequired: keys.map((key) => ({
            key,
            message: key,
            schema: confirmationSchema,
          })),
        },
        handler: () => ({ ok: true }),
      });
      return createMcpHandler({
        serverInfo: { name: 'mrtr-test', version: '1' },
        auth: () => ({ identity: 'alpha' }),
        context: (auth) => auth,
        services: [],
        runtimeTools: [tool],
        multiRound: {
          state: { key: KEY, principal: (auth) => auth.identity },
          serving: { maxRounds },
        },
      });
    };
    expect(() => makePolicy(['same', 'same'], 2)).toThrow(
      'MCP tool "policy_same_same" declares duplicate input key "same"',
    );
    expect(() => makePolicy(['one', 'two'], 1)).toThrow(
      'MCP tool "policy_one_two" declares 2 input rounds, exceeding maxRounds 1',
    );
  });

  test('parallel runtime-tool flows keep typed input and identities isolated', async () => {
    const seen: string[] = [];
    const runtimeTools = createRuntimeToolFactory({
      serviceName: 'projects',
      scope: 'admin',
      context: z.object({ id: z.string() }),
    });
    const runtimeTool = runtimeTools.define({
      name: 'publish_project',
      description: 'Publish a project',
      action: 'publish',
      method: 'POST',
      input: z.object({ id: z.string() }),
      output: z.object({ value: z.string() }),
      mcp: {
        inputRequired: [
          {
            key: 'confirmation',
            message: 'Publish this project?',
            schema: confirmationSchema,
          },
        ],
      },
      handler: (context) => {
        if (!context.mcpInput) throw new Error('MCP confirmation is required');
        const value = `${context.id}:${context.input.id}:${String(context.mcpInput.confirmation.confirmed)}`;
        seen.push(value);
        return { value };
      },
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'mrtr-test', version: '1' },
      auth: (request) => ({ id: request.headers.get('authorization') ?? '' }),
      context: (auth) => auth,
      services: [],
      runtimeTools: [runtimeTool],
      multiRound: { state: { key: KEY, principal: (auth) => auth.id } },
    });
    const [alphaState, betaState] = await Promise.all([
      handler.fetch(modernCall('publish_project', { id: 'one' }, { identity: 'alpha' })),
      handler.fetch(modernCall('publish_project', { id: 'two' }, { identity: 'beta' })),
    ]).then(async (responses) =>
      Promise.all(responses.map(async (response) => required(await result(response)))),
    );
    const accepted = { confirmation: { action: 'accept', content: { confirmed: true } } };
    await Promise.all([
      handler.fetch(
        modernCall(
          'publish_project',
          { id: 'one' },
          {
            identity: 'alpha',
            requestState: alphaState,
            inputResponses: accepted,
          },
        ),
      ),
      handler.fetch(
        modernCall(
          'publish_project',
          { id: 'two' },
          {
            identity: 'beta',
            requestState: betaState,
            inputResponses: accepted,
          },
        ),
      ),
    ]);
    expect(seen.sort()).toEqual(['alpha:one:true', 'beta:two:true']);
    await handler.close();
  });

  test('legacy stateless and a modern client without elicitation support receive protocol errors', async () => {
    const implement = createImplement<DeleteContext>();
    const service = implement(deleteContract, {
      remove: (context) => ({ deleted: context.params.id, confirmedBy: 'yes' }),
    });
    const handler = createMcpHandler({
      serverInfo: { name: 'mrtr-test', version: '1' },
      auth: () => ({ identity: 'alpha' }),
      context: (auth) => auth,
      services: [service],
      multiRound: { state: { key: KEY, principal: (auth) => auth.identity } },
    });
    const unsupported = await handler.fetch(
      modernCall('remove_project', { id: 'p1' }, { capabilities: {} }),
    );
    const unsupportedBody = z
      .object({ error: z.object({ code: z.number() }) })
      .parse(await unsupported.json());
    expect(unsupportedBody.error.code).toBe(-32021);

    const legacy = await handler.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'remove_project', arguments: { id: 'p1' } },
        }),
      }),
    );
    const legacyBody = await legacy.text();
    expect(legacyBody).toContain('"isError":true');
    expect(legacyBody).toContain('did not declare the required capability');
    await handler.close();
  });
});
