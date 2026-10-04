import { afterEach } from 'bun:test';
import { z } from 'zod';

const rpcSchema = z.object({
  id: z.number().optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
type RpcMessage = z.output<typeof rpcSchema>;
export interface McpReply {
  result?: unknown;
  status?: number;
  raw?: string;
  delayMs?: number;
  hold?: boolean;
  frames?: string;
}
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A real socket speaks both transports; each legacy endpoint owns its stream. */
export function mcpFixture(
  options: {
    mode?: 'json' | 'finite-sse' | 'legacy';
    tools?: unknown[];
    reply?: (message: RpcMessage) => McpReply;
    endpointDelayMs?: number;
    negotiateDelayMs?: number;
    endpointFrames?: string;
  } = {},
) {
  const mode = options.mode ?? 'json';
  const seen: string[] = [];
  const senders = new Map<string, (text: string) => void>();
  let serial = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        seen.push('GET');
        if (mode !== 'legacy') return new Response('no legacy', { status: 404 });
        const endpoint = `/messages/${++serial}`;
        let closed = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (text: string) => {
              if (closed) return;
              try {
                controller.enqueue(new TextEncoder().encode(text));
              } catch {
                closed = true;
              }
            };
            senders.set(endpoint, send);
            if (options.endpointFrames !== undefined) send(options.endpointFrames);
            else send(`event: endpoint\ndata: ${endpoint}\n\n`);
          },
          cancel() {
            closed = true;
            senders.delete(endpoint);
          },
        });
        if (options.endpointDelayMs) await Bun.sleep(options.endpointDelayMs);
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      const message = rpcSchema.parse(await request.json());
      seen.push(message.method);
      if (mode === 'legacy' && url.pathname === '/mcp') {
        if (options.negotiateDelayMs) await Bun.sleep(options.negotiateDelayMs);
        return new Response('legacy', { status: 404 });
      }
      const reply = options.reply?.(message) ?? {};
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      if (reply.hold) return new Promise<Response>(() => undefined);
      if (reply.status && reply.status >= 400) {
        return new Response(reply.raw ?? 'upstream refusal', { status: reply.status });
      }
      const result =
        reply.result ??
        (message.method === 'tools/list'
          ? { tools: options.tools ?? [{ name: 'echo', inputSchema: { type: 'object' } }] }
          : message.method === 'initialize'
            ? { protocolVersion: '2024-11-05' }
            : { content: [], structuredContent: { ok: true } });
      const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      if (mode === 'legacy') {
        if (message.id !== undefined)
          senders.get(url.pathname)?.(reply.frames ?? `event: message\ndata: ${payload}\n\n`);
        return new Response(reply.raw ?? null, {
          status: message.id === undefined && reply.raw ? 200 : 202,
        });
      }
      if (message.id === undefined)
        return new Response(reply.raw ?? null, { status: reply.raw ? 200 : 202 });
      return new Response(
        reply.raw ??
          (mode === 'finite-sse' ? `event: message\ndata: ${payload}\n\n` : payload),
        {
          headers: {
            'content-type': mode === 'finite-sse' ? 'text/event-stream' : 'application/json',
          },
        },
      );
    },
  });
  servers.push(server);
  return {
    url: new URL('/mcp', server.url),
    seen,
    get openStreams() {
      return senders.size;
    },
  };
}
