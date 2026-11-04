import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createHttpClient } from '../src/browser/http';
import { type CliConfig, createCli } from '../src/entrypoints/cli';
import { createContractFactory, type Transport } from '../src/entrypoints/contract';
import {
  createHandler,
  generateOpenApiDocument,
  implement,
  type ServiceDef,
} from '../src/entrypoints/server';
import {
  buildToolManifest,
  listContractToolNames,
  listToolNames,
  summarizeTransports,
  type ToolNameEntry,
} from '../src/entrypoints/tools';
import { implementRemote } from '../src/tools/remote';

const TextSchema = z.string();
const InputSchema = z.object({ value: z.string() });
const policies: readonly Transport[][] = [['HTTP', 'CLI'], ['CLI'], []];

function capabilityContract(defaults: readonly Transport[]) {
  return createContractFactory<'public'>()
    .configure({ toolExposure: { default: defaults } })
    .defineContract(
      { prefix: 'capabilities', scope: 'public' },
      {
        raw: { method: 'GET', path: '/raw', desc: 'Raw', rawResponse: true },
        upload: {
          method: 'POST',
          path: '/upload',
          desc: 'Upload',
          multipart: { files: { file: {} } },
          output: TextSchema,
        },
        body: {
          method: 'POST',
          path: '/body',
          desc: 'Body',
          rawBody: true,
          input: InputSchema,
          output: TextSchema,
        },
        metadata: {
          method: 'GET',
          path: '/metadata',
          desc: 'Metadata',
          responseMeta: { status: 201 },
          output: TextSchema,
        },
        stream: {
          method: 'GET',
          path: '/stream',
          desc: 'Stream',
          stream: { item: TextSchema },
        },
        head: { method: 'HEAD', path: '/head', desc: 'Head', rawResponse: true },
        echo: { method: 'GET', path: '/echo', desc: 'Echo', output: TextSchema },
        safe: {
          method: 'POST',
          path: '/safe',
          desc: 'Safelisted JSON',
          input: InputSchema,
          output: TextSchema,
          safelistedBody: true,
        },
      },
    );
}

async function runCli(services: CliConfig['services'], command: string) {
  let output = '';
  let error = '';
  let code = -1;
  await createCli({
    name: 'capabilities',
    version: '1.0.0',
    services,
    argv: [command, '--json'],
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      error += text;
    },
    exit: (value) => {
      code = value;
    },
    stdin: async () => null,
  });
  return { output, error, code };
}

function capabilityRequests() {
  const upload = new FormData();
  upload.append('file', new File(['file'], 'file.txt'));
  return [
    new Request('http://localhost/capabilities/raw'),
    new Request('http://localhost/capabilities/upload', { method: 'POST', body: upload }),
    new Request('http://localhost/capabilities/body', {
      method: 'POST',
      body: '{"value":"body"}',
      headers: { 'content-type': 'application/json' },
    }),
    new Request('http://localhost/capabilities/metadata'),
    new Request('http://localhost/capabilities/stream'),
    new Request('http://localhost/capabilities/head', { method: 'HEAD' }),
  ];
}

