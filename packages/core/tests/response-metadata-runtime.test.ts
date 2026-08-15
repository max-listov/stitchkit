import { afterAll, describe, expect, test } from 'bun:test';
import { createClient, createHttpClient } from '../src';
import { serveNode } from '../src/server/node';
import {
  createResponseMetadataTestHandler,
  postMetadata,
  responseMetadataContract,
  responseMetadataService,
} from './response-metadata.fixture';

const bunServer = Bun.serve({ port: 0, fetch: createResponseMetadataTestHandler() });
const bunBase = `http://localhost:${bunServer.port}`;
const nodeServer = await serveNode({ services: [responseMetadataService], port: 0 });

afterAll(async () => {
  bunServer.stop(true);
  await nodeServer.shutdown({ gracePeriodMs: 0 });
});

describe('typed JSON response metadata — runtime', () => {
  test('returns validated data, declared status, headers and separate cookies on Bun', async () => {
    const response = await postMetadata(bunBase, 'data', { value: 'bun' });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-operation')).toBe('bun');
    expect(response.headers.getSetCookie()).toEqual([
      'first=bun; Path=/; HttpOnly',
      'second=bun; Path=/; SameSite=Lax',
    ]);
    expect(await response.json()).toEqual({ value: 'bun' });
  });

  test('preserves repeated Set-Cookie and declared status through serveNode', async () => {
    const response = await postMetadata(nodeServer.url, 'data', { value: 'node' });
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual([
      'first=node; Path=/; HttpOnly',
      'second=node; Path=/; SameSite=Lax',
    ]);
    expect(await response.json()).toEqual({ value: 'node' });
  });

  test('keeps default 204 and accepts an explicit bodyless success status', async () => {
    const empty = await postMetadata(bunBase, 'empty');
    const reset = await postMetadata(bunBase, 'reset');
    expect(empty.status).toBe(204);
    expect(empty.headers.get('x-empty')).toBe('yes');
    expect(await empty.text()).toBe('');
    expect(reset.status).toBe(205);
    expect(await reset.text()).toBe('');
  });

  test('applies metadata beside afterHandle and validates transformed data', async () => {
    const response = await postMetadata(bunBase, 'transformed');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-before-transform')).toBe('kept');
    expect(await response.json()).toEqual({ value: 'after' });
  });

  test('discards collected headers after handler, hook and output failures', async () => {
    const failed = await postMetadata(bunBase, 'fail');
    const invalid = await postMetadata(bunBase, 'invalid-output');
    const hookFailed = await postMetadata(bunBase, 'hook-fail');
    expect([failed.status, invalid.status, hookFailed.status]).toEqual([500, 500, 500]);
    expect(failed.headers.getSetCookie()).toEqual([]);
    expect(invalid.headers.getSetCookie()).toEqual([]);
    expect(hookFailed.headers.getSetCookie()).toEqual([]);
  });

  test('fails loudly for every class of framework-owned header', async () => {
    for (const name of [
      'Content-Type',
      'Content-Length',
      'Access-Control-Allow-Origin',
      'x-request-id',
    ]) {
      const response = await postMetadata(bunBase, 'reserved', { name });
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('x-request-id')).toBeTruthy();
      expect(response.headers.get('access-control-allow-origin')).not.toBe('forged');
    }
  });

  test('isolates collectors across parallel requests', async () => {
    const [slow, fast] = await Promise.all([
      postMetadata(bunBase, 'parallel', { value: 'slow', delay: 15 }),
      postMetadata(bunBase, 'parallel', { value: 'fast', delay: 0 }),
    ]);
    expect(slow.headers.get('x-call')).toBe('slow');
    expect(fast.headers.get('x-call')).toBe('fast');
    expect([slow.status, fast.status]).toEqual([200, 200]);
    expect(await slow.json()).toEqual({ value: 'slow' });
    expect(await fast.json()).toEqual({ value: 'fast' });
  });

  test('composes with raw JSON retention without weakening either context', async () => {
    const raw = '{ "value": "signed" }';
    const response = await fetch(`${bunBase}/meta/signed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    expect(response.headers.get('x-raw-length')).toBe(String(raw.length));
    expect(await response.json()).toEqual({ value: 'signed' });
  });

  test('typed clients still resolve parsed data and undefined, not Response', async () => {
    const kyClient = createClient(
      responseMetadataContract,
      createHttpClient({ baseUrl: bunBase }),
    );
    const fetchClient = createClient(responseMetadataContract, { baseUrl: bunBase });
    const kyData: { value: string } = await kyClient.data({ value: 'ky' });
    const fetchData: { value: string } = await fetchClient.data({ value: 'fetch' });
    const kyEmpty: undefined = await kyClient.empty();
    const fetchEmpty: undefined = await fetchClient.empty();
    expect(kyData).toEqual({ value: 'ky' });
    expect(fetchData).toEqual({ value: 'fetch' });
    expect(kyEmpty).toBeUndefined();
    expect(fetchEmpty).toBeUndefined();
  });
});
