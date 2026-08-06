/**
 * A consumer that opted into the optional peers and mounts the tool surface.
 *
 * This is where the observability work of 0.30–0.32 has to be proved from the
 * outside: the hook that carries the cause of a failed tool call, and the audit
 * row that names it. Both were reported by a consuming project rather than
 * caught here, because in-repo tests call the executor directly — they never go
 * through a real mount, from an installed package, with the peer present.
 */
import { defineContract } from 'stitchkit/contract';
import { createAuditHook, type RequestEvent } from 'stitchkit/observability';
import { implement } from 'stitchkit/server';
import {
  type ErrorHintFn,
  mountAgent,
  type ToolCallContext,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolResult,
} from 'stitchkit/tools';
import { z } from 'zod';

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

let failures = 0;
function check(what: string, ok: boolean, detail?: unknown): void {
  if (ok) return;
  failures += 1;
  console.error(`  ✗ ${what}`, detail === undefined ? '' : detail);
}

const widgets = defineContract(
  { prefix: 'widgets' },
  {
    update: {
      method: 'POST',
      path: '/:id',
      desc: 'Update a widget',
      params: z.object({ id: z.string() }),
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string() }),
      expose: ['AGENT'],
      toolName: 'update_widget',
    },
  },
);

const thrown = new Error('ECONNREFUSED 10.0.0.4:5432');

const service = implement(widgets, {
  update: (ctx) => {
    if (ctx.params.id === 'boom') throw thrown;
    return { id: ctx.params.id };
  },
});

// ── types a consumer is required to name ─────────────────────────────────────

const lifecycle: ToolLifecycle = { beforeHandle: () => undefined };
const errorHint: ErrorHintFn = () => null;

const seenByOnToolError: unknown[] = [];
const seenByAfterToolCall: Array<{
  result: ToolResult;
  error: unknown;
  context: ToolCallContext;
}> = [];
const events: RequestEvent[] = [];

const audit = createAuditHook({ write: (e: RequestEvent) => void events.push(e) });

const hooks: ToolCallHooks = {
  onToolError: (_toolName, error) => {
    seenByOnToolError.push(error);
  },
  afterToolCall: (toolName, args, result, durationMs, context, endpoint, error) => {
    seenByAfterToolCall.push({ result, error, context });
    // Chain the framework's own audit hook, exactly as a project would.
    void audit.toolCall.afterToolCall?.(
      toolName,
      args,
      result,
      durationMs,
      context,
      endpoint,
      error,
    );
  },
};

// ── through a real mount ─────────────────────────────────────────────────────

const tools = mountAgent(service, { hooks, lifecycle, errorHint });
const execute = tools.update_widget?.execute;
if (!execute) {
  console.error('  ✗ the mount produced no update_widget tool');
  process.exit(1);
}

// The framework logs an unexpected throw on stderr by design; keep the fixture's
// own output readable.
const originalError = console.error;
const suppressed: unknown[] = [];
console.error = (...args: unknown[]) => void suppressed.push(args[0]);
const failure: unknown = await execute(
  { id: 'boom', name: 'x' },
  { toolCallId: 't1', messages: [], context: undefined },
);
const success: unknown = await execute(
  { id: 'w1', name: 'x' },
  { toolCallId: 't2', messages: [], context: undefined },
);
console.error = originalError;

check(
  'the framework still reports the raw cause on stderr',
  suppressed.length === 1,
  suppressed,
);
check('a failing tool returns an envelope, not a throw', failure !== undefined);
check('a working tool still returns', success !== undefined);

check('onToolError fired once', seenByOnToolError.length === 1, seenByOnToolError.length);
check('it received the value as thrown', seenByOnToolError[0] === thrown);

check('afterToolCall ran for both calls', seenByAfterToolCall.length === 2);
check('the failed call carried the raw value', seenByAfterToolCall[0]?.error === thrown);
check('the successful call carried none', seenByAfterToolCall[1]?.error === undefined);
check(
  'the caller still gets the scrubbed envelope',
  JSON.stringify(seenByAfterToolCall[0]?.result).includes('INTERNAL_SERVER_ERROR'),
  seenByAfterToolCall[0]?.result,
);

// The audit hook is asynchronous by design — let its detached write land.
await new Promise((resolve) => setTimeout(resolve, 20));

const failedRow = events.find((e) => e.ok === false);
check('the audit row exists', failedRow !== undefined);
check(
  'and it names the cause instead of the placeholder',
  failedRow?.errorMessage === 'ECONNREFUSED 10.0.0.4:5432',
  failedRow?.errorMessage,
);
check(
  'while the code stays the contract-stable one',
  failedRow?.errorCode === 'INTERNAL_SERVER_ERROR',
);
check(
  'identity is on the row',
  failedRow?.serviceName === 'widgets' && failedRow?.action === 'update',
  {
    serviceName: failedRow?.serviceName,
    action: failedRow?.action,
  },
);

if (failures > 0) {
  console.error(`full consumer: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('full consumer: ok');
