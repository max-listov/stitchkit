/**
 * Shared test factory for result transports (`agent`, `mcp-content`, `mcp-structured`, `cli`).
 *
 * Rules about how a tool result reaches a host (media blocks, file names, refused-view output)
 * parameterize across these transports. `mcp-content` and `mcp-structured` read the raw JSON-RPC
 * `result` off the client transport wire BEFORE the MCP SDK client schema parses or strips fields.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { isRecord } from '../../src/internal/typed';
import type { ServiceDef } from '../../src/server/types';
import { mountAgent } from '../../src/tools/agent';
import { type CliConfig, createCli } from '../../src/tools/cli/create-cli';
import { buildMcpServer } from '../../src/tools/mcp/mount';
import type { RuntimeToolDefinition } from '../../src/tools/runtime-tool';

export type ResultTransport = 'agent' | 'mcp-content' | 'mcp-structured' | 'cli';

export const ALL_RESULT_TRANSPORTS: readonly ResultTransport[] = [
  'agent',
  'mcp-content',
  'mcp-structured',
  'cli',
];

export interface OperationSurface {
  readonly services?: readonly ServiceDef[];
  readonly runtimeTools?: readonly RuntimeToolDefinition[];
}

export interface CliRunResult {
  readonly out: string;
  readonly err: string;
  readonly code: number;
}

/**
 * Connect an MCP client to `server` while recording every raw JSON-RPC message received on the
 * client transport before the SDK client parses it: what a host reads off the wire, not what the
 * SDK schema leaves of it.
 */
export async function connectRecording(
  server: McpServer,
): Promise<{ client: Client; received: unknown[] }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'operation-transport-wire', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const received: unknown[] = [];
  const deliver = clientTransport.onmessage;
  clientTransport.onmessage = (message, extra) => {
    received.push(structuredClone(message));
    deliver?.(message, extra);
  };
  return { client, received };
}

/** The `result` object of the latest tool call captured by `connectRecording`. */
export function wireResult(received: readonly unknown[]): Record<string, unknown> {
  const results = received.flatMap((message) =>
    isRecord(message) && isRecord(message.result) && Array.isArray(message.result.content)
      ? [message.result]
      : [],
  );
  if (results.length === 0) throw new Error('expected at least one tool result on the wire');
  const last = results.at(-1);
  if (!last) throw new Error('expected a tool result');
  return last;
}

/** Execute `createCli` against `surface` and capture `{ out, err, code }` without exiting. */
export async function runCliSurface(
  surface: OperationSurface,
  argv: string[],
  extraConfig: Partial<CliConfig> = {},
): Promise<CliRunResult> {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'ops',
    version: '1.0.0',
    ...(surface.services && surface.services.length > 0
      ? { services: [...surface.services] }
      : {}),
    ...(surface.runtimeTools && surface.runtimeTools.length > 0
      ? { runtimeTools: [...surface.runtimeTools] }
      : {}),
    ...extraConfig,
    access: extraConfig.access ?? { open: 'local-operator' },
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

export type TransportInvocationResult =
  | { readonly transport: 'agent'; readonly output: unknown; readonly modelOutput: unknown }
  | {
      readonly transport: 'mcp-content';
      readonly content: unknown;
      readonly isError: boolean;
      readonly rawResult: Record<string, unknown>;
    }
  | {
      readonly transport: 'mcp-structured';
      readonly structuredContent: unknown;
      readonly isError: boolean;
      readonly rawResult: Record<string, unknown>;
    }
  | {
      readonly transport: 'cli';
      readonly out: string;
      readonly err: string;
      readonly code: number;
    };

export interface TransportHarness {
  invoke(
    transport: ResultTransport,
    call: {
      readonly name: string;
      readonly args?: Record<string, unknown>;
      readonly cliArgv?: string[];
    },
  ): Promise<TransportInvocationResult>;
  close(): Promise<void>;
}

function objectArgsToCliFlags(args: Record<string, unknown>): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    flags.push(
      `--${key}`,
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value),
    );
  }
  return flags;
}

/**
 * Open a single reusable transport harness (one `McpServer` + recording client and one `mountAgent`
 * surface for the whole file). Call `close()` in `afterAll`.
 */
export async function openTransportHarness(
  surface: OperationSurface,
): Promise<TransportHarness> {
  const services = surface.services ? [...surface.services] : [];
  const runtimeTools = surface.runtimeTools ? [...surface.runtimeTools] : [];
  const agentTools = mountAgent(services, {
    access: { open: 'local-operator' },
    runtimeTools,
  });
  const mcpServer = buildMcpServer(
    {
      access: { open: 'local-operator' },
      serverInfo: { name: 'transport-harness', version: '1' },
      services,
      runtimeTools,
    },
    undefined,
  );
  const { client, received } = await connectRecording(mcpServer);

  return {
    async invoke(transport, call) {
      const args = call.args ?? {};
      if (transport === 'agent') {
        const tool = agentTools[call.name];
        if (!tool?.execute) throw new Error(`Agent tool "${call.name}" is not mounted`);
        const output: unknown = await tool.execute(args, {
          toolCallId: `call-${call.name}`,
          messages: [],
          context: undefined,
        });
        const modelOutput: unknown = tool.toModelOutput
          ? await tool.toModelOutput({
              toolCallId: `call-${call.name}`,
              input: args,
              output,
            })
          : undefined;
        return { transport: 'agent', output, modelOutput };
      }
      if (transport === 'mcp-content' || transport === 'mcp-structured') {
        received.length = 0;
        await client.callTool({ name: call.name, arguments: args });
        const rawResult = wireResult(received);
        const isError = rawResult.isError === true;
        if (transport === 'mcp-content') {
          return { transport: 'mcp-content', content: rawResult.content, isError, rawResult };
        }
        return {
          transport: 'mcp-structured',
          structuredContent: rawResult.structuredContent,
          isError,
          rawResult,
        };
      }
      const argv = call.cliArgv ?? [call.name, ...objectArgsToCliFlags(args), '--json'];
      const cli = await runCliSurface(surface, argv);
      return { transport: 'cli', ...cli };
    },
    async close() {
      try {
        await client.close();
      } finally {
        await mcpServer.close();
      }
    },
  };
}
