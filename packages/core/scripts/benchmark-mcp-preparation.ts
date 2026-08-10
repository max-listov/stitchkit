import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import { createMcpHandler } from '../src/tools/mcp-handler';

const ITERATIONS = 30;

function makeService(index: number) {
  const toolName = `benchmark_${index}`;
  return implement(
    defineContract(
      { prefix: toolName },
      {
        run: {
          method: 'POST',
          path: '/',
          desc: `Benchmark tool ${index}`,
          toolName,
          input: z.object({
            id: z.uuid(),
            label: z.string().min(1),
            enabled: z.boolean(),
            tags: z.array(z.string()),
            options: z.object({
              limit: z.number().int().positive(),
              cursor: z.string().optional(),
            }),
          }),
          output: z.object({ id: z.uuid(), accepted: z.boolean() }),
        },
      },
    ),
    { run: ({ input }) => ({ id: input.id, accepted: input.enabled }) },
  );
}

function request(): Request {
  return new Request('http://local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'benchmark', version: '1' },
      },
    }),
  });
}

function handlerFor(services: ReturnType<typeof makeService>[]) {
  return createMcpHandler({
    serverInfo: { name: 'benchmark', version: '1' },
    auth: () => ({ id: 'benchmark' }),
    services,
  });
}

function uncachedHandlerFor(services: ReturnType<typeof makeService>[]) {
  return createMcpHandler({
    serverInfo: { name: 'benchmark', version: '1' },
    auth: () => ({ id: 'benchmark' }),
    services: () => services,
  });
}

function registryHandlerFor(services: ReturnType<typeof makeService>[]) {
  return createMcpHandler({
    serverInfo: { name: 'benchmark', version: '1' },
    auth: () => ({ id: 'benchmark' }),
    surfaces: { benchmark: { services } },
    selectSurface: () => 'benchmark',
  });
}

async function timeRequests(handler: {
  fetch(request: Request): Promise<Response>;
}): Promise<number> {
  await (await handler.fetch(request())).text();
  const start = performance.now();
  for (let index = 0; index < ITERATIONS; index += 1) {
    await (await handler.fetch(request())).text();
  }
  return performance.now() - start;
}

async function benchmark(toolCount: number): Promise<void> {
  const services = Array.from({ length: toolCount }, (_, index) => makeService(index));

  handlerFor(services);
  const constructionStart = performance.now();
  for (let index = 0; index < ITERATIONS; index += 1) handlerFor(services);
  const constructionMs = performance.now() - constructionStart;

  const statelessInitializeMs = await timeRequests(handlerFor(services));
  const registryStatelessInitializeMs = await timeRequests(registryHandlerFor(services));
  const uncachedStatelessInitializeMs = await timeRequests(uncachedHandlerFor(services));

  console.log(
    JSON.stringify({
      toolCount,
      iterations: ITERATIONS,
      constructionMs,
      statelessInitializeMs,
      registryStatelessInitializeMs,
      uncachedStatelessInitializeMs,
    }),
  );
}

await benchmark(12);
await benchmark(159);
