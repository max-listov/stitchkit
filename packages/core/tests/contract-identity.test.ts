import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ApiError } from '../src/browser/api-error';
import { type ClientFetch, createClient } from '../src/browser/client';
import { readContractIdentity } from '../src/browser/contract-identity';
import { createHttpClient } from '../src/browser/http';
import {
  AppError,
  contractFingerprint,
  defineContract,
  notFound,
} from '../src/entrypoints/contract';
import {
  createHandler,
  createServer,
  implement,
  withContractIdentity,
} from '../src/entrypoints/server';
import { bindContract } from '../src/server/implement';
import { createUnixClientTransport } from '../src/server/unix-client';
import { implementRemote } from '../src/tools/remote';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const Entry = z.object({ name: z.string(), address: z.string() });

/** The contract a server of the previous version was built from. */
const previous = defineContract(
  { prefix: 'records' },
  {
    get: {
      method: 'GET',
      path: '/:name',
      desc: 'One record',
      output: Entry,
    },
  },
);

/** The contract the client was built from: one operation more, one schema wider. */
const current = defineContract(
  { prefix: 'records' },
  {
    get: {
      method: 'GET',
      path: '/:name',
      desc: 'One record',
      output: Entry.extend({ model: z.string().optional() }),
    },
    search: {
      method: 'POST',
      path: '/search',
      desc: 'Search records',
      input: z.object({ query: z.string() }),
      output: z.object({ matches: z.array(Entry) }),
    },
    stats: {
      method: 'GET',
      path: '/stats/all',
      desc: 'Counts',
      output: z.object({ total: z.number() }),
    },
  },
);

