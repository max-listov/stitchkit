import type { RuntimeContext, TransportSource } from '../contract';
import { formatZodError, normalizeError } from '../internal/errors';
import type { MethodDef } from '../server/types';

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; details?: unknown; hint?: string };

export interface ToolCallContext {
  source: TransportSource;
  [key: string]: unknown;
}

export interface ToolCallHooks {
  beforeToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ) => void | Promise<void>;
  afterToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    durationMs: number,
    context: ToolCallContext,
  ) => void | Promise<void>;
}

export async function executeToolMethod(
  method: MethodDef<unknown, unknown, unknown>,
  toolName: string,
  rawArgs: Record<string, unknown>,
  context: ToolCallContext,
  hooks?: ToolCallHooks,
): Promise<ToolResult> {
  const startedAt = Date.now();

  // Single exit — fire `afterToolCall` for every result (success and error).
  const finish = async (result: ToolResult): Promise<ToolResult> => {
    await hooks?.afterToolCall?.(toolName, rawArgs, result, Date.now() - startedAt, context);
    return result;
  };

  if (hooks?.beforeToolCall) {
    await hooks.beforeToolCall(toolName, rawArgs, context);
  }

  let params: unknown;
  if (method.paramsSchema) {
    const result = method.paramsSchema.safeParse(rawArgs);
    if (!result.success) {
      return finish({
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { message: `Invalid params: ${formatZodError(result.error)}` },
      });
    }
    params = result.data;
  }

  let input: unknown;
  if (method.inputSchema) {
    const result = method.inputSchema.safeParse(rawArgs);
    if (!result.success) {
      return finish({
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { message: `Invalid input: ${formatZodError(result.error)}` },
      });
    }
    input = result.data;
  }

  try {
    const ctx: RuntimeContext = { params, input, ...context };
    const data = await method.handler(ctx);
    const output = data === undefined || data === null ? { status: 'ok' } : data;
    return finish({ ok: true, data: output });
  } catch (err) {
    const appErr = normalizeError(err);
    // Протаскиваем message вызывающему, когда нет структурированных `details` —
    // клиент должен видеть причину, а не голый код. Логирование результата —
    // на стороне потребителя через `afterToolCall` hook.
    return finish({
      ok: false,
      code: appErr.code,
      details: appErr.details ?? { message: appErr.message },
      ...(appErr.hint && { hint: appErr.hint }),
    });
  }
}
