import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import { buildMcpServer, type McpServerBuildConfig } from '../src/tools';

const StatusOutputSchema = z.object({ ok: z.boolean() });
const contract = defineContract(
  { prefix: 'status' },
  {
    get: {
      method: 'GET',
      path: '/',
      desc: 'Read status',
      output: StatusOutputSchema,
    },
  },
);
const service = implement(contract, { get: () => ({ ok: true }) });

describe('buildMcpServer auth overloads', () => {
  test('builds a no-auth server without a cosmetic undefined argument', async () => {
    const server = buildMcpServer({
      serverInfo: { name: 'status', version: '1.0.0' },
      services: [service],
    });
    expect(server).toBeDefined();
    await server.close();
  });

  test('keeps the explicit auth form unchanged', async () => {
    const server = buildMcpServer(
      {
        serverInfo: { name: 'status', version: '1.0.0' },
        services: [service],
        context: (auth: { tenantId: string }) => ({ tenantId: auth.tenantId }),
      },
      { tenantId: 'tenant-1' },
    );
    expect(server).toBeDefined();
    await server.close();
  });
});

const authenticatedConfig: McpServerBuildConfig<{ tenantId: string }> = {
  serverInfo: { name: 'status', version: '1.0.0' },
  services: [service],
  context: (auth) => ({ tenantId: auth.tenantId }),
};

function compileTimeAuthChecks(): void {
  // @ts-expect-error an auth-dependent config cannot omit its resolved identity
  buildMcpServer(authenticatedConfig);
  buildMcpServer(authenticatedConfig, { tenantId: 'tenant-1' });
}
void compileTimeAuthChecks;