describe('factory capability intersection', () => {
  test('a structural streaming MethodDef never becomes a default-on tool', () => {
    const service: ServiceDef = {
      name: 'stream-probe',
      prefix: 'stream-probe',
      scope: 'public',
      methods: {
        read: {
          serviceName: 'stream-probe',
          key: 'read',
          method: 'GET',
          path: '/',
          desc: 'Read a stream',
          stream: { item: TextSchema },
          handler: () => undefined,
        },
      },
    };
    expect(listToolNames({ services: [service] })).toEqual([]);
    expect(summarizeTransports({ services: [service] }).totals).toEqual({
      HTTP: 1,
      MCP: 0,
      AGENT: 0,
      CLI: 0,
    });
  });

  test('explicit empty raw exposure stays hidden instead of reopening HTTP', async () => {
    const contract = createContractFactory<'public'>()
      .configure({ toolExposure: { default: ['HTTP', 'CLI'] } })
      .defineContract(
        { prefix: 'hidden-raw', scope: 'public' },
        {
          read: {
            method: 'GET',
            path: '/',
            desc: 'Hidden raw',
            rawResponse: true,
            expose: [],
          },
          visible: {
            method: 'GET',
            path: '/visible',
            desc: 'Visible raw',
            rawResponse: true,
            expose: ['HTTP'],
          },
        },
      );
    let hiddenCalls = 0;
    let visibleCalls = 0;
    const service = implement(contract, {
      read: () => {
        hiddenCalls += 1;
        return new Response('hidden');
      },
      visible: () => {
        visibleCalls += 1;
        return new Response('visible');
      },
    });
    const handler = createHandler({ services: [service] });
    expect((await handler(new Request('http://localhost/hidden-raw'))).status).toBe(404);
    expect((await handler(new Request('http://localhost/hidden-raw/visible'))).status).toBe(
      200,
    );
    expect(hiddenCalls).toBe(0);
    expect(visibleCalls).toBe(1);
    expect(listToolNames({ services: [service] })).toEqual([]);
    expect(summarizeTransports({ services: [service] }).totals).toEqual({
      HTTP: 1,
      MCP: 0,
      AGENT: 0,
      CLI: 0,
    });
  });

  for (const defaults of policies) {
    test(`intrinsic HTTP endpoints respect default ${JSON.stringify(defaults)}`, async () => {
      const contract = capabilityContract(defaults);
      const counts = new Map<string, number>();
      function called(key: string): string {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return key;
      }
      const service = implement(contract, {
        raw: () => new Response(called('raw')),
        upload: () => called('upload'),
        body: () => called('body'),
        metadata: () => called('metadata'),
        stream: async function* () {
          yield called('stream');
        },
        head: () => {
          called('head');
          return new Response(null, { status: 204 });
        },
        echo: () => called('echo'),
        safe: () => called('safe'),
      });
      const http = defaults.includes('HTTP');
      const cli = defaults.includes('CLI');
      const intrinsic = ['raw', 'upload', 'body', 'metadata', 'stream', 'head'];
      const remote = implementRemote(
        contract,
        createHttpClient({ baseUrl: 'http://localhost' }),
      );
      for (const key of intrinsic) {
        expect(service.methods[key]?.expose).toEqual(http ? ['HTTP'] : []);
        expect(remote.methods[key]?.expose).toEqual(http ? ['HTTP'] : []);
      }
      const expectedNames: ToolNameEntry[] = cli
        ? [
            {
              kind: 'contract',
              name: 'echo_capability',
              service: 'capabilities',
              method: 'echo',
              transports: ['CLI'],
            },
            {
              kind: 'contract',
              name: 'safe_capability',
              service: 'capabilities',
              method: 'safe',
              transports: ['CLI'],
            },
          ]
        : [];
      expect(listToolNames({ services: [service] })).toEqual(expectedNames);
      expect(listContractToolNames([contract])).toEqual(expectedNames);
      for (const transport of ['MCP', 'AGENT', 'CLI'] satisfies ('MCP' | 'AGENT' | 'CLI')[]) {
        expect(
          buildToolManifest({ services: [service], transport }).map((entry) => entry.name),
        ).toEqual(transport === 'CLI' && cli ? ['echo_capability', 'safe_capability'] : []);
      }
      expect(summarizeTransports({ services: [service] }).totals).toEqual({
        HTTP: http ? 8 : 0,
        MCP: 0,
        AGENT: 0,
        CLI: cli ? 2 : 0,
      });
      const document = generateOpenApiDocument({
        info: { title: 'Capabilities', version: '1' },
        services: [service],
      });
      expect(Object.keys(document.paths).sort()).toEqual(
        http
          ? [
              '/capabilities/body',
              '/capabilities/echo',
              '/capabilities/head',
              '/capabilities/metadata',
              '/capabilities/raw',
              '/capabilities/safe',
              '/capabilities/stream',
              '/capabilities/upload',
            ]
          : [],
      );
      const handler = createHandler({ services: [service] });
      for (const request of capabilityRequests()) {
        const response = await handler(request);
        const expected =
          request.method === 'HEAD' ? 204 : request.url.endsWith('/metadata') ? 201 : 200;
        expect(response.status).toBe(http ? expected : 404);
        await response.text();
      }
      for (const key of intrinsic) {
        const refused = await runCli([service], `${key}_capability`);
        expect(refused.code).toBe(1);
        expect(refused.error).toContain('Unknown command');
        expect(counts.get(key) ?? 0).toBe(http ? 1 : 0);
      }
      const echo = await runCli([service], 'echo_capability');
      expect(echo.code).toBe(cli ? 0 : 1);
      expect(counts.get('echo') ?? 0).toBe(cli ? 1 : 0);
      if (cli) expect(JSON.parse(echo.output)).toBe('echo');
    });
  }
});
