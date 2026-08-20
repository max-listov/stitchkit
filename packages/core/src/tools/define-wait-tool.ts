import type { ZodObject, ZodType, z } from 'zod';
import { AppError } from '../contract';
import { type ManagedNativeToolConfig, managedNativeIdentity } from './native-definition';
import {
  defineRuntimeTool,
  type RuntimeMcpPresentation,
  type RuntimeToolDefinitionWithOutput,
  type RuntimeToolHandlerContext,
  type RuntimeToolPresenters,
} from './runtime-tool';
import { runWaitOperation } from './wait-core';

export interface ManagedWaitRender {
  text: string;
  isError: boolean;
}

export interface DefineWaitToolConfig<TInput extends ZodObject, TState extends ZodType>
  extends ManagedNativeToolConfig {
  input: TInput;
  state: TState;
  poll: (
    input: z.output<TInput>,
    context: RuntimeToolHandlerContext<TInput>,
  ) => z.input<TState> | Promise<z.input<TState>>;
  done: (state: z.output<TState>) => boolean;
  timeoutFromInput?: (input: z.output<TInput>) => number | undefined;
  backoff?: number[];
  defaultTimeout?: number;
  /** Optional pure MCP renderer; `isError` also classifies terminal domain failure. */
  render?: (state: z.output<TState>, timedOut: boolean) => ManagedWaitRender;
  present?: RuntimeToolPresenters<z.output<TState>>;
}

/** Define one managed wait operation for `runtimeTools` and/or Agent tools. */
export function defineWaitTool<TInput extends ZodObject, TState extends ZodType>(
  config: DefineWaitToolConfig<TInput, TState>,
): RuntimeToolDefinitionWithOutput<TInput, TState> {
  const renderedMcp: RuntimeToolPresenters<z.output<TState>> | undefined = config.render
    ? {
        mcp: (state: z.output<TState>): RuntimeMcpPresentation => {
          const rendered = config.render?.(state, false);
          return {
            content: [
              {
                type: 'text',
                text: rendered?.text ?? JSON.stringify(state, null, 2),
              },
            ],
          };
        },
      }
    : undefined;
  const present: RuntimeToolPresenters<z.output<TState>> | undefined =
    renderedMcp || config.present ? { ...renderedMcp, ...config.present } : undefined;

  return defineRuntimeTool({
    name: config.name ?? 'wait',
    description: config.description,
    identity: managedNativeIdentity(config.identity, 'GET'),
    input: config.input,
    output: config.state,
    transports: config.transports,
    annotations: config.annotations,
    present,
    handler: async (context) => {
      const result = await runWaitOperation({
        input: context.input,
        poll: async (input) => config.state.parse(await config.poll(input, context)),
        done: config.done,
        backoff: config.backoff,
        timeoutSec: config.timeoutFromInput?.(context.input) ?? config.defaultTimeout,
        signal: context.signal,
      });
      const rendered = config.render?.(result.state, result.timedOut);
      if (result.timedOut) {
        throw new AppError(
          'WAIT_TIMEOUT',
          rendered?.text ?? 'Wait timed out before the operation completed',
          408,
        );
      }
      if (rendered?.isError) {
        throw new AppError('WAIT_FAILED', rendered.text, 409);
      }
      return result.state;
    },
  });
}
