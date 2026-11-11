import { describe, expect, test } from 'bun:test';
import { ZodError, z } from 'zod';
import { createClient, createUrlBuilder } from '../src/browser/client';
import { createCli } from '../src/entrypoints/cli';
import {
  type ContractFactoryConfig,
  createContractFactory,
  defineContract,
  type EndpointStreamDescriptor,
  forbidden,
  type Transport,
} from '../src/entrypoints/contract';
import { createHandler, implement } from '../src/entrypoints/server';
import { listToolNames } from '../src/entrypoints/tools';

const TextSchema = z.string();
const JsonSchema = z.object({ value: z.string() });
const base = createContractFactory<'public'>();

describe('factory policy validation', () => {
  test('optional intrinsic capability materializes its actual filtered exposure', () => {
    const endpoint: {
      method: 'GET';
      path: '/';
      desc: string;
      stream?: EndpointStreamDescriptor;
    } = {
      method: 'GET',
      path: '/',
      desc: 'Optional stream',
      stream: { item: TextSchema },
    };
    const contract = base
      .configure({ toolExposure: { default: ['CLI'] } })
      .defineContract({ prefix: 'optional-stream', scope: 'public' }, { read: endpoint });
    expect(contract.endpoints.read.expose).toEqual([]);
  });
  test('a widened configured policy does not create HTTP client methods at runtime', () => {
    const policy: ContractFactoryConfig = { toolExposure: { default: ['CLI'] } };
    const contract = base.configure(policy).defineContract(
      { prefix: 'widened', scope: 'public' },
      {
        read: { method: 'GET', path: '/', desc: 'Read', output: TextSchema },
      },
    );
    expect(contract.endpoints.read.expose).toEqual(['CLI']);
    expect(Reflect.has(createClient(contract, { baseUrl: 'http://localhost' }), 'read')).toBe(
      false,
    );
    expect(
      Reflect.has(createUrlBuilder(contract, { baseUrl: 'http://localhost' }), 'read'),
    ).toBe(false);
  });
  test('each configure snapshots defaults without changing endpoints or sibling factories', () => {
    const defaults: Transport[] = ['HTTP', 'CLI'];
    const configured = base.configure({ toolExposure: { default: defaults } });
    const http = base.configure({ toolExposure: { default: ['HTTP'] } });
    const explicit: Transport[] = ['AGENT'];
    const endpoints = {
      read: { method: 'GET', path: '/', desc: 'Read', output: TextSchema },
      raw: { method: 'GET', path: '/raw', desc: 'Raw', rawResponse: true },
      override: { method: 'GET', path: '/override', desc: 'Override', expose: explicit },
    } satisfies Parameters<typeof base.defineContract>[1];
    defaults.splice(0, defaults.length, 'MCP');
    const result = configured.defineContract(
      { prefix: 'snapshot', scope: 'public' },
      endpoints,
    );
    expect(result.endpoints.read.expose).toEqual(['HTTP', 'CLI']);
    expect(Object.isFrozen(result.endpoints.read.expose)).toBe(true);
    expect(result.endpoints.raw.expose).toEqual(['HTTP']);
    expect(Object.isFrozen(result.endpoints.raw.expose)).toBe(true);
    expect(Object.hasOwn(endpoints.read, 'expose')).toBe(false);
    expect(result.endpoints.override).toBe(endpoints.override);
    expect(result.endpoints.override.expose).toBe(explicit);
    expect(
      http.defineContract({ prefix: 'http', scope: 'public' }, endpoints).endpoints.read
        .expose,
    ).toEqual(['HTTP']);
    expect(
      base.defineContract({ prefix: 'base', scope: 'public' }, endpoints).endpoints.read,
    ).toBe(endpoints.read);
    expect(defaults).toEqual(['MCP']);
    expect(explicit).toEqual(['AGENT']);
  });

  test('undefined exposure uses defaults and explicit empty exposure overrides them', () => {
    const configured = base.configure({ toolExposure: { default: ['HTTP', 'CLI'] } });
    const contract = configured.defineContract(
      { prefix: 'overrides', scope: 'public' },
      {
        read: { method: 'GET', path: '/', desc: 'Read', expose: undefined },
        hidden: { method: 'GET', path: '/hidden', desc: 'Hidden', expose: [] },
        mcp: { method: 'GET', path: '/mcp', desc: 'MCP override', expose: ['MCP'] },
      },
    );
    expect(contract.endpoints.read.expose).toEqual(['HTTP', 'CLI']);
    expect(contract.endpoints.hidden.expose).toEqual([]);
    expect(contract.endpoints.mcp.expose).toEqual(['MCP']);
  });

  test('removed constructor arguments and malformed config refuse instead of defaulting open', () => {
    for (const config of [
      undefined,
      {},
      { toolExposure: 'explicit' },
      { toolExposure: { default: ['HTTP', 'CLI'] } },
    ]) {
      expect(() => Reflect.apply(createContractFactory, undefined, [config])).toThrow(
        'takes no arguments',
      );
    }
    for (const config of [
      null,
      {},
      { toolExposure: null },
      { toolExposure: 'explicit' },
      { toolExposure: { default: null } },
      { toolExposure: { default: 'HTTP' } },
      { toolExposure: { default: ['UNKNOWN'] } },
      { toolExposure: { default: ['HTTP'], extra: true } },
      { toolExposure: { default: ['HTTP'] }, extra: true },
      { toolExposure: { default: ['CLI', 'CLI'] } },
    ]) {
      expect(() => Reflect.apply(base.configure, undefined, [config])).toThrow(ZodError);
    }
  });

  test('malformed explicit exposure names the contract and endpoint', () => {
    for (const expose of [null, 'HTTP', ['HTTP', 'UNKNOWN'], ['HTTP', 'HTTP'], {}]) {
      const endpoints = JSON.parse(
        JSON.stringify({ bad: { method: 'GET', path: '/', desc: 'Bad', expose } }),
      );
      expect(() =>
        base
          .configure({ toolExposure: { default: ['HTTP'] } })
          .defineContract({ prefix: 'malformed', scope: 'public' }, endpoints),
      ).toThrow(
        'Contract "malformed": endpoint "bad" expose must be an array of distinct transports: HTTP / MCP / AGENT / CLI',
      );
    }
  });

  test('all intrinsic kinds reject explicit non-HTTP exposure before projection', () => {
    const variants = [
      { method: 'GET', rawResponse: true },
      { method: 'HEAD', rawResponse: true },
      { method: 'POST', rawBody: true, input: JsonSchema },
      { method: 'POST', multipart: { files: { file: {} } } },
      { method: 'GET', responseMeta: {} },
    ];
    for (const variant of variants) {
      const endpoints = JSON.parse('{"bad":{"path":"/","desc":"Bad","expose":["CLI"]}}');
      Object.assign(endpoints.bad, variant);
      expect(() =>
        base
          .configure({ toolExposure: { default: ['HTTP', 'CLI'] } })
          .defineContract({ prefix: 'contradictory', scope: 'public' }, endpoints),
      ).toThrow(
        'Contract "contradictory": endpoint "bad" is HTTP-only — remove CLI from expose',
      );
      expect(() => defineContract({ prefix: 'plain' }, endpoints)).toThrow('HTTP-only');
    }
  });

  test('a stream is carried by HTTP and CLI and refuses every tool transport', () => {
    const stream = (expose: string[]) => {
      const endpoints = JSON.parse('{"feed":{"method":"GET","path":"/","desc":"Feed"}}');
      Object.assign(endpoints.feed, { expose, stream: { item: TextSchema } });
      return endpoints;
    };
    expect(() => defineContract({ prefix: 'plain' }, stream(['HTTP', 'CLI']))).not.toThrow();
    for (const transport of ['MCP', 'AGENT']) {
      expect(() => defineContract({ prefix: 'plain' }, stream(['HTTP', transport]))).toThrow(
        `Contract "plain": endpoint "feed" is a stream, carried by HTTP and CLI only — remove ${transport} from expose`,
      );
    }
  });

  test('hidden endpoints still validate descriptions, descriptors and tool options', () => {
    const hidden = base.configure({ toolExposure: { default: [] } });
    expect(() =>
      hidden.defineContract(
        { prefix: 'hidden', scope: 'public' },
        {
          bad: { method: 'GET', path: '/', desc: '' },
        },
      ),
    ).toThrow('empty desc');
    expect(() =>
      hidden.defineContract(
        { prefix: 'hidden', scope: 'public' },
        {
          bad: { method: 'POST', path: '/', desc: 'Bad', multipart: { files: {} } },
        },
      ),
    ).toThrow('must declare at least one file field');
    for (const defaults of [[], ['HTTP']] satisfies Transport[][]) {
      expect(() =>
        base
          .configure({ toolExposure: { default: defaults } })
          .defineContract(
            { prefix: 'hidden', scope: 'public' },
            { bad: { method: 'GET', path: '/', desc: 'Bad', tool: { name: 'bad' } } },
          ),
      ).toThrow('not exposed on any tool transport');
    }
  });

  test('duplicate tool names use materialized defaults and explicit disjoint transports', () => {
    const configured = base.configure({ toolExposure: { default: ['CLI'] } });
    const one = {
      method: 'GET',
      path: '/one',
      desc: 'One',
      tool: { name: 'same' },
    } satisfies Parameters<typeof base.defineContract>[1][string];
    const two = { ...one, path: '/two' };
    expect(() =>
      configured.defineContract({ prefix: 'duplicate', scope: 'public' }, { one, two }),
    ).toThrow('duplicate tool name "same" on transport "CLI"');
    const contract = configured.defineContract(
      { prefix: 'disjoint', scope: 'public' },
      {
        one,
        two: { ...two, expose: ['MCP'] },
      },
    );
    expect(
      listToolNames({
        services: [implement(contract, { one: () => undefined, two: () => undefined })],
      }),
    ).toEqual([
      {
        kind: 'contract',
        name: 'same',
        service: 'disjoint',
        method: 'two',
        transports: ['MCP'],
      },
      {
        kind: 'contract',
        name: 'same',
        service: 'disjoint',
        method: 'one',
        transports: ['CLI'],
      },
    ]);
  });

  test('default exposure does not bypass scope gates or contract metadata', async () => {
    const scoped = createContractFactory<'admin'>().configure({
      toolExposure: { default: ['HTTP', 'CLI'] },
    });
    const contract = scoped.defineContract(
      { prefix: 'secure', scope: 'admin', meta: { category: 'base' } },
      {
        read: { method: 'GET', path: '/', desc: 'Read', meta: { action: 'read' } },
      },
    );
    let calls = 0;
    const service = implement(contract, {
      read: () => {
        calls += 1;
      },
    });
    let observed: unknown;
    const handler = createHandler({
      services: [service],
      hooks: {
        beforeHandle: (_context, endpoint) => {
          observed = { scope: endpoint.scope, meta: endpoint.meta };
          forbidden('access denied');
        },
      },
    });
    expect((await handler(new Request('http://localhost/secure'))).status).toBe(403);
    expect(observed).toEqual({ scope: 'admin', meta: { category: 'base', action: 'read' } });
    let code = -1;
    let error = '';
    await createCli({
      name: 'secure',
      version: '1',
      services: [service],
      argv: ['read_secure', '--json'],
      stdout: () => undefined,
      stderr: (text) => {
        error += text;
      },
      exit: (value) => {
        code = value;
      },
      stdin: async () => null,
      lifecycle: {
        beforeHandle: (_context, endpoint) => {
          expect(endpoint.scope).toBe('admin');
          forbidden('access denied');
        },
      },
    });
    expect(code).toBe(3);
    expect(error).toContain('access denied');
    expect(calls).toBe(0);
  });
});
