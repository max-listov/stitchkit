/*
 * A question that depends on the answer's own arguments.
 *
 * The declared list is fixed before any call exists, which is enough when the
 * questions belong to the OPERATION. It is not enough when they belong to the
 * ARGUMENTS — one model takes `aspect_ratio`, another `duration`, a third an
 * input image — and there the declared list can only be empty. The consuming
 * tool then carries an instruction in its description telling the model to
 * fetch the schema and not guess, which is a workaround for a mechanism the
 * protocol already has, and the transcript keeps a validation error where a
 * question belonged.
 *
 * Everything that makes the mechanism usable is unchanged: the state is signed,
 * bound to the principal, the operation and the argument digest, and counted
 * against `maxRounds`. One thing is added, because computing the questions
 * makes it necessary — see the plan-digest test below.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  defineContract,
  type McpInputRequiredResolver,
  type RuntimeContext,
} from '../src/contract';
import { createImplement } from '../src/server/implement';
import { createMcpHandler } from '../src/tools/mcp-handler';

const MODERN = '2026-07-28';
const KEY = '0123456789abcdef0123456789abcdef';

const ratioSchema = z.object({ aspectRatio: z.string() });
const durationSchema = z.object({ seconds: z.number() });

function call(
  args: Record<string, unknown>,
  options: { inputResponses?: Record<string, unknown>; requestState?: string } = {},
): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: 'alpha',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': 'create_render',
      'mcp-protocol-version': MODERN,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_render',
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'dyn', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
        },
        ...(options.inputResponses !== undefined && {
          inputResponses: options.inputResponses,
        }),
        ...(options.requestState !== undefined && { requestState: options.requestState }),
      },
    }),
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return z.object({ result: z.record(z.string(), z.unknown()) }).parse(await response.json())
    .result;
}

/** The one question the host is being asked, by key. */
function asked(result: Record<string, unknown>): { key: string; message: string } {
  expect(result.resultType).toBe('input_required');
  const requests = z
    .record(
      z.string(),
      z.object({ params: z.object({ message: z.string() }).loose() }).loose(),
    )
    .parse(result.inputRequests);
  const entries = Object.entries(requests);
  expect(entries).toHaveLength(1);
  const [key, request] = entries[0] ?? ['', { params: { message: '' } }];
  return { key, message: request.params.message };
}

function handlerFor(resolve: McpInputRequiredResolver, maxRounds?: number) {
  const contract = defineContract(
    { prefix: 'render' },
    {
      create: {
        method: 'POST',
        path: '/',
        desc: 'Render with a model',
        expose: ['MCP'],
        input: z.object({ model: z.string(), quality: z.string().default('high') }),
        output: z.object({ model: z.string(), answered: z.array(z.string()) }),
        mcp: { inputRequired: resolve },
      },
    },
  );
  const service = createImplement<RuntimeContext>()(contract, {
    create: (context) => ({
      model: context.input.model,
      answered: Object.keys(context.mcpInput ?? {}),
    }),
  });
  return createMcpHandler({
    serverInfo: { name: 'dyn', version: '1' },
    auth: () => ({ identity: 'alpha' }),
    services: [service],
    multiRound: {
      state: { key: KEY, principal: () => 'alpha' },
      ...(maxRounds !== undefined && { serving: { maxRounds } }),
    },
  });
}

/** The questions this model needs — the shape a consumer actually writes. */
const perModel = ({ input }: { input: unknown }) => {
  const model = (input as { model: string }).model;
  if (model === 'image')
    return [{ key: 'ratio', message: 'Which aspect ratio?', schema: ratioSchema }];
  if (model === 'video')
    return [{ key: 'duration', message: 'How many seconds?', schema: durationSchema }];
  return [];
};

