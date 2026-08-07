import { describe, expect, test } from 'bun:test';
import { createHttpClient, defineContract } from '../src';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';
import { collectTools } from '../src/tools/mount';
import { implementRemote } from '../src/tools/remote';
import {
  ResultSchema,
  responseMetadataContract,
  responseMetadataService,
} from './response-metadata.fixture';

const bodylessStatuses: (204 | 205)[] = [204, 205];

describe('typed JSON response metadata — contract boundaries', () => {
  test('is forced HTTP-only in local and remote MethodDef producers', () => {
    expect(responseMetadataService.methods.data?.expose).toEqual(['HTTP']);
    expect(collectTools(responseMetadataService, 'MCP')).toEqual([]);
    expect(collectTools(responseMetadataService, 'AGENT')).toEqual([]);
    expect(collectTools(responseMetadataService, 'CLI')).toEqual([]);

    const remote = implementRemote(
      responseMetadataContract,
      createHttpClient({ baseUrl: 'http://localhost' }),
    );
    expect(remote.methods.data?.expose).toEqual(['HTTP']);
    expect(remote.methods.data?.responseMeta).toEqual({ status: 201 });
  });

  test('rejects invalid combinations assembled beyond TypeScript', () => {
    const badStatus = JSON.parse(
      '{"bad":{"method":"POST","path":"/","desc":"Bad","responseMeta":{"status":302}}}',
    );
    expect(() => defineContract({ prefix: 'bad-status' }, badStatus)).toThrow(
      'status must be a successful 2xx integer',
    );

    for (const status of bodylessStatuses) {
      const bodylessOutput = JSON.parse(
        `{"bad":{"method":"POST","path":"/","desc":"Bad","responseMeta":{"status":${status}}}}`,
      );
      bodylessOutput.bad.output = ResultSchema;
      expect(() =>
        defineContract({ prefix: `bodyless-output-${status}` }, bodylessOutput),
      ).toThrow(`cannot combine output with bodyless status ${status}`);
    }

    const raw = JSON.parse(
      '{"bad":{"method":"GET","path":"/","desc":"Bad","rawResponse":true,"responseMeta":{}}}',
    );
    expect(() => defineContract({ prefix: 'raw-meta' }, raw)).toThrow(
      'cannot also be a rawResponse endpoint',
    );

    const tool = JSON.parse(
      '{"bad":{"method":"POST","path":"/","desc":"Bad","toolName":"bad","responseMeta":{}}}',
    );
    expect(() => defineContract({ prefix: 'tool-meta' }, tool)).toThrow(
      'cannot set a toolName',
    );

    const missingObject = JSON.parse(
      '{"bad":{"method":"POST","path":"/","desc":"Bad","responseMeta":null}}',
    );
    expect(() => defineContract({ prefix: 'null-meta' }, missingObject)).toThrow(
      'must declare responseMeta as an object',
    );
  });

  test('rechecks bodyless output statuses on the runtime MethodDef boundary', async () => {
    const runtimeContract = defineContract(
      { prefix: 'runtime-meta' },
      {
        data: {
          method: 'GET',
          path: '/',
          desc: 'Runtime boundary probe',
          output: ResultSchema,
          responseMeta: {},
        },
      },
    );
    const runtimeService = implement(runtimeContract, { data: () => ({ value: 'runtime' }) });
    const method = runtimeService.methods.data;
    if (!method) throw new Error('Expected data MethodDef');
    for (const status of bodylessStatuses) {
      method.responseMeta = { status };
      const response = await createHandler({ services: [runtimeService] })(
        new Request('http://localhost/runtime-meta'),
      );
      expect(response.status).toBe(500);
    }
  });
});

function compileTimeContractChecks(): void {
  defineContract(
    // @ts-expect-error an output cannot use a bodyless response status
    { prefix: 'compile-bodyless' },
    {
      bad: {
        method: 'POST',
        path: '/',
        desc: 'Invalid',
        output: ResultSchema,
        responseMeta: { status: 204 },
      },
    },
  );
  defineContract(
    // @ts-expect-error an output cannot use a reset-content response status
    { prefix: 'compile-reset-content' },
    {
      bad: {
        method: 'POST',
        path: '/',
        desc: 'Invalid',
        output: ResultSchema,
        responseMeta: { status: 205 },
      },
    },
  );
  defineContract(
    // @ts-expect-error response metadata and raw response ownership are exclusive
    { prefix: 'compile-raw' },
    {
      bad: {
        method: 'GET',
        path: '/',
        desc: 'Invalid',
        rawResponse: true,
        responseMeta: {},
      },
    },
  );
  defineContract(
    // @ts-expect-error response metadata endpoints cannot be tools
    { prefix: 'compile-tool' },
    {
      bad: {
        method: 'POST',
        path: '/',
        desc: 'Invalid',
        toolName: 'bad_tool',
        responseMeta: {},
      },
    },
  );
  defineContract(
    // @ts-expect-error response metadata endpoints are HTTP-only
    { prefix: 'compile-agent' },
    {
      bad: {
        method: 'POST',
        path: '/',
        desc: 'Invalid',
        expose: ['AGENT'],
        responseMeta: {},
      },
    },
  );

  const ordinary = defineContract(
    { prefix: 'compile-ordinary' },
    { ping: { method: 'GET', path: '/', desc: 'Ordinary endpoint' } },
  );
  implement(ordinary, {
    ping: (context) => {
      // @ts-expect-error ordinary HandlerContext does not expose response metadata
      context.response.headers.set('x-invalid', 'true');
    },
  });
}
void compileTimeContractChecks;
