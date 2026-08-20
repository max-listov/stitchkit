import type { ZodObject, z } from 'zod';
import { AppError } from '../contract';
import {
  DownloadOperationError,
  DownloadResultSchema,
  runDownloadOperation,
} from './download-core';
import { type ManagedNativeToolConfig, managedNativeIdentity } from './native-definition';
import {
  defineRuntimeTool,
  type RuntimeToolDefinitionWithOutput,
  type RuntimeToolHandlerContext,
  type RuntimeToolPresenters,
} from './runtime-tool';

export interface DefineDownloadToolConfig<TInput extends ZodObject>
  extends ManagedNativeToolConfig {
  input: TInput;
  resolveUrl: (
    input: z.output<TInput>,
    context: RuntimeToolHandlerContext<TInput>,
  ) => string | null | Promise<string | null>;
  defaultDir: string;
  dirFromInput?: (input: z.output<TInput>) => string | undefined;
  allowPrivateHosts?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  present?: RuntimeToolPresenters<z.output<typeof DownloadResultSchema>>;
}

/** Define one guarded managed download operation. */
export function defineDownloadTool<TInput extends ZodObject>(
  config: DefineDownloadToolConfig<TInput>,
): RuntimeToolDefinitionWithOutput<TInput, typeof DownloadResultSchema> {
  return defineRuntimeTool({
    name: config.name ?? 'download',
    description: config.description,
    identity: managedNativeIdentity(config.identity, 'POST'),
    input: config.input,
    output: DownloadResultSchema,
    transports: config.transports,
    annotations: config.annotations,
    present: config.present,
    handler: async (context) => {
      const url = await config.resolveUrl(context.input, context);
      if (!url) {
        throw new AppError('DOWNLOAD_NOT_FOUND', 'Nothing to download', 404);
      }
      try {
        return await runDownloadOperation({
          url,
          dir: config.dirFromInput?.(context.input) ?? config.defaultDir,
          allowPrivateHosts: config.allowPrivateHosts,
          maxBytes: config.maxBytes,
          timeoutMs: config.timeoutMs,
          signal: context.signal,
        });
      } catch (error) {
        if (error instanceof DownloadOperationError) {
          throw new AppError(error.code, `Download failed: ${error.message}`, error.status);
        }
        throw error;
      }
    },
  });
}