describe('elicitation rounds can be chosen from the arguments', () => {
  test('a different model is asked a different question', async () => {
    const handler = handlerFor(perModel);
    expect(asked(await body(await handler.fetch(call({ model: 'image' }))))).toEqual({
      key: 'ratio',
      message: 'Which aspect ratio?',
    });
    expect(asked(await body(await handler.fetch(call({ model: 'video' }))))).toEqual({
      key: 'duration',
      message: 'How many seconds?',
    });
  });

  test('an empty plan runs the call instead of asking anything', async () => {
    const handler = handlerFor(perModel);
    const result = await body(await handler.fetch(call({ model: 'text' })));
    expect(result.resultType).toBe('complete');
    expect(result.structuredContent).toEqual({ model: 'text', answered: [] });
  });

  test('the answer reaches the handler under its declared key', async () => {
    const handler = handlerFor(perModel);
    const first = await body(await handler.fetch(call({ model: 'image' })));
    const requestState = z.string().parse(first.requestState);
    const second = await body(
      await handler.fetch(
        call(
          { model: 'image' },
          {
            requestState,
            inputResponses: { ratio: { action: 'accept', content: { aspectRatio: '16:9' } } },
          },
        ),
      ),
    );
    expect(second.structuredContent).toEqual({ model: 'image', answered: ['ratio'] });
  });

  test('the resolver sees the parsed input, not the raw arguments', async () => {
    // It is given what the handler would be given, so a `.default()` or a
    // coercion is already applied — otherwise the resolver would be choosing
    // questions from a value nobody will run with.
    let seen: unknown;
    const handler = handlerFor((call) => {
      seen = call.input;
      return [];
    });
    await handler.fetch(call({ model: 'text' }));
    // `quality` was never sent. It is in the parsed value because the schema
    // declares a default, and choosing questions from the raw arguments would
    // mean choosing them from a value nobody will run with. The earlier version
    // of this test sent a payload where raw and parsed were identical, so it
    // passed either way — a mutation feeding the raw arguments stayed green.
    expect(seen).toEqual({ model: 'text', quality: 'high' });
  });

  test('a resolver that changes its mind between rounds is refused, not obeyed', async () => {
    // The dangerous case, and the reason the plan is fingerprinted into the
    // signed state. Arguments have not changed, the principal has not changed,
    // the round is in range — every check that existed still passes. Without
    // the plan digest the host would be asked round 1's question again under a
    // different key, and the user's answer would be accepted for a question
    // nobody asked.
    let answers = 0;
    const handler = handlerFor(() => {
      answers += 1;
      return answers === 1
        ? [{ key: 'ratio', message: 'Which aspect ratio?', schema: ratioSchema }]
        : [{ key: 'duration', message: 'How many seconds?', schema: durationSchema }];
    });
    const first = await body(await handler.fetch(call({ model: 'image' })));
    const requestState = z.string().parse(first.requestState);
    const second = await body(
      await handler.fetch(
        call(
          { model: 'image' },
          {
            requestState,
            inputResponses: { ratio: { action: 'accept', content: { aspectRatio: '16:9' } } },
          },
        ),
      ),
    );
    expect(JSON.stringify(second)).toContain('changed between rounds');
  });

  /**
   * A resolver that breaks the rules is the tool AUTHOR's bug, so the caller
   * gets the framework's safe refusal and the operator gets the cause — the
   * line ADR 0042 draws. Both halves are asserted: an error that is only safe
   * is an error nobody can fix.
   */
  async function refusedBy(handler: ReturnType<typeof handlerFor>): Promise<{
    wire: string;
    logged: string;
  }> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      const response = await handler.fetch(call({ model: 'image' }));
      return { wire: JSON.stringify(await response.json()), logged: lines.join('\n') };
    } finally {
      console.error = original;
    }
  }

  test('a resolver returning more rounds than allowed is refused', async () => {
    const { wire, logged } = await refusedBy(
      handlerFor(
        () => [
          { key: 'a', message: 'a?', schema: ratioSchema },
          { key: 'b', message: 'b?', schema: ratioSchema },
        ],
        1,
      ),
    );
    expect(wire).toContain('INTERNAL_SERVER_ERROR');
    expect(wire).not.toContain('maxRounds');
    expect(logged).toContain('exceeding maxRounds');
  });

  test('a resolver returning a duplicate key is refused', async () => {
    const { wire, logged } = await refusedBy(
      handlerFor(() => [
        { key: 'same', message: 'first?', schema: ratioSchema },
        { key: 'same', message: 'second?', schema: ratioSchema },
      ]),
    );
    expect(wire).toContain('INTERNAL_SERVER_ERROR');
    expect(logged).toContain('duplicate input key');
  });
});
