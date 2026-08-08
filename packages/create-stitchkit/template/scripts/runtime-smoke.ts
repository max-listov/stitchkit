import { RepositorySnapshotSchema } from '@app/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { io } from 'socket.io-client';
import { z } from 'zod';
import { toolingEnv } from './tooling-env';

const apiOrigin = toolingEnv.NEXT_PUBLIC_API_URL;

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiOrigin}${path}`, init);
  if (!response.ok)
    throw new Error(`${init?.method ?? 'GET'} ${path} returned ${response.status}`);
  return response.json();
}

const socket = io(apiOrigin, { transports: ['websocket'] });
const refreshedEvent = new Promise<string>((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error('Socket.IO repository refresh event timed out')),
    5_000,
  );
  socket.once('repository:refreshed', (snapshot) => {
    clearTimeout(timeout);
    resolve(snapshot.fullName);
  });
});

try {
  z.object({ status: z.literal('ok') }).parse(await json('/health'));
  const corsResponse = await fetch(`${apiOrigin}/api/repository/`, {
    headers: { Origin: 'http://localhost:58302' },
  });
  if (corsResponse.headers.get('access-control-allow-origin') !== '*') {
    throw new Error('Public API does not allow a forwarded browser origin');
  }
  const openApi = z
    .object({ paths: z.record(z.string(), z.unknown()) })
    .parse(await json('/openapi.json'));
  if (!Object.keys(openApi.paths).some((path) => path.startsWith('/api/repository'))) {
    throw new Error('OpenAPI repository path is missing');
  }

  const refreshed = RepositorySnapshotSchema.parse(
    await json('/api/repository/refresh', { method: 'POST' }),
  );
  if ((await refreshedEvent) !== refreshed.fullName) {
    throw new Error('Socket.IO repository identity differs');
  }
  const cached = RepositorySnapshotSchema.parse(await json('/api/repository/'));
  if (cached.fullName !== refreshed.fullName) throw new Error('Repository cache read differs');

  const client = new Client({ name: 'starter-lane', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${apiOrigin}/mcp`));
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === 'repository_read')) {
    throw new Error('MCP repository tool is absent');
  }
  const result = await client.callTool({ name: 'repository_read', arguments: {} });
  if (result.isError) throw new Error('MCP repository read failed');
  await client.close();
} finally {
  socket.close();
}

console.log('Runtime HTTP, OpenAPI, Socket.IO and MCP smoke passed');
