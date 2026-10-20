/**
 * A discovered tool's schema is the server's presentation, and the server owns the verdict.
 *
 * A stitchkit server with `flattenUnionInput` advertises a nested discriminated union as one
 * object whose shared field is an unlabelled `anyOf` (ADR 0031, ADR 0205): the presentation
 * keeps every accepted value and drops which shape goes with which discriminator. A client that
 * judged that `anyOf` itself could only list every branch, while the server names the one field
 * that is wrong. So a union in a restored foreign schema never refuses on its own; every other
 * local refusal — a missing field, a wrong scalar — still stops the call before it is sent.
 */
import { afterEach, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract, type RuntimeContext } from '../src/entrypoints/contract';
import {
  defineMcpClientConnection,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { createImplement } from '../src/server/implement';
import { createCli } from '../src/tools/cli/create-cli';
import { createMcpHandler } from '../src/tools/mcp/handler';

const Block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), data: z.object({ text: z.string() }) }),
  z.object({
    type: z.literal('image'),
    data: z.object({ artifactId: z.string(), width: z.number(), height: z.number() }),
  }),
  z.object({
    type: z.literal('quiz'),
    data: z.object({ question: z.string(), options: z.array(z.string()) }),
  }),
]);

const contract = defineContract(
  { prefix: 'lessons', scope: 'public' },
  {
    put: {
      method: 'POST',
      path: '/',
      desc: 'Store a lesson',
      expose: ['MCP'],
      input: z.object({ lessonId: z.string(), blocks: z.array(Block) }),
      output: z.object({ stored: z.number() }),
    },
  },
);

const implement = createImplement<RuntimeContext>();
const received: unknown[] = [];
const service = implement(contract, {
  put: async ({ input }) => {
    received.push(input);
    return { stored: input.blocks.length };
  },
});

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  received.length = 0;
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

async function lessonsCli(
  argv: string[],
): Promise<{ out: string; err: string; code: number }> {
  const handler = createMcpHandler({
    serverInfo: { name: 'lessons', version: '1' },
    auth: () => ({}),
    context: () => ({}),
    services: [service],
    flattenUnionInput: true,
  });
  const server = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request) });
  stops.push(async () => {
    await server.stop(true);
    await handler.close();
  });
  const runtimeTools = await mountConnections([
    defineMcpClientConnection({
      name: 'lessons',
      transport: { url: `http://127.0.0.1:${server.port}/mcp` },
      transports: ['CLI'],
    }),
  ]);
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'lessons',
    version: '1.0.0',
    runtimeTools,
    argv,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
    stdin: async () => null,
  });
  return { out, err, code };
}

const imageWithoutArtifact = JSON.stringify([
  { type: 'image', data: { width: 640, height: 480 } },
]);

test('an error inside a flattened union is the server’s, naming the one wrong field', async () => {
  const { err, code } = await lessonsCli([
    'put_lesson',
    '--lessonId',
    'intro',
    '--blocks',
    imageWithoutArtifact,
  ]);
  expect(code).not.toBe(0);
  expect(err).toContain('blocks.0.data.artifactId: Invalid input: expected string');
  expect(err).not.toContain('No union branch matched');
  expect(err).not.toContain('more branches');
  expect(received).toEqual([]);
});

test('a valid block reaches the server unchanged', async () => {
  const blocks = [{ type: 'image', data: { artifactId: 'a1', width: 640, height: 480 } }];
  const { out, code } = await lessonsCli([
    'put_lesson',
    '--lessonId',
    'intro',
    '--blocks',
    JSON.stringify(blocks),
    '--json',
  ]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ stored: 1 });
  expect(received).toEqual([{ lessonId: 'intro', blocks }]);
});

test('a refusal outside the union still stops the call locally, without union noise', async () => {
  const { err, code } = await lessonsCli(['put_lesson', '--blocks', imageWithoutArtifact]);
  expect(code).not.toBe(0);
  expect(err).toContain('lessonId');
  expect(err).not.toContain('No union branch matched');
  expect(received).toEqual([]);
});