async function withUnixServer<T>(
  mountIdentity: boolean,
  body: (config: { baseUrl: string; fetch: ClientFetch }) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'sk-identity-'));
  const socketPath = join(directory, 'server.sock');
  const service = implement(previous, {
    get: ({ params }) => {
      if (params.name === 'locked') {
        throw new AppError('METHOD_NOT_ALLOWED', {
          message: 'The record is read-only',
          status: 405,
          details: { record: 'locked' },
        });
      }
      if (params.name !== 'main') notFound('No such record');
      return { name: 'main', address: 'node-a/main' };
    },
  });
  const server = createServer({
    unix: socketPath,
    logging: false,
    services: mountIdentity ? withContractIdentity([service]) : [service],
  });
  const transport = createUnixClientTransport({ socketPath });
  try {
    return await body({ baseUrl: 'http://localhost', fetch: transport.fetch });
  } finally {
    await transport.close();
    void server.runtime?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

describe('a contract fingerprint', () => {
  test('is one value for one contract and moves with a schema', () => {
    const first = contractFingerprint(previous);
    expect(contractFingerprint([previous])).toEqual(first);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(first.operations)).toEqual(['records.get']);

    const next = contractFingerprint(current);
    expect(next.fingerprint).not.toBe(first.fingerprint);
    // The edited operation moved, and the difference is visible per operation.
    expect(next.operations['records.get']).not.toBe(first.operations['records.get']);
    expect(Object.keys(next.operations).sort()).toEqual([
      'records.get',
      'records.search',
      'records.stats',
    ]);
  });

  test('a description or a handler does not move it; a route or a method does', () => {
    const reworded = defineContract(
      { prefix: 'records' },
      { get: { ...previous.endpoints.get, desc: 'Reworded' } },
    );
    expect(contractFingerprint(reworded)).toEqual(contractFingerprint(previous));
    const moved = defineContract(
      { prefix: 'records' },
      { get: { ...previous.endpoints.get, path: '/by-name/:name' } },
    );
    expect(contractFingerprint(moved).fingerprint).not.toBe(
      contractFingerprint(previous).fingerprint,
    );
  });

  test('another process computes the same value', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sk-fingerprint-'));
    try {
      const file = join(directory, 'print.ts');
      const entry = join(import.meta.dir, '../src/entrypoints/contract.ts');
      await writeFile(
        file,
        `import { z } from 'zod';
import { contractFingerprint, defineContract } from '${entry}';
const Entry = z.object({ name: z.string(), address: z.string() });
const contract = defineContract({ prefix: 'records' }, {
  get: { method: 'GET', path: '/:name', desc: 'Another wording', output: Entry },
});
console.log(JSON.stringify(contractFingerprint(contract)));
`,
      );
      const child = Bun.spawn(['bun', file], { stdout: 'pipe', stderr: 'pipe' });
      trackProcess(child.pid);
      const printed = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(JSON.parse(printed)).toEqual(contractFingerprint(previous));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('the fingerprint covers what constrains a value, on both sides alike', () => {
  test('a field description or the order of fields does not move it', () => {
    const base = z.object({ name: z.string(), address: z.string() });
    const reworded = z.object({
      address: z.string().describe('Where it lives'),
      name: z.string().meta({ title: 'Name', examples: ['main'] }),
    });
    const make = (output: z.ZodType) =>
      defineContract(
        { prefix: 'records' },
        { get: { method: 'GET', path: '/:name', desc: 'One record', output } },
      );
    expect(contractFingerprint(make(reworded))).toEqual(contractFingerprint(make(base)));
    // The control: a constraint does move it.
    expect(
      contractFingerprint(make(base.extend({ name: z.string().min(1) }))).fingerprint,
    ).not.toBe(contractFingerprint(make(base)).fingerprint);
    // A property that is itself called `description` is data, not an annotation.
    expect(
      contractFingerprint(make(base.extend({ description: z.string() }))).fingerprint,
    ).not.toBe(contractFingerprint(make(base)).fingerprint);
  });

  test('a server and a client agree on every endpoint shape', async () => {
    const shapes = defineContract(
      { prefix: 'shapes' },
      {
        plain: { method: 'GET', path: '/', desc: 'No arguments', output: Entry },
        routed: { method: 'GET', path: '/:id', desc: 'Route param, no schema', output: Entry },
        typed: {
          method: 'GET',
          path: '/typed/:id',
          desc: 'Route param with a schema',
          params: z.object({ id: z.string().min(2) }),
          output: Entry,
        },
        wild: { method: 'GET', path: '/files/*filePath', desc: 'Wildcard', output: Entry },
        create: {
          method: 'POST',
          path: '/',
          desc: 'Input and output',
          input: z.object({ name: z.string(), count: z.number().default(1) }),
          output: Entry,
        },
        empty: { method: 'DELETE', path: '/:id', desc: 'No output' },
        feed: {
          method: 'POST',
          path: '/feed',
          desc: 'Stream',
          input: z.object({ since: z.string().optional() }),
          stream: { item: Entry },
        },
        httpOnly: {
          method: 'GET',
          path: '/h',
          desc: 'HTTP only',
          expose: ['HTTP'],
          output: Entry,
        },
        cliOnly: {
          method: 'GET',
          path: '/c',
          desc: 'No HTTP',
          expose: ['CLI'],
          output: Entry,
        },
        upload: {
          method: 'POST',
          path: '/upload',
          desc: 'Multipart',
          multipart: { files: { file: {} } },
          output: Entry,
        },
      },
    );
    const client = contractFingerprint(shapes);
    expect(Object.keys(client.operations).sort()).toEqual([
      'shapes.create',
      'shapes.empty',
      'shapes.feed',
      'shapes.httpOnly',
      'shapes.plain',
      'shapes.routed',
      'shapes.typed',
      'shapes.upload',
      'shapes.wild',
    ]);
    // The server derives its side from the mounted services; a proxy over the
    // same contract is a server too.
    const http = createHttpClient({
      baseUrl: 'http://origin',
      fetch: async () => new Response(),
    });
    for (const service of [
      bindContract(shapes, {}, { onMissingHandler: 'stub' }),
      implementRemote(shapes, http),
    ]) {
      const handler = createHandler({
        logging: false,
        services: withContractIdentity([service]),
      });
      const server = await readContractIdentity(shapes, {
        baseUrl: 'http://server',
        fetch: (input, init) => handler(new Request(input, init)),
      });
      expect(server.server).toEqual(client);
    }
  });
});

describe('a client of a newer contract against an older server, over a Unix socket', () => {
  test('an operation the server lacks is UNKNOWN_OPERATION with its name', async () => {
    await withUnixServer(false, async (config) => {
      const client = createClient(current, config);
      const refusal = await client.stats().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ApiError);
      if (!(refusal instanceof ApiError)) return;
      expect(refusal.code).toBe('UNKNOWN_OPERATION');
      expect(refusal.status).toBe(404);
      expect(refusal.details).toEqual({
        method: 'GET',
        path: '/records/stats/all',
        operation: 'records.stats',
      });
      // The path exists on the old server under another method only: to a
      // contract client that is the same fact, under the same code.
      const other = await client.search({ query: 'x' }).catch((error: unknown) => error);
      expect(other).toBeInstanceOf(ApiError);
      if (!(other instanceof ApiError)) return;
      expect(other.code).toBe('UNKNOWN_OPERATION');
      expect(other.status).toBe(405);
      expect(other.details).toEqual({
        method: 'POST',
        path: '/records/search',
        allow: ['GET'],
        operation: 'records.search',
      });
    });
  });

  test('an object the operation did not find stays NOT_FOUND', async () => {
    await withUnixServer(false, async (config) => {
      const client = createClient(current, config);
      expect(await client.get({ name: 'main' })).toMatchObject({ address: 'node-a/main' });
      const refusal = await client.get({ name: 'ghost' }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ApiError);
      if (!(refusal instanceof ApiError)) return;
      expect(refusal.code).toBe('NOT_FOUND');
      expect(refusal.details).not.toHaveProperty('operation');
    });
  });

  test('a 405 a handler throws itself stays METHOD_NOT_ALLOWED', async () => {
    await withUnixServer(false, async (config) => {
      const client = createClient(current, config);
      const refusal = await client.get({ name: 'locked' }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ApiError);
      if (!(refusal instanceof ApiError)) return;
      expect(refusal.code).toBe('METHOD_NOT_ALLOWED');
      expect(refusal.details).toEqual({ record: 'locked' });
    });
  });

  test('one call returns both fingerprints as a value', async () => {
    await withUnixServer(true, async (config) => {
      const identity = await readContractIdentity(current, config);
      expect(identity.client).toEqual(contractFingerprint(current));
      expect(identity.server).toEqual(contractFingerprint(previous));
      // What the application reads off the pair: which operations it may call.
      expect(identity.server?.operations['records.search']).toBeUndefined();
      expect(identity.server?.operations['records.get']).not.toBe(
        identity.client.operations['records.get'],
      );
      // The same contracts on both sides agree.
      const same = await readContractIdentity(previous, config);
      expect(same.server).toEqual(same.client);
    });
  });

  test('a server that does not answer its identity is a value too', async () => {
    await withUnixServer(false, async (config) => {
      const identity = await readContractIdentity(current, config);
      expect(identity.server).toBeUndefined();
      expect(identity.client).toEqual(contractFingerprint(current));
    });
  });
});
