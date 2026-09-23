import { describe, expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { defineErrors } from '../src/contract/errors-factory';
import { AppError, isRetryableStatus, STITCH_ERROR_STATUS } from '../src/entrypoints/contract';
import type { MethodDef } from '../src/server/types';
import { toolResultFromError } from '../src/tools/execute-result';
import { formatToolError } from '../src/tools/mount';

/*
 * A refusal decides the model's next move, and there is exactly one bit in it that matters:
 * wait and retry, fix the input, or stop. Until now the model read that off the CODE NAME —
 * guessing by spelling. A consumer's circuit breaker counted four identical unrecoverable
 * refusals before cutting the loop, and every one of those turns was paid for.
 */

/** The mounted tool's executor, narrowed once — the shape every agent test uses. */
function executable(tools: ToolSet, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`expected executable tool ${name}`);
  return execute;
}

const envelope = (err: unknown) => formatToolError(toolResultFromError(err));

describe('the tool refusal says whether repeating it could work', () => {
  test('a rate limit is retryable and a permission failure is not', async () => {
    expect(envelope(new AppError('RATE_LIMITED', 'slow down', 429)).retryable).toBe(true);
    expect(envelope(new AppError('FORBIDDEN', 'no', 403)).retryable).toBe(false);
  });

  test('a deterministic 500 is NOT retryable — the rule is not "any 5xx"', async () => {
    // `REALTIME_CONTRACT_VIOLATION`, `STREAM_ITEM_INVALID` and `FRAME_TOO_LARGE` all carry 500
    // and all fail the same way every time. Telling a model to retry them buys billed turns
    // and nothing else.
    expect(envelope(new AppError('REALTIME_CONTRACT_VIOLATION', 'x', 500)).retryable).toBe(
      false,
    );
    expect(envelope(new AppError('STREAM_ITEM_INVALID', 'x', 500)).retryable).toBe(false);
  });

  test('an application code is classified by its declared status, not by its name', async () => {
    // The naive rule — look the code up in STITCH_ERROR_STATUS — gets exactly this wrong:
    // an application's own 429 is not in that map and would be reported unrecoverable.
    const app = defineErrors({
      QUOTA_EXCEEDED: { status: 429, message: 'Monthly quota exhausted' },
    });
    expect(envelope(app.errors.QUOTA_EXCEEDED()).retryable).toBe(true);
  });

  test('a declaration overrides the status class in both directions', async () => {
    const app = defineErrors({
      PERMANENTLY_BUSY: { status: 503, message: 'never coming back', retryable: false },
      WORTH_ANOTHER_GO: { status: 409, message: 'racy', retryable: true },
    });
    expect(envelope(app.errors.PERMANENTLY_BUSY()).retryable).toBe(false);
    expect(envelope(app.errors.WORTH_ANOTHER_GO()).retryable).toBe(true);
  });

  test('a declaration survives the process hop that loses the AppError', async () => {
    // Across MCP or the CLI the normalized error is gone — only the serialized failure
    // crosses, and it is rebuilt from `{code, details, hint}` with the status resolved from
    // the code. A declaration that contradicts its status class is lost exactly there unless
    // it travels on the failure itself.
    // The declaration must DISAGREE with what the rebuild would infer, or the test passes for
    // the wrong reason: an unknown code rebuilds as 500, which is already `false`, so a
    // `retryable: false` declaration would look preserved while being lost. `409` + a declared
    // `true` is the pair where losing the declaration changes the answer.
    const app = defineErrors({
      WORTH_ANOTHER_GO: { status: 409, message: 'racy', retryable: true },
    });
    const failure = toolResultFromError(app.errors.WORTH_ANOTHER_GO());
    const crossed = JSON.parse(JSON.stringify(failure)) as typeof failure;
    expect(crossed.retryable).toBe(true);
    expect(formatToolError(crossed).retryable).toBe(true);
  });

  test('every framework code agrees with the status rule — no hand-kept list', async () => {
    // Written this way on purpose: an implementation that enumerated codes instead of
    // deriving from the status would pass a test that checked values one by one, and would
    // silently omit the next code added to the map.
    for (const [code, status] of Object.entries(STITCH_ERROR_STATUS)) {
      expect(envelope(new AppError(code, code, status)).retryable).toBe(
        isRetryableStatus(status),
      );
    }
  });
});

/*
 * The outcome of a call is known in one place and was reaching the agent surface only as text.
 * A consumer measured five places asking "did this call fail" and getting five different
 * answers: four successful calls recorded as failures (the word "error" appeared inside a tool
 * DESCRIPTION in search results) and thirteen real failures recorded as successes.
 */
describe('the outcome of an agent tool call is reported structurally', () => {
  const method: MethodDef<unknown, unknown, unknown> = {
    method: 'POST',
    path: '/',
    serviceName: 'journal',
    key: 'record',
    desc: 'Record one entry',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ seen: z.string() }),
    handler: (ctx) => ({ seen: (ctx.input as { id: string }).id }),
  };

  test('the provider call id reaches the hooks, so an outcome can be correlated', async () => {
    const { mountAgent } = await import('../src/tools/agent');
    const seen: Array<{ toolCallId: unknown; ok: boolean; code?: string }> = [];
    const tools = mountAgent(
      { name: 'journal', prefix: 'journal', scope: 'public', methods: { record: method } },
      {
        hooks: {
          afterToolCall: ({ context, result }) => {
            seen.push({
              toolCallId: context.toolCallId,
              ok: result.ok,
              ...(result.ok ? {} : { code: result.code }),
            });
          },
        },
      },
    );
    const execute = executable(tools, 'record_journal');

    await execute({ id: 'ok' }, { toolCallId: 'call-1', messages: [], context: undefined });
    await execute({ id: 7 }, { toolCallId: 'call-2', messages: [], context: undefined }).catch(
      () => undefined,
    );

    expect(seen).toEqual([
      { toolCallId: 'call-1', ok: true },
      { toolCallId: 'call-2', ok: false, code: 'VALIDATION_ERROR' },
    ]);
  });

  test('a consumer can brand-check the failure instead of parsing its message', async () => {
    const { isAgentToolError } = await import('../src/entrypoints/tools');
    const { mountAgent } = await import('../src/tools/agent');
    const tools = mountAgent({
      name: 'journal',
      prefix: 'journal',
      scope: 'public',
      methods: { record: method },
    });
    const execute = executable(tools, 'record_journal');
    const thrown = await execute(
      { id: 7 },
      { toolCallId: 'call-3', messages: [], context: undefined },
    )
      .then(() => undefined)
      .catch((err: unknown) => err);
    expect(isAgentToolError(thrown)).toBe(true);
  });
});
