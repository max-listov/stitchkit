/**
 * Declared refusals (`refuses`, ADR 0330) across every surface an operation reaches: the tool
 * transports and the CLI refuse an undeclared code as the HTTP route does, observers keep the
 * original on `cause`, the typed client reads framework and client codes too, and the descriptors
 * (OpenAPI, surface manifest, contract fingerprint) carry the declaration only where it exists.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ApiError, refuseLocally } from '../src/browser/api-error';
import {
  contractFingerprint,
  defineContract,
  defineErrors,
} from '../src/entrypoints/contract';
import { buildSurfaceManifest, createHandlerTestClient } from '../src/entrypoints/testing';
import { isRecord } from '../src/internal/typed';
import { withContractIdentity } from '../src/server/contract-identity';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';
import { generateOpenApiDocument } from '../src/server/openapi';
import type { ServiceDef } from '../src/server/types';
import {
  ALL_RESULT_TRANSPORTS,
  openTransportHarness,
  type TransportInvocationResult,
} from './support/operation-transports';

const { errors } = defineErrors({
  NOT_IDLE: { status: 409, message: 'Session is busy' },
  MIN_AWAKE: { status: 422, details: z.object({ minimum: z.number().int() }) },
  PROFILE_UNAVAILABLE: { status: 503 },
});

const Mode = z.object({ mode: z.enum(['idle', 'undeclared']) });

function sessions(refuses: boolean) {
  return defineContract(
    { prefix: 'session' },
    {
      sleep: {
        method: 'POST',
        path: '/sleep',
        desc: 'Put a session to sleep',
        input: Mode,
        output: z.object({ ok: z.boolean() }),
        expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
        ...(refuses && { refuses: [errors.NOT_IDLE, errors.MIN_AWAKE] }),
      },
    },
  );
}

const sleep = ({ input }: { input: z.infer<typeof Mode> }) => {
  if (input.mode === 'idle') throw errors.NOT_IDLE();
  throw errors.PROFILE_UNAVAILABLE();
};

const declared = sessions(true);
const service = implement(declared, { sleep });
const undeclaredService = implement(sessions(false), { sleep });

/** What a transport answered, as text: the agent surface throws its refusal, the others return it. */
async function wire(answer: Promise<TransportInvocationResult>): Promise<string> {
  try {
    return JSON.stringify(await answer);
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

describe('every tool transport holds the handler to the declaration', () => {
  const harness = openTransportHarness({ services: [service] });
  const open = openTransportHarness({ services: [undeclaredService] });
  afterAll(async () => {
    await (await harness).close();
    await (await open).close();
  });

  for (const transport of ALL_RESULT_TRANSPORTS) {
    test(`${transport}: an undeclared code arrives as INTERNAL_SERVER_ERROR, a declared one as itself`, async () => {
      const surface = await harness;
      const call = (mode: string) => ({
        name: 'sleep_session',
        args: { mode },
        cliArgv: ['sleep_session', '--mode', mode],
      });
      const undeclared = await wire(surface.invoke(transport, call('undeclared')));
      expect(undeclared).toContain('INTERNAL_SERVER_ERROR');
      expect(undeclared).not.toContain('PROFILE_UNAVAILABLE');
      expect(await wire(surface.invoke(transport, call('idle')))).toContain('NOT_IDLE');
      // Negative control: the same handler without `refuses` passes its code unchanged.
      const passed = await wire((await open).invoke(transport, call('undeclared')));
      expect(passed).toContain('PROFILE_UNAVAILABLE');
    });
  }
});

describe('observers and the typed client', () => {
  test('onError sees the 500 naming the operation, with the original code on cause', async () => {
    const seen: unknown[] = [];
    const handler = createHandler({
      groups: [{ pathPrefix: 'api', services: [service] }],
      hooks: {
        onError: (_ctx, error) => {
          seen.push(error);
          return undefined;
        },
      },
    });
    const api = createHandlerTestClient({ contract: declared, handler, pathPrefix: 'api' });
    const failure = await api.sleep({ mode: 'undeclared' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', status: 500 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('session.sleep'),
      cause: expect.objectContaining({ code: 'PROFILE_UNAVAILABLE' }),
    });
  });

  test('refusal() reads framework and client codes on every operation, and a scoped client carries it', async () => {
    const handler = createHandler({ groups: [{ pathPrefix: 'api', services: [service] }] });
    const api = createHandlerTestClient({ contract: declared, handler, pathPrefix: 'api' });
    const aborted = new ApiError('REQUEST_ABORTED', { status: 0 });
    expect(api.sleep.refusal(aborted)?.code).toBe('REQUEST_ABORTED');
    expect(api.sleep.refusal(refuseLocally('mode', 'required'))?.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(api.sleep.refusal(new ApiError('STREAM_TRUNCATED'))?.code).toBe('STREAM_TRUNCATED');
    expect(
      api.sleep.refusal(new ApiError('SOMEONE_ELSES_CODE', { status: 409 })),
    ).toBeUndefined();
    const valid = await api.sleep({ mode: 'idle' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(api.sleep.refusal(valid)).toMatchObject({ code: 'NOT_IDLE', status: 409 });
  });
});

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected an object');
  return value;
}

function postOperation(services: ServiceDef[]): Record<string, unknown> {
  const document = generateOpenApiDocument({ services, info: { title: 'T', version: '1' } });
  return record(document.paths['/session/sleep']?.post);
}

describe('descriptors carry the declaration only where it exists', () => {
  test('OpenAPI lists x-stitchkit-refusals and documents each declared status', () => {
    const operation = postOperation([service]);
    expect(operation['x-stitchkit-refusals']).toEqual([
      { code: 'NOT_IDLE', status: 409, retryable: false, message: 'Session is busy' },
      expect.objectContaining({ code: 'MIN_AWAKE', status: 422, details: expect.any(Object) }),
    ]);
    expect(Object.keys(record(operation.responses))).toEqual(
      expect.arrayContaining(['409', '422']),
    );
    const bare = postOperation([undeclaredService]);
    expect(bare['x-stitchkit-refusals']).toBeUndefined();
    expect(Object.keys(record(bare.responses))).not.toContain('409');
  });

  test('the surface manifest records refusals only on an operation that declares them', () => {
    const declaredManifest = buildSurfaceManifest({ services: [service] });
    const [withRefusals] = declaredManifest.operations;
    expect(withRefusals?.refusals).toEqual([
      { code: 'MIN_AWAKE', status: 422, details: expect.any(String) },
      { code: 'NOT_IDLE', status: 409, details: null },
    ]);
    const [without] = buildSurfaceManifest({ services: [undeclaredService] }).operations;
    expect(without).not.toHaveProperty('refusals');
  });

  test('the fingerprint is unchanged without refuses and moves when the refusals change', () => {
    const plain = contractFingerprint(sessions(false));
    // Pinned from 0.132.3, before `refuses` existed: a contract that declares nothing digests as then.
    expect(plain).toEqual({
      fingerprint: 'ee144787ef5e8d0bf27d5c6ad958246f',
      operations: { 'session.sleep': '396ecddbdcb14463199ec1f6f43d60bc' },
    });
    const withRefusals = contractFingerprint(declared);
    expect(withRefusals.fingerprint).not.toBe(plain.fingerprint);
    // Server and client agree: the identity a server answers is the client's digest.
    const identity = withContractIdentity([service]).at(-1)?.methods.read;
    if (!identity) throw new Error('missing identity operation');
    expect(identity.handler({ params: undefined, input: undefined, source: 'http' })).toEqual(
      withRefusals,
    );
    const fewer = contractFingerprint(
      defineContract(
        { prefix: 'session' },
        {
          sleep: {
            method: 'POST',
            path: '/sleep',
            desc: 'Put a session to sleep',
            input: Mode,
            output: z.object({ ok: z.boolean() }),
            refuses: [errors.NOT_IDLE],
          },
        },
      ),
    );
    expect(fewer.fingerprint).not.toBe(withRefusals.fingerprint);
    const reordered = contractFingerprint(
      defineContract(
        { prefix: 'session' },
        {
          sleep: {
            method: 'POST',
            path: '/sleep',
            desc: 'Put a session to sleep',
            input: Mode,
            output: z.object({ ok: z.boolean() }),
            refuses: [errors.MIN_AWAKE, errors.NOT_IDLE],
          },
        },
      ),
    );
    expect(reordered.fingerprint).toBe(withRefusals.fingerprint);
  });
});
