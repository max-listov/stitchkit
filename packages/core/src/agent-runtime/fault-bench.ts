import { createServer, type ServerResponse } from 'node:http';
import { z } from 'zod';

export const AgentFaultStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pass'), text: z.string().default('ok') }).strict(),
  z.object({ kind: z.literal('connection-refused') }).strict(),
  z
    .object({ kind: z.literal('timeout-before-first-byte'), milliseconds: z.int().positive() })
    .strict(),
  z.object({ kind: z.literal('stream-cut'), afterBytes: z.int().nonnegative() }).strict(),
  z.object({ kind: z.literal('http-error'), status: z.int().min(400).max(599) }).strict(),
  z.object({ kind: z.literal('bad-json') }).strict(),
  z
    .object({
      kind: z.literal('slow'),
      text: z.string(),
      tokensPerSecond: z.number().positive(),
    })
    .strict(),
  z.object({ kind: z.literal('usage-missing'), text: z.string().default('ok') }).strict(),
]);
export type AgentFaultStep = z.input<typeof AgentFaultStepSchema>;
type ParsedAgentFaultStep = z.output<typeof AgentFaultStepSchema>;

export function defineAgentFaultPlan(
  steps: readonly AgentFaultStep[],
): readonly ParsedAgentFaultStep[] {
  if (steps.length === 0) throw new TypeError('Fault plan must contain at least one step');
  return steps.map((step) => AgentFaultStepSchema.parse(step));
}

function completionChunk(text: string, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'fault-bench',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finishReason }],
  })}\n\n`;
}

function completeSse(response: ServerResponse, text: string, includeUsage: boolean): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  response.write(completionChunk(text, null));
  response.write(completionChunk('', 'stop'));
  if (includeUsage) {
    response.write(
      `data: ${JSON.stringify({
        id: 'fault-bench',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`,
    );
  }
  response.end('data: [DONE]\n\n');
}

/** Credential-free OpenAI-compatible SSE endpoint with a deterministic fault sequence. */
export async function createFaultProviderServer(input: {
  scenario: readonly AgentFaultStep[];
}): Promise<{ url: string; calls(): number; close(): Promise<void> }> {
  const scenario = defineAgentFaultPlan(input.scenario);
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    const step = scenario[Math.min(calls, scenario.length - 1)];
    calls += 1;
    if (!step) throw new Error('Fault scenario disappeared');
    if (step.kind === 'connection-refused') {
      request.socket.destroy();
      return;
    }
    if (step.kind === 'timeout-before-first-byte') {
      setTimeout(() => completeSse(response, 'late', true), step.milliseconds).unref();
      return;
    }
    if (step.kind === 'http-error') {
      response.writeHead(step.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `fault ${step.status}` } }));
      return;
    }
    if (step.kind === 'bad-json') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {not-json}\n\ndata: [DONE]\n\n');
      return;
    }
    if (step.kind === 'stream-cut') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from(completionChunk('partial response', null));
      response.write(bytes.subarray(0, Math.min(step.afterBytes, bytes.byteLength)));
      response.socket?.destroy();
      return;
    }
    if (step.kind === 'slow') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const tokens = step.text.split(/(?<=\s)/u).filter(Boolean);
      const intervalMs = Math.max(1, Math.round(1_000 / step.tokensPerSecond));
      let index = 0;
      const timer = setInterval(() => {
        const token = tokens[index];
        index += 1;
        if (token !== undefined) response.write(completionChunk(token, null));
        if (index >= tokens.length) {
          clearInterval(timer);
          response.end(`${completionChunk('', 'stop')}data: [DONE]\n\n`);
        }
      }, intervalMs);
      timer.unref();
      return;
    }
    completeSse(response, step.text, step.kind !== 'usage-missing');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fault server has no TCP address');
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    calls: () => calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** Deterministic provider selector for fixtures; no environment credentials are read. */
export function createReplayAgentProvider<MODEL>(input: {
  attempts: Readonly<Record<string, readonly MODEL[]>>;
}): { create(modelId: string): MODEL; calls(modelId: string): number } {
  const calls = new Map<string, number>();
  return {
    create(modelId) {
      const index = calls.get(modelId) ?? 0;
      const attempts = input.attempts[modelId];
      const model = attempts?.[index];
      if (!model) throw new TypeError(`Replay exhausted for model: ${modelId}`);
      calls.set(modelId, index + 1);
      return model;
    },
    calls: (modelId) => calls.get(modelId) ?? 0,
  };
}
